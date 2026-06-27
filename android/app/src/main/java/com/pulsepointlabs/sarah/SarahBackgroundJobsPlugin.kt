package com.pulsepointlabs.sarah

import android.content.Intent
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject

@CapacitorPlugin(name = "SarahBackgroundJobs")
class SarahBackgroundJobsPlugin : Plugin() {
    @PluginMethod
    fun track(call: PluginCall) {
        val jobId = call.getString("jobId")?.trim().orEmpty()
        val apiBase = call.getString("apiBase")?.trim()?.trimEnd('/').orEmpty()
        if (jobId.isBlank() || apiBase.isBlank()) {
            call.reject("A job ID and Sarah API base are required.")
            return
        }

        val headers = mutableMapOf<String, String>()
        call.data.optJSONObject("headers")?.let { raw ->
            val keys = raw.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                val value = raw.optString(key)
                if (key.isNotBlank() && value.isNotBlank()) headers[key] = value
            }
        }

        val intent = Intent(context, SarahBackgroundJobService::class.java).apply {
            action = SarahBackgroundJobService.ACTION_TRACK
            putExtra(SarahBackgroundJobService.EXTRA_JOB_ID, jobId)
            putExtra(SarahBackgroundJobService.EXTRA_API_BASE, apiBase)
            putExtra(SarahBackgroundJobService.EXTRA_TITLE, call.getString("title") ?: "Sarah background task")
            putExtra(SarahBackgroundJobService.EXTRA_ROUTE, call.getString("route") ?: "/settings")
            putExtra(SarahBackgroundJobService.EXTRA_HEADERS_JSON, JSONObject(headers).toString())
        }
        try {
            ContextCompat.startForegroundService(context, intent)
            call.resolve(JSObject().put("ok", true).put("jobId", jobId).put("state", "tracking"))
        } catch (error: Exception) {
            call.reject(error.message ?: "Could not start Android background job tracking.", error)
        }
    }
}
