package com.pulsepointlabs.sarah

import android.content.Intent
import androidx.activity.result.ActivityResultLauncher
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.BloodPressureRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.Instant
import kotlin.math.roundToInt

@CapacitorPlugin(name = "BloodPressureHealth")
class BloodPressureHealthPlugin : Plugin() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val bpPermissions = setOf(HealthPermission.getReadPermission(BloodPressureRecord::class))
    private var permissionLauncher: ActivityResultLauncher<Set<String>>? = null
    private var pendingPermissionCall: PluginCall? = null

    override fun load() {
        permissionLauncher = bridge.registerForActivityResult(
            PermissionController.createRequestPermissionResultContract()
        ) { granted ->
            val call = pendingPermissionCall
            pendingPermissionCall = null
            if (call != null) {
                call.resolve(basicStatusObject(
                    sdkStatus = HealthConnectClient.getSdkStatus(context),
                    permissionGranted = granted.containsAll(bpPermissions),
                ))
            }
        }
    }

    override fun handleOnDestroy() {
        scope.cancel()
        super.handleOnDestroy()
    }

    @PluginMethod
    fun getStatus(call: PluginCall) {
        scope.launch {
            val status = statusObject()
            withContext(Dispatchers.Main) { call.resolve(status) }
        }
    }

    @PluginMethod
    fun requestPermission(call: PluginCall) {
        val launcher = permissionLauncher
        if (launcher == null) {
            call.reject("Health Connect permission launcher is not ready.")
            return
        }
        val sdkStatus = HealthConnectClient.getSdkStatus(context)
        if (sdkStatus != HealthConnectClient.SDK_AVAILABLE) {
            call.resolve(basicStatusObject(sdkStatus = sdkStatus, permissionGranted = false))
            return
        }
        pendingPermissionCall = call
        launcher.launch(bpPermissions)
    }

    @PluginMethod
    fun openHealthConnectSettings(call: PluginCall) {
        try {
            activity.startActivity(Intent("android.health.connect.action.HEALTH_CONNECT_SETTINGS"))
            call.resolve(JSObject().put("ok", true))
        } catch (error: Exception) {
            try {
                activity.startActivity(Intent("androidx.health.ACTION_HEALTH_CONNECT_SETTINGS"))
                call.resolve(JSObject().put("ok", true))
            } catch (fallbackError: Exception) {
                call.reject(fallbackError.message ?: error.message ?: "Could not open Health Connect settings.")
            }
        }
    }

    @PluginMethod
    fun readRecent(call: PluginCall) {
        val days = (call.getInt("days") ?: 30).coerceIn(1, 730)
        val limit = (call.getInt("limit") ?: 100).coerceIn(1, 500)
        scope.launch {
            try {
                val sdkStatus = HealthConnectClient.getSdkStatus(context)
                if (sdkStatus != HealthConnectClient.SDK_AVAILABLE) {
                    withContext(Dispatchers.Main) { call.resolve(statusObject(sdkStatus = sdkStatus).put("readings", JSArray())) }
                    return@launch
                }
                val client = HealthConnectClient.getOrCreate(context)
                val granted = client.permissionController.getGrantedPermissions()
                if (!granted.containsAll(bpPermissions)) {
                    withContext(Dispatchers.Main) { call.reject("Health Connect blood pressure permission is not granted.") }
                    return@launch
                }
                val end = Instant.now()
                val start = end.minusSeconds(days.toLong() * 24L * 60L * 60L)
                val response = client.readRecords(
                    ReadRecordsRequest(
                        recordType = BloodPressureRecord::class,
                        timeRangeFilter = TimeRangeFilter.between(start, end),
                        ascendingOrder = false,
                        pageSize = limit,
                    )
                )
                val readings = JSArray()
                response.records.take(limit).forEach { record ->
                    readings.put(recordToJson(record))
                }
                val result = statusObject(permissionGranted = true)
                result.put("readings", readings)
                result.put("count", readings.length())
                withContext(Dispatchers.Main) { call.resolve(result) }
            } catch (error: Exception) {
                withContext(Dispatchers.Main) { call.reject(error.message ?: "Could not read Health Connect blood pressure.", error) }
            }
        }
    }

    private suspend fun statusObject(
        sdkStatus: Int = HealthConnectClient.getSdkStatus(context),
        permissionGranted: Boolean? = null,
    ): JSObject {
        val available = sdkStatus == HealthConnectClient.SDK_AVAILABLE
        val granted = permissionGranted ?: if (available) {
            try {
                HealthConnectClient.getOrCreate(context).permissionController.getGrantedPermissions().containsAll(bpPermissions)
            } catch (_: Exception) {
                false
            }
        } else {
            false
        }
        return JSObject()
            .put("native", true)
            .put("available", available)
            .put("sdkStatus", sdkStatus)
            .put("permissionGranted", granted)
            .put("message", statusMessage(sdkStatus, granted))
    }

    private fun basicStatusObject(sdkStatus: Int, permissionGranted: Boolean): JSObject {
        return JSObject()
            .put("native", true)
            .put("available", sdkStatus == HealthConnectClient.SDK_AVAILABLE)
            .put("sdkStatus", sdkStatus)
            .put("permissionGranted", permissionGranted)
            .put("message", statusMessage(sdkStatus, permissionGranted))
    }

    private fun statusMessage(sdkStatus: Int, permissionGranted: Boolean): String {
        return when (sdkStatus) {
            HealthConnectClient.SDK_AVAILABLE -> if (permissionGranted) {
                "Health Connect blood pressure access is ready."
            } else {
                "Health Connect is available. Blood pressure permission is not granted yet."
            }
            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> "Health Connect needs to be installed or updated on this device."
            else -> "Health Connect is not available on this device."
        }
    }

    private fun recordToJson(record: BloodPressureRecord): JSObject {
        val metadata = record.metadata
        val origin = metadata.dataOrigin
        val device = metadata.device
        return JSObject()
            .put("measured_at", record.time.toString())
            .put("systolic_mm_hg", record.systolic.inMillimetersOfMercury.roundToInt())
            .put("diastolic_mm_hg", record.diastolic.inMillimetersOfMercury.roundToInt())
            .put("source_app", origin.packageName.ifBlank { "Health Connect" })
            .put("source_package", origin.packageName)
            .put("source_device", deviceLabel(device))
            .put("body_position", bodyPositionLabel(record.bodyPosition))
            .put("measurement_location", measurementLocationLabel(record.measurementLocation))
            .put("health_connect_id", metadata.id)
            .put("external_id", metadata.id)
            .put("raw", JSObject()
                .put("clientRecordId", metadata.clientRecordId)
                .put("clientRecordVersion", metadata.clientRecordVersion)
                .put("recordingMethod", metadata.recordingMethod)
                .put("zoneOffset", record.zoneOffset?.toString() ?: "")
            )
    }

    private fun deviceLabel(device: androidx.health.connect.client.records.metadata.Device?): String {
        if (device == null) return ""
        return listOfNotNull(device.manufacturer, device.model).filter { it.isNotBlank() }.joinToString(" ")
    }

    private fun bodyPositionLabel(value: Int): String {
        return when (value) {
            BloodPressureRecord.BODY_POSITION_STANDING_UP -> "standing"
            BloodPressureRecord.BODY_POSITION_SITTING_DOWN -> "sitting"
            BloodPressureRecord.BODY_POSITION_LYING_DOWN -> "lying"
            BloodPressureRecord.BODY_POSITION_RECLINING -> "reclining"
            else -> "unknown"
        }
    }

    private fun measurementLocationLabel(value: Int): String {
        return when (value) {
            BloodPressureRecord.MEASUREMENT_LOCATION_LEFT_WRIST -> "left_wrist"
            BloodPressureRecord.MEASUREMENT_LOCATION_RIGHT_WRIST -> "right_wrist"
            BloodPressureRecord.MEASUREMENT_LOCATION_LEFT_UPPER_ARM -> "left_upper_arm"
            BloodPressureRecord.MEASUREMENT_LOCATION_RIGHT_UPPER_ARM -> "right_upper_arm"
            else -> "unknown"
        }
    }
}
