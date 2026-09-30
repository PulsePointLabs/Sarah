package com.pulsepointlabs.sarah

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import org.json.JSONArray
import java.util.UUID
import kotlin.math.pow
import kotlin.math.roundToInt

/** Service-owned cuff acquisition and durable delivery, independent of the WebView. */
object OmronCollector {
    private val handler = Handler(Looper.getMainLooper())
    private val adapter: BluetoothAdapter?
        get() = (context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter
    private val prefs by lazy { context.getSharedPreferences(PREFS, Context.MODE_PRIVATE) }
    private var gatt: BluetoothGatt? = null
    @Volatile var armed = false
        private set
    private var scanning = false
    private var subscribed = false
    private var targetAddress: String? = null
    private var targetName: String = "OMRON BP7000"

    private lateinit var context: Context
    @Volatile var emit: ((String, JSObject) -> Unit)? = null
    @Volatile private var endpoint = ""
    @Volatile private var deliveryError = ""
    private var initialized = false
    private val uploader = java.util.concurrent.Executors.newSingleThreadScheduledExecutor()

    @Synchronized fun init(ctx: Context) {
        if (initialized) return
        context = ctx.applicationContext
        endpoint = prefs.getString("endpoint", "").orEmpty()
        initialized = true
        uploader.scheduleWithFixedDelay({ runCatching { flushPending() } }, 1, 3, java.util.concurrent.TimeUnit.SECONDS)
    }

    fun restore(ctx: Context) {
        init(ctx)
        if (!armed && prefs.getBoolean("armed", false)) {
            targetAddress = prefs.getString(KEY_ADDRESS, null)
            targetName = prefs.getString(KEY_NAME, "OMRON BP7000").orEmpty()
            armed = !targetAddress.isNullOrBlank()
            startScan()
        }
    }

    fun arm(address: String?, name: String?, deliveryEndpoint: String): JSObject {
        check(hasBluetoothPermission()) { "Bluetooth permission is required before Sarah can listen for the OMRON cuff." }
        val url = java.net.URI(deliveryEndpoint)
        require(url.scheme in listOf("https", "http") && !url.host.isNullOrBlank()) { "A valid Sarah server address is required." }
        targetAddress = address?.trim()?.takeIf { it.isNotBlank() } ?: prefs.getString(KEY_ADDRESS, null)
        require(!targetAddress.isNullOrBlank()) { "Select the OMRON cuff once before enabling automatic listening." }
        targetName = name?.trim()?.takeIf { it.isNotBlank() } ?: prefs.getString(KEY_NAME, "OMRON BP7000").orEmpty()
        endpoint = deliveryEndpoint
        prefs.edit().putString(KEY_ADDRESS, targetAddress).putString(KEY_NAME, targetName)
            .putString("endpoint", endpoint).putBoolean("armed", true).commit()
        armed = true
        try { SarahCaptureService.start(context) }
        catch (error: Exception) {
            armed = false
            prefs.edit().putBoolean("armed", false).commit()
            throw error
        }
        closeGatt()
        stopScan()
        startScan()
        return state()
    }

    fun disarm(): JSObject {
        armed = false
        prefs.edit().putBoolean("armed", false).commit()
        stopScan()
        closeGatt()
        SarahCaptureService.stop(context)
        return state()
    }

    fun state() = stateObject(if (!armed) "stopped" else if (subscribed) "waiting_for_reading" else "waiting_for_cuff")

    @Synchronized fun acknowledge(expectedId: String) {
        if (expectedId.isBlank()) return
        val retained = JSONArray()
        val queue = pendingReadings()
        var delivered: String? = null
        for (index in 0 until queue.length()) {
            val item = queue.getJSONObject(index)
            if (item.optString("external_id") != expectedId) retained.put(item)
            else delivered = item.toString()
        }
        val editor = prefs.edit().putString(KEY_PENDING_QUEUE, retained.toString()).remove(KEY_PENDING_READING)
        if (delivered != null) editor.putString("last_delivered_reading", delivered)
        editor.commit()
    }

    // The foreground service owns transport; a paused/destroyed WebView is only a view.
    private fun notifyListeners(event: String, value: JSObject) { emit?.invoke(event, value) }

    private fun flushPending() {
        val destination = endpoint
        if (destination.isBlank()) return
        val queue = synchronized(this) { pendingReadings() }
        for (index in 0 until queue.length()) {
            val reading = queue.getJSONObject(index)
            val id = reading.optString("external_id")
            if (id.isBlank() || runCatching { java.time.Instant.parse(reading.optString("measured_at")) }.isFailure) continue
            val connection = java.net.URL(destination).openConnection() as java.net.HttpURLConnection
            try {
                connection.requestMethod = "POST"
                connection.connectTimeout = 5000
                connection.readTimeout = 5000
                connection.instanceFollowRedirects = false
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(JSObject().put("reading", reading).toString().toByteArray(Charsets.UTF_8)) }
                check(connection.responseCode in 200..299) { "Sarah server returned HTTP ${connection.responseCode}" }
                val response = org.json.JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
                val saved = response.optJSONArray("readings") ?: JSONArray()
                check(response.optBoolean("ok") && (0 until saved.length()).any { saved.getJSONObject(it).optString("external_id") == id }) {
                    "Sarah server did not confirm this cuff reading was saved"
                }
                acknowledge(id)
                deliveryError = ""
            } catch (error: Exception) {
                deliveryError = "BP saved on phone; server delivery pending: ${error.message}"
                return
            } finally { connection.disconnect() }
        }
    }

