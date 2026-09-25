package com.pulsepointlabs.sarah

import android.annotation.SuppressLint
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothManager
import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.os.Handler
import android.os.Looper
import com.capacitorjs.community.plugins.bluetoothle.Device
import com.capacitorjs.community.plugins.bluetoothle.CallbackResponse
import com.getcapacitor.*
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** The screen is only a viewer. BLE, reconnect and durable delivery belong to the service. */
@CapacitorPlugin(name = "SarahH10")
class SarahH10Plugin : Plugin() {
    @Volatile private var foreground = true
    override fun load() {
        H10Collector.init(context.applicationContext)
        H10Collector.emit = { event -> if (foreground) notifyListeners("packet", JSObject(event.toString())) }
    }
    override fun handleOnPause() { foreground = false }
    override fun handleOnResume() { foreground = true }
    override fun handleOnDestroy() { foreground = false }
    @PluginMethod fun configure(call: PluginCall) {
        try {
            H10Collector.configure(call.getString("endpoint")!!, call.getString("collectorId")!!, call.getString("deviceName") ?: "Polar H10")
            call.resolve()
        } catch (e: Exception) { call.reject(e.message) }
    }
    @PluginMethod fun connect(call: PluginCall) {
        H10Collector.connect(call.getString("deviceId") ?: "") { result -> finish(call, result) }
    }
    @PluginMethod fun disconnect(call: PluginCall) { H10Collector.stop(); call.resolve() }
    @PluginMethod fun status(call: PluginCall) { call.resolve(JSObject(H10Collector.status().toString())) }
    @PluginMethod fun notifications(call: PluginCall) {
        H10Collector.subscribe(call.getString("service")!!, call.getString("characteristic")!!, call.getBoolean("enabled") ?: true) { finish(call, it) }
    }
    @PluginMethod fun write(call: PluginCall) {
        H10Collector.write(call.getString("value") ?: "", call.getLong("timeout") ?: 12000L) { finish(call, it) }
    }
    private fun finish(call: PluginCall, result: CallbackResponse) {
        if (result.success) call.resolve() else call.reject(result.value)
    }
}

@SuppressLint("MissingPermission")
object H10Collector {
    private const val HR_SERVICE = "0000180d-0000-1000-8000-00805f9b34fb"
    private const val HR = "00002a37-0000-1000-8000-00805f9b34fb"
    private const val PMD_SERVICE = "fb005c80-02e7-f387-1cad-8acd2d8df0c8"
    private const val CONTROL = "fb005c81-02e7-f387-1cad-8acd2d8df0c8"
    private const val DATA = "fb005c82-02e7-f387-1cad-8acd2d8df0c8"
    private val handler = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadScheduledExecutor()
    private val liveIo = Executors.newSingleThreadScheduledExecutor()
    private val journal = Executors.newSingleThreadExecutor()
    private lateinit var app: Context
    private lateinit var db: SQLiteDatabase
    private var initialized = false
    private var device: Device? = null
    private var address = ""
    @Volatile private var endpoint = ""
    private var collectorId = ""
    private var deviceName = "Polar H10"
    @Volatile var enabled = false
        private set
    @Volatile private var lastPacket = 0L
    @Volatile private var deliveryError = ""
    @Volatile private var liveDeliveryError = ""
    @Volatile private var signalWarning = ""
    private data class PendingDelivery(val id: Long, val url: String, val body: String, val receivedAt: Long)
    @Volatile private var latestDelivery: PendingDelivery? = null
    @Volatile private var lastDeliveredAt = 0L
    private var connecting = false
    private var generation = 0
    private var connectionId = ""
    private val subscriptions = linkedSetOf<Pair<String, String>>()
    private var frames = JSONArray()
    var emit: ((JSONObject) -> Unit)? = null

    @Synchronized fun init(context: Context) {
        if (initialized) return
        app = context.applicationContext
        db = app.openOrCreateDatabase("h10_delivery.db", Context.MODE_PRIVATE, null)
        db.execSQL("CREATE TABLE IF NOT EXISTS packets (id INTEGER PRIMARY KEY AUTOINCREMENT, endpoint TEXT NOT NULL, body TEXT NOT NULL)")
        initialized = true
        io.scheduleWithFixedDelay({ flush() }, 0, 1, TimeUnit.SECONDS)
        // One replaceable live candidate, never an unbounded second queue. The
        // SQLite FIFO still retains every reading until a durable acknowledgement.
        liveIo.scheduleWithFixedDelay({ flushLive() }, 0, 200, TimeUnit.MILLISECONDS)
        handler.post(object : Runnable {
            override fun run() {
                if (enabled && !connecting && (device?.isConnected() != true || System.currentTimeMillis() - lastPacket > 7000)) reconnect()
                handler.postDelayed(this, 3000)
            }
        })
    }

