package com.pulsepointlabs.sarah

import android.annotation.SuppressLint
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import com.capacitorjs.community.plugins.bluetoothle.Device
import com.capacitorjs.community.plugins.bluetoothle.CallbackResponse
import com.getcapacitor.*
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.Executors

@CapacitorPlugin(name="SarahCivet")
class SarahCivetPlugin : Plugin() {
    override fun load() { CivetCollector.init(context.applicationContext) }
    override fun handleOnResume() {
        super.handleOnResume()
        CivetCollector.restore(context.applicationContext)
        if(CivetCollector.enabled) runCatching { SarahCaptureService.start(context) }
    }
    @PluginMethod fun status(call: PluginCall) { call.resolve(CivetCollector.status(call.getLong("after") ?: 0L)) }
    @PluginMethod fun configure(call: PluginCall) {
        try {CivetCollector.configure(call.getString("endpoint").orEmpty());call.resolve()}
        catch(e: Exception){call.reject(e.message)}
    }
    @PluginMethod fun connect(call: PluginCall) { CivetCollector.connect(call.getString("deviceId").orEmpty()) { result ->
        if(result.success) call.resolve(CivetCollector.status(0)) else call.reject(result.value)
    } }
    @PluginMethod fun disconnect(call: PluginCall) { CivetCollector.stop();call.resolve() }
    @PluginMethod fun calibrate(call: PluginCall) {
        val kind=call.getString("kind").orEmpty()
        val prepare=call.getDouble("prepare_s") ?: 0.0
        if(kind !in listOf("baseline","reference")||prepare<0||prepare>10){call.reject("Invalid calibration request");return}
        CivetCollector.event("calibration_requested",kind,prepare) {error->if(error==null)call.resolve() else call.reject(error)}
    }
    @PluginMethod fun zero(call: PluginCall) {
        if(call.getBoolean("deflated")!=true) {call.reject("Confirm the sensor is deflated and outside the body.");return}
        CivetCollector.zero { result ->
            if(result.success)CivetCollector.event("hardware_zero","",0.0) {error->if(error==null)call.resolve()else call.reject(error)}
            else call.reject(result.value)
        }
    }
}

