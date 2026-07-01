package com.pulsepointlabs.sarah

import android.content.Intent
import android.util.Base64
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import java.io.File
import java.util.UUID

@CapacitorPlugin(name = "SarahBackgroundJobs")
class SarahBackgroundJobsPlugin : Plugin() {
    @PluginMethod
    fun submit(call: PluginCall) {
        val apiBase = call.getString("apiBase")?.trim()?.trimEnd('/').orEmpty()
        val requestPath = call.getString("path")?.trim().orEmpty()
        val body = call.getString("body").orEmpty()
        val bodyBase64 = call.getString("bodyBase64").orEmpty()
        val contentEncoding = call.getString("contentEncoding").orEmpty()
        if (apiBase.isBlank() || requestPath.isBlank() || (body.isBlank() && bodyBase64.isBlank())) {
            call.reject("Sarah API base, request path, and job payload are required.")
            return
        }

        val headers = headersFromCall(call)
        val submissionId = UUID.randomUUID().toString()
        try {
            val submissionDir = File(context.cacheDir, "background-job-submissions").apply { mkdirs() }
            val payloadFile = File(submissionDir, "$submissionId.json")
            if (bodyBase64.isNotBlank()) payloadFile.writeBytes(Base64.decode(bodyBase64, Base64.DEFAULT))
            else payloadFile.writeText(body, Charsets.UTF_8)
            val intent = Intent(context, SarahBackgroundJobService::class.java).apply {
                action = SarahBackgroundJobService.ACTION_SUBMIT
                putExtra(SarahBackgroundJobService.EXTRA_SUBMISSION_ID, submissionId)
                putExtra(SarahBackgroundJobService.EXTRA_PAYLOAD_FILE, payloadFile.absolutePath)
                putExtra(SarahBackgroundJobService.EXTRA_REQUEST_PATH, requestPath)
                putExtra(SarahBackgroundJobService.EXTRA_CONTENT_ENCODING, contentEncoding)
                putExtra(SarahBackgroundJobService.EXTRA_API_BASE, apiBase)
                putExtra(SarahBackgroundJobService.EXTRA_TITLE, call.getString("title") ?: "Sarah background task")
                putExtra(SarahBackgroundJobService.EXTRA_ROUTE, call.getString("route") ?: "/settings")
                putExtra(SarahBackgroundJobService.EXTRA_HEADERS_JSON, JSONObject(headers).toString())
            }
            ContextCompat.startForegroundService(context, intent)
            call.resolve(JSObject().put("ok", true).put("submissionId", submissionId).put("state", "queued"))
        } catch (error: Exception) {
            call.reject(error.message ?: "Could not save the Android background job submission.", error)
        }
    }

    @PluginMethod
    fun track(call: PluginCall) {
        val jobId = call.getString("jobId")?.trim().orEmpty()
        val apiBase = call.getString("apiBase")?.trim()?.trimEnd('/').orEmpty()
        if (jobId.isBlank() || apiBase.isBlank()) {
            call.reject("A job ID and Sarah API base are required.")
            return
        }

        val headers = headersFromCall(call)

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

    private fun headersFromCall(call: PluginCall): Map<String, String> {
        val headers = mutableMapOf<String, String>()
        call.data.optJSONObject("headers")?.let { raw ->
            val keys = raw.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                val value = raw.optString(key)
                if (key.isNotBlank() && value.isNotBlank()) headers[key] = value
            }
        }
        return headers
    }
}