    @SuppressLint("MissingPermission")
    private fun startScan() {
        if (!armed || scanning || !hasBluetoothPermission()) return
        val scanner = adapter?.bluetoothLeScanner ?: run {
            emitError("Bluetooth scanner is unavailable.")
            handler.postDelayed({ startScan() }, 5000)
            return
        }
        scanning = true
        notifyListeners("status", stateObject("scanning").put("message", "Waiting for the saved OMRON cuff to wake..."))
        val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
        val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(BP_SERVICE)).build()
        try { scanner.startScan(listOf(filter), settings, scanCallback) }
        catch (error: Exception) {
            scanning = false
            emitError(error.message ?: "OMRON scan could not start.")
            handler.postDelayed({ startScan() }, 5000)
            return
        }
        handler.removeCallbacks(restartScanRunnable)
        handler.postDelayed(restartScanRunnable, SCAN_WINDOW_MS)
    }

    private val restartScanRunnable = Runnable {
        if (!armed || subscribed) return@Runnable
        stopScan()
        handler.postDelayed({ startScan() }, SCAN_RESTART_DELAY_MS)
    }

    @SuppressLint("MissingPermission")
    private fun stopScan() {
        handler.removeCallbacks(restartScanRunnable)
        if (!scanning) return
        runCatching { adapter?.bluetoothLeScanner?.stopScan(scanCallback) }
        scanning = false
    }

    private fun retryConnection(message: String) {
        emitError(message)
        closeGatt()
        if (armed) handler.postDelayed({ startScan() }, SCAN_RESTART_DELAY_MS)
    }

    private val scanCallback = object : ScanCallback() {
        @SuppressLint("MissingPermission")
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            if (!armed || !scanning || gatt != null) return
            val device = result.device ?: return
            if (!device.address.equals(targetAddress, ignoreCase = true)) return
            stopScan()
            connect(device)
        }

        override fun onScanFailed(errorCode: Int) {
            scanning = false
            if (!armed) return
            notifyListeners("status", stateObject("waiting_for_cuff").put("message", "OMRON scan paused; retrying shortly."))
            handler.postDelayed({ startScan() }, SCAN_RESTART_DELAY_MS)
        }
    }

    @SuppressLint("MissingPermission")
    private fun connect(device: BluetoothDevice) {
        if (!armed) return
        subscribed = false
        notifyListeners("status", stateObject("connecting").put("message", "OMRON cuff found. Connecting..."))
        closeGatt()
        gatt = if (Build.VERSION.SDK_INT >= 26) {
            device.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE, BluetoothDevice.PHY_LE_1M_MASK, handler)
        } else device.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
        val attempt = gatt
        handler.postDelayed({ if (armed && gatt === attempt && !subscribed) retryConnection("OMRON connection timed out; retrying.") }, 20_000)
    }

    private val gattCallback = object : BluetoothGattCallback() {
        @SuppressLint("MissingPermission")
        override fun onConnectionStateChange(connection: BluetoothGatt, status: Int, newState: Int) {
            if (gatt !== connection || !armed) { runCatching { connection.close() }; return }
            if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                notifyListeners("status", stateObject("connected").put("message", "OMRON connected. Waiting for a new reading..."))
                connection.discoverServices()
                return
            }
            subscribed = false
            runCatching { connection.close() }
            if (gatt === connection) gatt = null
            if (armed) {
                notifyListeners("status", stateObject("waiting_for_cuff").put("message", "OMRON is armed and waiting for the cuff to wake."))
                handler.postDelayed({ startScan() }, SCAN_RESTART_DELAY_MS)
            }
        }

        @SuppressLint("MissingPermission")
        override fun onServicesDiscovered(connection: BluetoothGatt, status: Int) {
            if (gatt !== connection || !armed) return
            val characteristic = connection.getService(BP_SERVICE)?.getCharacteristic(BP_MEASUREMENT)
            if (status != BluetoothGatt.GATT_SUCCESS || characteristic == null) {
                emitError("The saved cuff did not expose the Bluetooth blood-pressure measurement service.")
                closeGatt()
                if (armed) startScan()
                return
            }
            if (!connection.setCharacteristicNotification(characteristic, true)) { retryConnection("OMRON notification setup failed; retrying."); return }
            val descriptor = characteristic.getDescriptor(CCCD)
            if (descriptor == null) {
                retryConnection("The OMRON blood-pressure indication descriptor is unavailable.")
                return
            }
            descriptor.value = BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
            if (!connection.writeDescriptor(descriptor)) retryConnection("OMRON indication setup failed; retrying.")
        }

        override fun onDescriptorWrite(connection: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            if (gatt !== connection || !armed) return
            if (status != BluetoothGatt.GATT_SUCCESS) { retryConnection("OMRON indication setup failed; retrying."); return }
            subscribed = true
            notifyListeners("status", stateObject("waiting_for_reading").put("message", "OMRON connected. Take a reading; Sarah is listening."))
        }

        override fun onCharacteristicChanged(connection: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
            if (gatt !== connection || !armed) return
            handleMeasurement(connection.device, value)
        }

        @Deprecated("Deprecated by Android")
        override fun onCharacteristicChanged(connection: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            if (gatt !== connection || !armed) return
            handleMeasurement(connection.device, characteristic.value ?: return)
        }
    }

    @SuppressLint("MissingPermission")
    private fun handleMeasurement(device: BluetoothDevice, bytes: ByteArray) {
        val reading = runCatching { parseMeasurement(bytes, device) }.getOrElse {
            emitError(it.message ?: "OMRON sent an unreadable blood-pressure packet.")
            return
        }
        // Persist before crossing into the WebView. If its renderer is restarted between
        // this callback and the API save, arm() replays the packet using its stable id.
        synchronized(this) {
            val queue = pendingReadings()
            val id = reading.getString("external_id")
            if ((0 until queue.length()).none { queue.getJSONObject(it).optString("external_id") == id }) queue.put(reading)
            prefs.edit().putString(KEY_PENDING_QUEUE, queue.toString()).remove(KEY_PENDING_READING).commit()
        }
        notifyListeners("reading", reading)
        notifyListeners("status", stateObject("reading_received").put("message", "OMRON reading received."))
    }

    @SuppressLint("MissingPermission")
    private fun closeGatt() {
        subscribed = false
        val current = gatt
        gatt = null
        if (current != null) {
            runCatching { current.disconnect() }
            runCatching { current.close() }
        }
    }

    @Synchronized private fun pendingReadings(): JSONArray {
        val queue = runCatching { JSONArray(prefs.getString(KEY_PENDING_QUEUE, "[]")) }.getOrElse { JSONArray() }
        prefs.getString(KEY_PENDING_READING, null)?.let { encoded ->
            runCatching { JSObject(encoded) }.getOrNull()?.let { legacy ->
                if ((0 until queue.length()).none { queue.getJSONObject(it).optString("external_id") == legacy.getString("external_id") }) queue.put(legacy)
            }
        }
        return queue
    }

    private fun pendingReading(): JSObject? = pendingReadings().let {
        if (it.length() > 0) JSObject(it.getJSONObject(0).toString()) else null
    }

    private fun stateObject(state: String) = JSObject()
        .put("listening", armed)
        .put("connected", subscribed)
        .put("state", state)
        .put("deviceId", targetAddress ?: "")
        .put("deviceName", targetName)
        .put("deliveryError", deliveryError)
        .put("backgroundDelivery", true)
        .put("pendingReading", pendingReading())
        .put("pendingReadings", pendingReadings())
        .put("lastDeliveredReading", runCatching { JSObject(prefs.getString("last_delivered_reading", "{}")) }.getOrNull())

    private fun emitError(message: String) {
        notifyListeners("error", stateObject("error").put("message", message))
    }

    private fun hasBluetoothPermission(): Boolean = Build.VERSION.SDK_INT < 31 ||
        (ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED)

    private fun parseMeasurement(bytes: ByteArray, device: BluetoothDevice): JSObject {
        require(bytes.size >= 7) { "OMRON BP packet was too short." }
        val flags = bytes[0].toInt() and 0xff
        val kpa = flags and 0x01 != 0
        var offset = 1
        fun readSfloat(): Double {
            val raw = (bytes[offset].toInt() and 0xff) or ((bytes[offset + 1].toInt() and 0xff) shl 8)
            offset += 2
            val mantissaRaw = raw and 0x0fff
            val exponentRaw = (raw shr 12) and 0x0f
            val mantissa = if (mantissaRaw >= 0x0800) mantissaRaw - 0x1000 else mantissaRaw
            val exponent = if (exponentRaw >= 0x08) exponentRaw - 0x10 else exponentRaw
            return mantissa * 10.0.pow(exponent)
        }
        fun pressure() = (readSfloat() * if (kpa) 7.50062 else 1.0).roundToInt()
        val systolic = pressure()
        val diastolic = pressure()
        val mean = pressure()
        val receivedAt = System.currentTimeMillis()
        var timestamp = receivedAt
        var cuffDate: Long? = null
        if (flags and 0x02 != 0 && bytes.size >= offset + 7) {
            val year = (bytes[offset].toInt() and 0xff) or ((bytes[offset + 1].toInt() and 0xff) shl 8)
            cuffDate = OmronMeasurementTime.parse(year, bytes[offset + 2].toInt() and 0xff,
                bytes[offset + 3].toInt() and 0xff, bytes[offset + 4].toInt() and 0xff,
                bytes[offset + 5].toInt() and 0xff, bytes[offset + 6].toInt() and 0xff)
            timestamp = cuffDate ?: receivedAt
            offset += 7
        }
        val pulse = if (flags and 0x04 != 0 && bytes.size >= offset + 2) readSfloat().roundToInt() else null
        return JSObject()
            .put("measured_at", java.time.Instant.ofEpochMilli(timestamp).toString())
            .put("systolic_mm_hg", systolic)
            .put("diastolic_mm_hg", diastolic)
            .put("pulse_bpm", pulse)
            .put("source_app", "OMRON BP7000 native BLE")
            .put("source_device", device.name ?: targetName)
            .put("source_package", "native_direct_ble")
            .put("body_position", "unknown")
            .put("measurement_location", "upper_arm")
            .put("external_id", "omron-native-${device.address.replace(":", "")}-${timestamp}-${systolic}-${diastolic}-${pulse ?: 0}")
            .put("raw", JSObject().put("transport", "native_bluetooth_le").put("mean_arterial_pressure_mm_hg", mean).put("flags", flags)
                .put("timestamp_source", if (cuffDate == null) "received_at" else "cuff_clock")
                .put("received_at", java.time.Instant.ofEpochMilli(receivedAt).toString())
                .put("timestamp_note", if (cuffDate == null) "Cuff date unavailable or invalid; phone reception time used." else "Cuff local clock interpreted in phone time zone."))
    }

    // Bluetooth identifiers and persisted queue keys.

        private const val PREFS = "sarah_omron_device"
        private const val KEY_ADDRESS = "address"
        private const val KEY_NAME = "name"
        private const val KEY_PENDING_QUEUE = "pending_readings_v2"
        private const val KEY_PENDING_READING = "pending_reading"
        private const val SCAN_WINDOW_MS = 12_000L
        private const val SCAN_RESTART_DELAY_MS = 750L
        private val BP_SERVICE: UUID = UUID.fromString("00001810-0000-1000-8000-00805f9b34fb")
        private val BP_MEASUREMENT: UUID = UUID.fromString("00002a35-0000-1000-8000-00805f9b34fb")
        private val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
}