/** Owns BLE and durable raw acquisition while the WebView is paused or offline. */
@SuppressLint("MissingPermission")
object CivetCollector {
    private val handler=Handler(Looper.getMainLooper())
    private val journal=Executors.newSingleThreadExecutor()
    private val mirrorIo=Executors.newSingleThreadScheduledExecutor()
    private lateinit var app: Context
    private var initialized=false
    @Volatile var enabled=false; private set
    private var device: Device?=null
    @Volatile private var address=""
    private var connecting=false
    private var generation=0
    private var connectionId=""
    private var captureId=UUID.randomUUID().toString()
    private var sequence=0L
    @Volatile private var lastPacket=0L
    @Volatile private var connectedAt=0L
    @Volatile private var state="disconnected"
    @Volatile private var error=""
    @Volatile private var storageError=""
    @Volatile private var endpoint=""
    @Volatile private var mirrorError=""
    private val ring=java.util.ArrayDeque<JSONObject>()
    private val commandUuid=UUID.fromString("0000150a-0000-1000-8000-00805f9b34fb")
    private val pressureUuid=UUID.fromString("0000150b-0000-1000-8000-00805f9b34fb")
    @Synchronized fun init(context: Context) {
        if(initialized)return
        app=context.applicationContext;TelemetryJournal.init(app);initialized=true
        endpoint=app.getSharedPreferences("civet_collector",0).getString("endpoint","").orEmpty()
        mirrorIo.scheduleWithFixedDelay({runCatching {mirror()}},1,1,java.util.concurrent.TimeUnit.SECONDS)
        handler.post(object: Runnable {override fun run() {
            if(enabled&&!connecting&&(device?.isConnected()!=true || SystemClock.elapsedRealtime()-maxOf(lastPacket,connectedAt)>7000)) open(null)
            handler.postDelayed(this,3000)
        }})
    }
    fun configure(value: String) {
        val uri=java.net.URI(value)
        require(uri.scheme in listOf("http","https")&&!uri.host.isNullOrBlank()) {"Invalid server copy address"}
        endpoint=value;app.getSharedPreferences("civet_collector",0).edit().putString("endpoint",value).apply()
    }
    private fun mirror() {
        if(endpoint.isBlank())return
        val prefs=app.getSharedPreferences("civet_collector",0)
        val rows=TelemetryJournal.batch("civet",prefs.getLong("mirror_cursor",0))
        if(rows.length()==0)return
        var connection: java.net.HttpURLConnection?=null
        try {
            connection=java.net.URL(endpoint).openConnection() as java.net.HttpURLConnection
            connection.requestMethod="POST";connection.connectTimeout=5000;connection.readTimeout=5000
            connection.doOutput=true;connection.instanceFollowRedirects=false;connection.setRequestProperty("Content-Type","application/json")
            connection.outputStream.use {it.write(JSONObject().put("packets",rows).toString().toByteArray(Charsets.UTF_8))}
            check(connection.responseCode in 200..299){"Server copy pending (HTTP ${connection.responseCode})"}
            val response=connection.inputStream.bufferedReader().use {JSONObject(it.readText())}
            val ids=response.optJSONArray("acknowledged")?:JSONArray()
            val saved=(0 until ids.length()).map {ids.getString(it)}.toSet()
            check(response.optBoolean("ok")&&(0 until rows.length()).all {rows.getJSONObject(it).getString("id") in saved}) {"Server did not confirm the pressure copies"}
            check(prefs.edit().putLong("mirror_cursor",rows.getJSONObject(rows.length()-1).getLong("rowId")).commit()) {"Cannot save sync progress"}
            mirrorError=""
        } catch(e: Exception) {mirrorError=e.message?:"Server copy pending"}
        finally {connection?.disconnect()}
    }
    fun restore(context: Context) {
        init(context)
        if(enabled)return
        val prefs=app.getSharedPreferences("civet_collector",0)
        if(!prefs.getBoolean("enabled",false))return
        address=prefs.getString("address","").orEmpty();enabled=address.isNotBlank()
        if(enabled)handler.post {open(null)}
    }
    fun connect(id: String, callback: (CallbackResponse)->Unit) {handler.post {
        if(!android.bluetooth.BluetoothAdapter.checkBluetoothAddress(id)) {callback(CallbackResponse(false,"Choose a CIVET sensor first."));return@post}
        address=id;enabled=true
        try {SarahCaptureService.start(app)} catch(e: RuntimeException) {enabled=false;callback(CallbackResponse(false,"Bring Sarah to the foreground and try again."));return@post}
        app.getSharedPreferences("civet_collector",0).edit().putString("address",id).putBoolean("enabled",true).apply()
        open(callback)
    }}
    private fun open(callback: ((CallbackResponse)->Unit)?) {
        if(connecting)return
        val token=++generation
        connecting=true;state="connecting";error="";lastPacket=0
        val previous=device;device=null
        fun begin() {handler.post {
            if(!enabled||token!=generation) {connecting=false;return@post}
            try {
                val adapter=(app.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter
                val current=Device(app,adapter,address) {handler.post {if(token==generation){state="reconnecting";lastPacket=0}}}
                device=current
                current.connect(15000,false) { result -> handler.post {
                    if(token!=generation)return@post
                    if(!result.success){fail(result.value,callback);return@post}
                    connectionId=UUID.randomUUID().toString();connectedAt=SystemClock.elapsedRealtime()
                    val service=current.getServices().find {it.getCharacteristic(pressureUuid)!=null && it.getCharacteristic(commandUuid)!=null}
                    if(service==null){fail("Connected device has no CIVET pressure service.",callback);return@post}
                    current.setNotifications(service.uuid,pressureUuid,true,{ response ->
                        val wall=System.currentTimeMillis();val mono=SystemClock.elapsedRealtime()
                        handler.post {if(token==generation&&response.success)packet(response.value,wall,mono)}
                    },12000) { subscribed -> handler.post {
                        if(token!=generation)return@post
                        if(!subscribed.success){fail(subscribed.value,callback);return@post}
                        val characteristic=service.getCharacteristic(commandUuid)
                        val type=if(characteristic.properties and BluetoothGattCharacteristic.PROPERTY_WRITE!=0) BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT else BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
                        current.write(service.uuid,commandUuid,"5001d0"+"00".repeat(14),type,12000) { started -> handler.post {
                            if(token!=generation)return@post
                            connecting=false
                            if(started.success){state=if(lastPacket>0)"streaming" else "waiting_for_samples";callback?.invoke(started)} else fail(started.value,callback)
                        }}
                    }}
                }}
            } catch(e: Exception) {fail(e.message?:"Bluetooth unavailable",callback)}
        }}
        if(previous!=null)previous.disconnect(3000){begin()} else begin()
    }
    private fun fail(message: String, callback: ((CallbackResponse)->Unit)?) {
        connecting=false;state="reconnecting";error=message;device?.disconnect(3000){};device=null;callback?.invoke(CallbackResponse(false,message))
    }
    private fun packet(hex: String, wall: Long, mono: Long) {
        val raw=CivetPacket.decode(hex)
        if(raw==null){error="Unrecognized CIVET packet; pressure is unavailable.";return}
        lastPacket=mono;state="streaming";error=""
        val row=JSONObject().put("pressure_kpa",raw/100.0).put("timestamp_ms",wall).put("monotonic_ms",mono)
            .put("sequence",++sequence).put("connection_id",connectionId).put("capture_id",captureId)
            .put("raw_pressure_integer",raw).put("raw_packet_hex",hex)
        journal.execute {
            try {
                TelemetryJournal.append("civet","$captureId-${row.getLong("sequence")}",wall,row)
                synchronized(ring){ring.add(row);while(ring.size>1200)ring.removeFirst()};storageError=""
            } catch(e: Exception) {storageError="Pressure received but local save failed: ${e.message}"}
        }
    }
    fun event(type: String, kind: String, prepare: Double, callback: (String?)->Unit) {handler.post {
        if(lastPacket==0L||SystemClock.elapsedRealtime()-lastPacket>1500){callback("Wait for live pressure samples.");return@post}
        val wall=System.currentTimeMillis()
        val row=JSONObject().put("type",type).put("kind",kind).put("prepare_s",prepare).put("timestamp_ms",wall)
            .put("monotonic_ms",SystemClock.elapsedRealtime()).put("sequence",++sequence).put("connection_id",connectionId).put("capture_id",captureId)
        journal.execute {
            try {TelemetryJournal.append("civet","$captureId-${row.getLong("sequence")}",wall,row);synchronized(ring){ring.add(row);while(ring.size>1200)ring.removeFirst()};callback(null)}
            catch(e: Exception){callback("Cannot save calibration event: ${e.message}")}
        }
    }}
    fun status(after: Long): JSObject {
        val fresh=lastPacket>0&&SystemClock.elapsedRealtime()-lastPacket<1500
        val samples=JSONArray();synchronized(ring){ring.filter {it.getLong("sequence")>after}.forEach {samples.put(it)}}
        return JSObject().put("enabled",enabled).put("connected",device?.isConnected()==true).put("state",if(fresh)"streaming" else state.takeUnless {it=="streaming"}?:"stale")
            .put("samples",samples).put("address",address).put("capture_id",captureId).put("age_ms",if(lastPacket>0)SystemClock.elapsedRealtime()-lastPacket else null)
            .put("error",storageError.ifBlank {error}).put("mirrorError",mirrorError).put("localSaved",storageError.isBlank()&&synchronized(ring){ring.isNotEmpty()})
    }
    fun zero(callback: (CallbackResponse)->Unit) {handler.post {
        val current=device;val service=current?.getServices()?.find {it.getCharacteristic(commandUuid)!=null}
        if(current==null||service==null||lastPacket==0L){callback(CallbackResponse(false,"Wait for live pressure before zeroing."));return@post}
        val char=service.getCharacteristic(commandUuid)
        current.write(service.uuid,commandUuid,"66000000000000000000000002",if(char.properties and BluetoothGattCharacteristic.PROPERTY_WRITE!=0)BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT else BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE,5000,callback)
    }}
    fun stop() {handler.post {
        enabled=false;generation++;connecting=false;state="disconnected";lastPacket=0
        app.getSharedPreferences("civet_collector",0).edit().putBoolean("enabled",false).apply()
        device?.disconnect(3000){};device=null;SarahCaptureService.stop(app)
    }}
}
