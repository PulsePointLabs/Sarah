package com.pulsepointlabs.sarah

import android.content.ContentValues
import android.os.Build
import android.provider.MediaStore
import com.getcapacitor.*
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.concurrent.Executors

@CapacitorPlugin(name="SarahTelemetry")
class SarahTelemetryPlugin : Plugin() {
    private val io = Executors.newSingleThreadExecutor()
    override fun load() { TelemetryJournal.init(context) }
    @PluginMethod fun status(call: PluginCall) = io.execute {
        try { call.resolve(JSObject().put("localCount",TelemetryJournal.count()).put("bloodPressure",TelemetryJournal.recent("blood_pressure")).put("cuff",OmronCollector.state())) }
        catch(error: Exception) { call.reject("Cannot read local telemetry: ${error.message}") }
    }
    @PluginMethod fun fullscreen(call: PluginCall) { activity.runOnUiThread {
        val enabled=call.getBoolean("enabled") ?: false
        (activity as MainActivity).setTelemetryFullscreen(enabled)
        call.resolve(JSObject().put("enabled",enabled))
    } }
    @PluginMethod fun export(call: PluginCall) = io.execute {
        var uri: android.net.Uri? = null
        try {
            require(Build.VERSION.SDK_INT >= 29) { "Telemetry export requires Android 10 or later." }
            val resolver=context.contentResolver
            val name="Sarah-telemetry-${System.currentTimeMillis()}.jsonl"
            uri=resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI,ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME,name);put(MediaStore.MediaColumns.MIME_TYPE,"application/x-ndjson")
                put(MediaStore.MediaColumns.RELATIVE_PATH,"Download/Sarah");put(MediaStore.MediaColumns.IS_PENDING,1)
            }) ?: error("Cannot create export")
            resolver.openOutputStream(uri!!)?.bufferedWriter()?.use { writer -> TelemetryJournal.export { writer.write(it) } } ?: error("Cannot write export")
            resolver.update(uri!!,ContentValues().apply {put(MediaStore.MediaColumns.IS_PENDING,0)},null,null)
            call.resolve(JSObject().put("name",name).put("location","Downloads/Sarah"))
        } catch(error: Exception) { uri?.let {context.contentResolver.delete(it,null,null)};call.reject("Export failed: ${error.message}") }
    }
}
