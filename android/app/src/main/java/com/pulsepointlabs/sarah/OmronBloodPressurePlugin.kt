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
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.Calendar
import java.util.UUID
import kotlin.math.pow
import kotlin.math.roundToInt

@CapacitorPlugin(name = "OmronBloodPressure")
class OmronBloodPressurePlugin : Plugin() {
    private val handler = Handler(Looper.getMainLooper())
    private val adapter: BluetoothAdapter?
        get() = (context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter
    private val prefs by lazy { context.getSharedPreferences(PREFS, Context.MODE_PRIVATE) }
    private var gatt: BluetoothGatt? = null
    private var armed = false
    private var scanning = false
    private var subscribed = false
    private var targetAddress: String? = null
    private var targetName: String = "OMRON BP7000"

    @PluginMethod
    fun arm(call: PluginCall) {
        if (!hasBluetoothPermission()) {
            call.reject("Bluetooth permission is required before Sarah can listen for the OMRON cuff.")
            return
        }
        val address = call.getString("deviceId")?.trim()
            ?.takeIf { it.isNotBlank() }
            ?: prefs.getString(KEY_ADDRESS, null)
        if (address.isNullOrBlank()) {
            call.reject("Select the OMRON cuff once before enabling automatic listening.")
            return
        }
        targetAddress = address
        targetName = call.getString("name")?.trim()?.takeIf { it.isNotBlank() }
            ?: prefs.getString(KEY_NAME, null)
            ?: "OMRON BP7000"
        prefs.edit().putString(KEY_ADDRESS, address).putString(KEY_NAME, targetName).apply()
        armed = true
        closeGatt()
        startScan()
        call.resolve(stateObject("waiting_for_cuff"))
    }

    @PluginMethod
    fun disarm(call: PluginCall) {
        armed = false
        stopScan()
        closeGatt()
        call.resolve(stateObject("stopped"))
    }

    @PluginMethod
    fun getState(call: PluginCall) {
        call.resolve(stateObject(if (!armed) "stopped" else if (subscribed) "waiting_for_reading" else "waiting_for_cuff"))
    }

    override fun handleOnDestroy() {
        armed = false
        stopScan()
        closeGatt()
        super.handleOnDestroy()
    }

    @SuppressLint("MissingPermission")
    private fun startScan() {
        if (!armed || scanning || !hasBluetoothPermission()) return
        val scanner = adapter?.bluetoothLeScanner ?: run {
            emitError("Bluetooth scanner is unavailable.")
            return
        }
        scanning = true
        notifyListeners("status", stateObject("scanning").put("message", "Waiting for the saved OMRON cuff to wake..."))
        val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
        val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(BP_SERVICE)).build()
        scanner.startScan(listOf(filter), settings, scanCallback)
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

    private val scanCallback = object : ScanCallback() {
        @SuppressLint("MissingPermission")
        override fun onScanResult(callbackType: Int, result: ScanResult) {
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
        gatt = device.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
    }

    private val gattCallback = object : BluetoothGattCallback() {
        @SuppressLint("MissingPermission")
        override fun onConnectionStateChange(connection: BluetoothGatt, status: Int, newState: Int) {
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
            val characteristic = connection.getService(BP_SERVICE)?.getCharacteristic(BP_MEASUREMENT)
            if (status != BluetoothGatt.GATT_SUCCESS || characteristic == null) {
                emitError("The saved cuff did not expose the Bluetooth blood-pressure measurement service.")
                closeGatt()
                if (armed) startScan()
                return
            }
            connection.setCharacteristicNotification(characteristic, true)
            val descriptor = characteristic.getDescriptor(CCCD)
            if (descriptor == null) {
                emitError("The OMRON blood-pressure indication descriptor is unavailable.")
                return
            }
            descriptor.value = BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
            connection.writeDescriptor(descriptor)
            subscribed = true
            notifyListeners("status", stateObject("waiting_for_reading").put("message", "OMRON connected. Take a reading; Sarah is listening."))
        }

        override fun onCharacteristicChanged(connection: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
            handleMeasurement(connection.device, value)
        }

        @Deprecated("Deprecated by Android")
        override fun onCharacteristicChanged(connection: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            handleMeasurement(connection.device, characteristic.value ?: return)
        }
    }

    @SuppressLint("MissingPermission")
    private fun handleMeasurement(device: BluetoothDevice, bytes: ByteArray) {
        val reading = runCatching { parseMeasurement(bytes, device) }.getOrElse {
            emitError(it.message ?: "OMRON sent an unreadable blood-pressure packet.")
            return
        }
        // Emit immediately; database persistence can happen after the UI updates.
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

    private fun stateObject(state: String) = JSObject()
        .put("listening", armed)
        .put("connected", subscribed)
        .put("state", state)
        .put("deviceId", targetAddress ?: "")
        .put("deviceName", targetName)

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
        var timestamp = System.currentTimeMillis()
        if (flags and 0x02 != 0 && bytes.size >= offset + 7) {
            val year = (bytes[offset].toInt() and 0xff) or ((bytes[offset + 1].toInt() and 0xff) shl 8)
            val calendar = Calendar.getInstance().apply {
                set(year, (bytes[offset + 2].toInt() and 0xff) - 1, bytes[offset + 3].toInt() and 0xff,
                    bytes[offset + 4].toInt() and 0xff, bytes[offset + 5].toInt() and 0xff, bytes[offset + 6].toInt() and 0xff)
                set(Calendar.MILLISECOND, 0)
            }
            timestamp = calendar.timeInMillis
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
            .put("raw", JSObject().put("transport", "native_bluetooth_le").put("mean_arterial_pressure_mm_hg", mean).put("flags", flags))
    }

    companion object {
        private const val PREFS = "sarah_omron_device"
        private const val KEY_ADDRESS = "address"
        private const val KEY_NAME = "name"
        private const val SCAN_WINDOW_MS = 12_000L
        private const val SCAN_RESTART_DELAY_MS = 750L
        private val BP_SERVICE: UUID = UUID.fromString("00001810-0000-1000-8000-00805f9b34fb")
        private val BP_MEASUREMENT: UUID = UUID.fromString("00002a35-0000-1000-8000-00805f9b34fb")
        private val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    }
}
