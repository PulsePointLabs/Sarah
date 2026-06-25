package com.pulsepointlabs.sarah

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject

@CapacitorPlugin(name = "SarahFileSaver")
class SarahFileSaverPlugin : Plugin() {
    @PluginMethod
    fun downloadWithManager(call: PluginCall) {
        // Backward-compatible bridge name. The APK download path must still use
        // Android's Save As picker, then Sarah's native foreground downloader.
        saveFromUrl(call)
    }

    @PluginMethod
    fun saveFromUrl(call: PluginCall) {
        val urls = urlsFromCall(call)
        val filename = safeFilename(call.getString("filename") ?: "sarah-media-download")
        val mimeType = call.getString("mimeType")?.trim().takeUnless { it.isNullOrBlank() }
            ?: guessMimeType(filename)

        if (urls.isEmpty()) {
            call.reject("Missing download URL.")
            return
        }

        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = mimeType
            putExtra(Intent.EXTRA_TITLE, filename)
        }
        startActivityForResult(call, intent, "handleSaveDocumentResult")
    }

    @ActivityCallback
    fun handleSaveDocumentResult(call: PluginCall, result: ActivityResult) {
        if (result.resultCode != Activity.RESULT_OK) {
            call.resolve(
                JSObject()
                    .put("ok", false)
                    .put("state", "cancelled")
                    .put("cancelled", true)
                    .put("message", "Save cancelled.")
            )
            return
        }

        val outputUri = result.data?.data
        if (outputUri == null) {
            call.reject("Android did not return a save location.")
            return
        }

        try {
            val flags = result.data?.flags ?: 0
            val persistFlags = flags and (
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            )
            if (persistFlags != 0) {
                context.contentResolver.takePersistableUriPermission(outputUri, persistFlags)
            }
        } catch (_: Exception) {
            // Some document providers do not offer persistable grants for newly
            // created files. The immediate write grant is still usable.
        }

        val urls = urlsFromCall(call)
        val filename = safeFilename(call.getString("filename") ?: "sarah-media-download")
        val mimeType = call.getString("mimeType")?.trim().takeUnless { it.isNullOrBlank() }
            ?: guessMimeType(filename)
        val headers = headersFromCall(call)
        val downloadId = "sarah-${System.currentTimeMillis()}"

        val serviceIntent = Intent(context, SarahDownloadService::class.java).apply {
            action = SarahDownloadService.ACTION_START
            putStringArrayListExtra(SarahDownloadService.EXTRA_URLS, ArrayList(urls))
            putExtra(SarahDownloadService.EXTRA_DESTINATION_URI, outputUri.toString())
            putExtra(SarahDownloadService.EXTRA_FILENAME, filename)
            putExtra(SarahDownloadService.EXTRA_MIME_TYPE, mimeType)
            putExtra(SarahDownloadService.EXTRA_HEADERS_JSON, JSONObject(headers).toString())
            putExtra(SarahDownloadService.EXTRA_DOWNLOAD_ID, downloadId)
        }

        try {
            context.startForegroundService(serviceIntent)
            call.resolve(
                JSObject()
                    .put("ok", true)
                    .put("downloadId", downloadId)
                    .put("state", "queued")
                    .put("filename", filename)
                    .put("mimeType", mimeType)
                    .put("uri", outputUri.toString())
                    .put("nativeDownload", true)
                    .put("systemPicker", true)
            )
        } catch (error: Exception) {
            call.reject(error.message ?: "Could not start Sarah native download.", error)
        }
    }

    @PluginMethod
    fun openDownloads(call: PluginCall) {
        try {
            val intent = Intent("android.intent.action.VIEW_DOWNLOADS")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            call.resolve(JSObject().put("ok", true))
        } catch (error: Exception) {
            call.reject("Could not open Android Downloads.", error)
        }
    }

    @PluginMethod
    fun openAppSettings(call: PluginCall) {
        try {
            val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                .setData(Uri.parse("package:${context.packageName}"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            activity.startActivity(intent)
            call.resolve(JSObject().put("ok", true))
        } catch (error: Exception) {
            call.reject("Could not open Android app settings.", error)
        }
    }

    private fun urlsFromCall(call: PluginCall): List<String> {
        val urls = mutableListOf<String>()
        fun addUrl(value: String?) {
            val clean = value?.trim().orEmpty()
            if (
                clean.isNotBlank()
                && (clean.startsWith("http://") || clean.startsWith("https://"))
                && !urls.contains(clean)
            ) {
                urls.add(clean)
            }
        }

        val alternates = call.data.optJSONArray("alternateUrls")
        if (alternates != null) {
            for (index in 0 until alternates.length()) {
                addUrl(alternates.optString(index))
            }
        }
        addUrl(call.getString("url"))
        return urls
    }

    private fun headersFromCall(call: PluginCall): Map<String, String> {
        val headers = mutableMapOf<String, String>()
        val raw = call.data.optJSONObject("headers") ?: return headers
        val keys = raw.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            val value = raw.optString(key)
            if (key.isNotBlank() && value.isNotBlank()) {
                headers[key] = value
            }
        }
        return headers
    }

    private fun safeFilename(value: String): String {
        val cleaned = value
            .replace(Regex("[\\\\/:*?\"<>|]+"), "-")
            .replace(Regex("\\s+"), " ")
            .trim()
        return cleaned.ifBlank { "sarah-media-download" }
    }

    private fun guessMimeType(filename: String): String {
        val lower = filename.lowercase()
        return when {
            lower.endsWith(".mp3") -> "audio/mpeg"
            lower.endsWith(".m4a") -> "audio/mp4"
            lower.endsWith(".wav") -> "audio/wav"
            lower.endsWith(".mp4") -> "video/mp4"
            lower.endsWith(".json") -> "application/json"
            lower.endsWith(".cue") -> "application/octet-stream"
            lower.endsWith(".txt") -> "text/plain"
            else -> "application/octet-stream"
        }
    }
}
