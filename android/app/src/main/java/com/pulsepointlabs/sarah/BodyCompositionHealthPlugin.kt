package com.pulsepointlabs.sarah

import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.activity.result.ActivityResultLauncher
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.BasalMetabolicRateRecord
import androidx.health.connect.client.records.BodyFatRecord
import androidx.health.connect.client.records.BodyWaterMassRecord
import androidx.health.connect.client.records.BoneMassRecord
import androidx.health.connect.client.records.LeanBodyMassRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.WeightRecord
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
import kotlin.reflect.KClass

@CapacitorPlugin(name = "BodyCompositionHealth")
class BodyCompositionHealthPlugin : Plugin() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val recordTypes = listOf<KClass<out Record>>(
        WeightRecord::class,
        BodyFatRecord::class,
        LeanBodyMassRecord::class,
        BodyWaterMassRecord::class,
        BoneMassRecord::class,
        BasalMetabolicRateRecord::class,
    )
    private val recordPermissions = recordTypes.map { HealthPermission.getReadPermission(it) }.toSet()
    private val permissions = recordPermissions + HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY
    private var permissionLauncher: ActivityResultLauncher<Set<String>>? = null
    private var pendingPermissionCall: PluginCall? = null

    override fun load() {
        permissionLauncher = bridge.registerForActivityResult(
            PermissionController.createRequestPermissionResultContract()
        ) { granted ->
            val call = pendingPermissionCall
            pendingPermissionCall = null
            call?.resolve(statusObjectSync(granted))
        }
    }

    override fun handleOnDestroy() {
        scope.cancel()
        super.handleOnDestroy()
    }

    @PluginMethod
    fun getStatus(call: PluginCall) {
        scope.launch {
            val result = try {
                val sdkStatus = HealthConnectClient.getSdkStatus(context)
                val granted = if (sdkStatus == HealthConnectClient.SDK_AVAILABLE) {
                    HealthConnectClient.getOrCreate(context).permissionController.getGrantedPermissions()
                } else {
                    emptySet()
                }
                statusObjectSync(granted, sdkStatus)
            } catch (error: Exception) {
                JSObject()
                    .put("native", true)
                    .put("available", false)
                    .put("permissionGranted", false)
                    .put("message", error.message ?: "Could not inspect Health Connect.")
            }
            withContext(Dispatchers.Main) { call.resolve(result) }
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
            call.resolve(statusObjectSync(emptySet(), sdkStatus))
            return
        }
        pendingPermissionCall = call
        launcher.launch(permissions)
    }

    @PluginMethod
    fun openHealthConnectSettings(call: PluginCall) {
        val intents = listOf(
            Intent(HealthConnectClient.ACTION_HEALTH_CONNECT_SETTINGS),
            Intent("android.health.connect.action.HEALTH_CONNECT_SETTINGS"),
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                .setData(Uri.parse("package:com.google.android.apps.healthdata")),
            context.packageManager.getLaunchIntentForPackage("com.google.android.apps.healthdata"),
            Intent(Settings.ACTION_SETTINGS),
        ).filterNotNull()

        for (intent in intents) {
            try {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                activity.startActivity(intent)
                call.resolve(JSObject().put("ok", true))
                return
            } catch (_: Exception) {
                // Try the next settings route.
            }
        }
        call.reject("Could not open Health Connect settings. Open Android Settings and search for Health Connect.")
    }

    @PluginMethod
    fun readRecent(call: PluginCall) {
        val days = (call.getInt("days") ?: 30).coerceIn(1, 730)
        val limit = (call.getInt("limit") ?: 100).coerceIn(1, 500)
        scope.launch {
            try {
                val sdkStatus = HealthConnectClient.getSdkStatus(context)
                if (sdkStatus != HealthConnectClient.SDK_AVAILABLE) {
                    withContext(Dispatchers.Main) {
                        call.resolve(statusObjectSync(emptySet(), sdkStatus).put("readings", JSArray()))
                    }
                    return@launch
                }
                val client = HealthConnectClient.getOrCreate(context)
                val granted = client.permissionController.getGrantedPermissions()
                if (recordPermissions.none { granted.contains(it) }) {
                    withContext(Dispatchers.Main) {
                        call.reject("Health Connect body-composition permission is not granted.")
                    }
                    return@launch
                }

                val end = Instant.now()
                val start = end.minusSeconds(days.toLong() * 24L * 60L * 60L)
                val buckets = sortedMapOf<Long, JSObject>()

                suspend fun <T : Record> read(
                    type: KClass<T>,
                    permission: String,
                    apply: (JSObject, T) -> Unit,
                ) {
                    if (!granted.contains(permission)) return
                    val response = client.readRecords(
                        ReadRecordsRequest(
                            recordType = type,
                            timeRangeFilter = TimeRangeFilter.between(start, end),
                            ascendingOrder = false,
                            pageSize = limit,
                        )
                    )
                    response.records.take(limit).forEach { record ->
                        val time = recordTime(record)
                        val key = time.epochSecond
                        val target = buckets.getOrPut(key) {
                            JSObject()
                                .put("measured_at", time.toString())
                                .put("source_app", record.metadata.dataOrigin.packageName.ifBlank { "Health Connect" })
                                .put("source_package", record.metadata.dataOrigin.packageName)
                                .put("source_device", deviceLabel(record.metadata.device))
                                .put("health_connect_ids", JSArray())
                        }
                        target.getJSONArray("health_connect_ids").put(record.metadata.id)
                        apply(target, record)
                    }
                }

                read(WeightRecord::class, HealthPermission.getReadPermission(WeightRecord::class)) { out, row ->
                    out.put("weight_kg", row.weight.inKilograms)
                }
                read(BodyFatRecord::class, HealthPermission.getReadPermission(BodyFatRecord::class)) { out, row ->
                    out.put("body_fat_percent", row.percentage.value)
                }
                read(LeanBodyMassRecord::class, HealthPermission.getReadPermission(LeanBodyMassRecord::class)) { out, row ->
                    out.put("lean_body_mass_kg", row.mass.inKilograms)
                }
                read(BodyWaterMassRecord::class, HealthPermission.getReadPermission(BodyWaterMassRecord::class)) { out, row ->
                    out.put("body_water_mass_kg", row.mass.inKilograms)
                }
                read(BoneMassRecord::class, HealthPermission.getReadPermission(BoneMassRecord::class)) { out, row ->
                    out.put("bone_mass_kg", row.mass.inKilograms)
                }
                read(BasalMetabolicRateRecord::class, HealthPermission.getReadPermission(BasalMetabolicRateRecord::class)) { out, row ->
                    out.put("basal_metabolic_rate_kcal_day", row.basalMetabolicRate.inKilocaloriesPerDay)
                }

                val readings = JSArray()
                buckets.values.reversed().take(limit).forEach { readings.put(it) }
                val result = statusObjectSync(granted, sdkStatus)
                    .put("readings", readings)
                    .put("count", readings.length())
                withContext(Dispatchers.Main) { call.resolve(result) }
            } catch (error: Exception) {
                withContext(Dispatchers.Main) {
                    call.reject(error.message ?: "Could not read Health Connect body composition.", error)
                }
            }
        }
    }

    private fun recordTime(record: Record): Instant {
        return when (record) {
            is WeightRecord -> record.time
            is BodyFatRecord -> record.time
            is LeanBodyMassRecord -> record.time
            is BodyWaterMassRecord -> record.time
            is BoneMassRecord -> record.time
            is BasalMetabolicRateRecord -> record.time
            else -> Instant.now()
        }
    }

    private fun statusObjectSync(
        granted: Set<String>,
        sdkStatus: Int = HealthConnectClient.getSdkStatus(context),
    ): JSObject {
        val permissionMap = JSObject()
        recordTypes.forEach { type ->
            permissionMap.put(type.simpleName ?: "unknown", granted.contains(HealthPermission.getReadPermission(type)))
        }
        val grantedCount = recordPermissions.count { granted.contains(it) }
        val historyGranted = granted.contains(HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY)
        return JSObject()
            .put("native", true)
            .put("available", sdkStatus == HealthConnectClient.SDK_AVAILABLE)
            .put("sdkStatus", sdkStatus)
            .put("permissionGranted", grantedCount > 0)
            .put("allPermissionsGranted", grantedCount == recordPermissions.size)
            .put("historyPermissionGranted", historyGranted)
            .put("grantedCount", grantedCount)
            .put("permissionCount", recordPermissions.size)
            .put("permissions", permissionMap)
            .put("message", when (sdkStatus) {
                HealthConnectClient.SDK_AVAILABLE -> when {
                    grantedCount == recordPermissions.size && historyGranted -> "Health Connect body-composition access and extended history are ready."
                    grantedCount == recordPermissions.size -> "Body-composition access is ready, but older history is not enabled."
                    grantedCount > 0 -> "Health Connect body-composition access is partially enabled."
                    else -> "Health Connect is available. Body-composition permission is not granted yet."
                }
                HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> "Health Connect needs to be installed or updated."
                else -> "Health Connect is not available on this device."
            })
    }

    private fun deviceLabel(device: androidx.health.connect.client.records.metadata.Device?): String {
        if (device == null) return ""
        return listOfNotNull(device.manufacturer, device.model)
            .filter { it.isNotBlank() }
            .joinToString(" ")
    }
}