    fun configure(url: String, id: String, name: String) {
        require(URL(url).protocol in listOf("http", "https")) { "Invalid Sarah API address" }
        endpoint = url; collectorId = id; deviceName = name
        app.getSharedPreferences("h10_collector", 0).edit().putString("endpoint", url)
            .putString("collectorId", id).putString("deviceName", name).apply()
    }

    fun connect(id: String, callback: (CallbackResponse) -> Unit) = handler.post {
        if (enabled && address == id && device?.isConnected() == true) { callback(CallbackResponse(true, "")); return@post }
        if (endpoint.isBlank() || collectorId.isBlank()) { callback(CallbackResponse(false, "Configure the Sarah collector first")); return@post }
        address = id
        enabled = true
        app.getSharedPreferences("h10_collector", 0).edit().putString("address", id).putString("endpoint", endpoint)
            .putString("collectorId", collectorId).putString("deviceName", deviceName).putBoolean("enabled", true).apply()
        SarahCaptureService.start(app)
        open(callback)
    }

    /** Called by START_STICKY after Android recreates the process. */
    fun restore(context: Context) {
        init(context)
        if (enabled) return
        val p = app.getSharedPreferences("h10_collector", 0)
        if (!p.getBoolean("enabled", false)) return
        configure(p.getString("endpoint", "")!!, p.getString("collectorId", "")!!, p.getString("deviceName", "Polar H10")!!)
        address = p.getString("address", "")!!
        enabled = true
        reconnect()
    }

    private fun open(callback: (CallbackResponse) -> Unit) {
        val token = ++generation
        connecting = true
        connectionId = UUID.randomUUID().toString()
        frames = JSONArray()
        val adapter = (app.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter
        try {
            device = Device(app, adapter, address) {
                handler.post { if (token == generation) { connecting = false; lastPacket = 0 } }
            }
            device!!.connect(15000, false) { result -> handler.post {
                if (token != generation) return@post
                connecting = false
                lastPacket = System.currentTimeMillis()
                callback(result)
            } }
        } catch (e: Exception) { connecting = false; callback(CallbackResponse(false, e.message ?: "Bluetooth unavailable")) }
    }

    private fun reconnect() {
        if (!enabled || connecting) return
        val old = device
        generation++
        device = null
        connecting = true
        fun resume() { handler.post {
            if (!enabled) { connecting = false; return@post }
            open { result -> if (result.success) restoreStreams() else deliveryError = result.value }
        } }
        if (old != null) old.disconnect(3000) { resume() } else resume()
    }

    private fun restoreStreams() {
        // HR first: a PMD failure must never take down HR/RR capture.
        subscribe(HR_SERVICE, HR, true) { hrResult ->
            if (!hrResult.success) { lastPacket = 0; return@subscribe }
            subscribe(PMD_SERVICE, DATA, true) { dataResult ->
                if (dataResult.success) subscribe(PMD_SERVICE, CONTROL, true) { controlResult ->
                    if (controlResult.success) {
                        val commands = listOf("03 00", "03 02", "02 02 00 01 19 00 01 01 10 00 02 01 02 00", "02 00 00 01 82 00 01 01 0e 00")
                        fun next(index: Int) {
                            if (index >= commands.size || !enabled) return
                            write(commands[index].replace(" ", ""), 5000) { handler.postDelayed({ next(index + 1) }, 350) }
                        }
                        next(0)
                    }
                }
            }
        }
    }

    fun subscribe(service: String, characteristic: String, enabled: Boolean, callback: (CallbackResponse) -> Unit) = handler.post {
        val current = device
        if (current == null) { callback(CallbackResponse(false, "H10 disconnected")); return@post }
        val token = generation
        current.setNotifications(UUID.fromString(service), UUID.fromString(characteristic), enabled, { response ->
            val receivedAt = System.currentTimeMillis()
            handler.post { if (token == generation && response.success) packet(characteristic, response.value, receivedAt) }
        }, 12000) { result -> handler.post {
            if (result.success) { if (enabled) subscriptions.add(service to characteristic) else subscriptions.remove(service to characteristic) }
            callback(result)
        } }
    }

    fun write(value: String, timeout: Long, callback: (CallbackResponse) -> Unit) = handler.post {
        val current = device
        if (current == null) callback(CallbackResponse(false, "H10 disconnected"))
        else current.write(UUID.fromString(PMD_SERVICE), UUID.fromString(CONTROL), value, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT, timeout, callback)
    }

    private fun packet(characteristic: String, value: String, receivedAt: Long) {
        val event = JSONObject().put("characteristic", characteristic).put("value", value).put("receivedAt", receivedAt)
        if (characteristic == DATA) frames.put(event)
        if (characteristic == HR) {
            lastPacket = receivedAt
            val payload = JSONObject().put("nativeH10", true).put("packetId", UUID.randomUUID().toString())
                .put("connectionId", connectionId).put("collectorId", collectorId).put("collectorKind", "Sarah Android APK")
                .put("deviceName", deviceName).put("measuredAt", receivedAt).put("heartRatePacket", value).put("pmdFrames", frames)
            frames = JSONArray()
            val url = endpoint
            journal.execute {
                try {
                    val row = ContentValues().apply { put("endpoint", url); put("body", payload.toString()) }
                    val rowId = db.insertOrThrow("packets", null, row)
                    latestDelivery = PendingDelivery(rowId, url, payload.toString(), receivedAt)
                } catch (e: Exception) { deliveryError = "Cannot save H10 queue: ${e.message}" }
            }
        }
        emit?.invoke(event)
    }

    private fun flush() {
        try {
            // FIFO, one in flight, delete only after the server has durably acknowledged it.
            repeat(120) {
                var id = 0L; var url = ""; var body = ""
                db.rawQuery("SELECT id, endpoint, body FROM packets ORDER BY id LIMIT 1", null).use { c ->
                    if (!c.moveToFirst()) return
                    id = c.getLong(0); url = c.getString(1); body = c.getString(2)
                }
                deliver(PendingDelivery(id, url, body, 0))
                deliveryError = ""
            }
        } catch (e: Exception) { deliveryError = "H10 buffered on phone: ${e.message}" }
    }

    private fun flushLive() {
        val pending = latestDelivery ?: return
        if (System.currentTimeMillis() - pending.receivedAt > 5000 || pending.receivedAt <= lastDeliveredAt) return
        try {
            deliver(pending)
            lastDeliveredAt = pending.receivedAt
            liveDeliveryError = ""
        } catch (e: Exception) { liveDeliveryError = "Live H10 upload: ${e.message}" }
    }

    private fun deliver(pending: PendingDelivery) {
        // Reuse the API address verified by the foreground app, including for
        // previously buffered packets whose original network address went stale.
        val connection = URL(endpoint.ifBlank { pending.url }).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "POST"; connection.connectTimeout = 5000; connection.readTimeout = 5000
            connection.doOutput = true; connection.setRequestProperty("Content-Type", "application/json")
            connection.outputStream.use { it.write(pending.body.toByteArray(Charsets.UTF_8)) }
            val code = connection.responseCode
            if (code !in 200..299) {
                val message = try {
                    connection.errorStream?.bufferedReader()?.use { JSONObject(it.readText()).optString("error") }
                } catch (_: Exception) { null }
                throw IllegalStateException("HTTP $code${if (message.isNullOrBlank()) "" else ": ${message.take(240)}"}")
            }
            val response = connection.inputStream.bufferedReader().use { JSONObject(it.readText()) }
            check(response.optBoolean("nativeAcknowledged")) { "Sarah desktop needs the background-capture update" }
            if (pending.receivedAt > 0 && System.currentTimeMillis() - pending.receivedAt <= 5000) {
                signalWarning = if (response.optBoolean("usable", true)) "" else response.optString("warning", "Check H10 strap contact.")
            }
            db.delete("packets", "id=?", arrayOf(pending.id.toString()))
        } finally { connection.disconnect() }
    }

    fun status(): JSONObject {
        var pending = 0
        if (initialized) db.rawQuery("SELECT count(*) FROM packets", null).use { if (it.moveToFirst()) pending = it.getInt(0) }
        return JSONObject().put("enabled", enabled).put("connected", device?.isConnected() == true)
            .put("deviceId", address).put("deviceName", deviceName)
            .put("lastPacketAt", lastPacket).put("pending", pending).put("lastDeliveredAt", lastDeliveredAt)
            .put("error", liveDeliveryError.ifBlank { signalWarning.ifBlank { deliveryError } })
    }

    fun stop() = handler.post {
        enabled = false; generation++; connecting = false
        if (initialized) app.getSharedPreferences("h10_collector", 0).edit().putBoolean("enabled", false).apply()
        device?.disconnect(3000) { }; device = null; subscriptions.clear()
        // Already received packets stay queued until acknowledged, including after a disconnect.
    }
}
