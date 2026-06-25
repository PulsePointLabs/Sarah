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
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL

@CapacitorPlugin(name = "SarahFileSaver")
class SarahFileSaverPlugin : Plugin() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun handleOnDestroy() {
        scope.cancel()
        super.handleOnDestroy()
    }

    @PluginMethod
    fun saveFromUrl(call: PluginCall) {
        val url = call.getString("url")?.trim().orEmpty()
        val filename = safeFilename(call.getString("filename") ?: "sarah-media-download")
        val mimeType = call.getString("mimeType")?.trim().takeUnless { it.isNullOrBlank() }
            ?: guessMimeType(filename)

        if (url.isBlank()) {
            call.reject("Missing download URL.")
            return
        }
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            call.reject("Sarah can only save HTTP/HTTPS media URLs from the Android app.")
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
            call.reject("Save cancelled.")
            return
        }
        val outputUri = result.data?.data
        if (outputUri == null) {
            call.reject("Android did not return a save location.")
            return
        }

        val filename = safeFilename(call.getString("filename") ?: "sarah-media-download")
        val urls = urlsFromCall(call)
        scope.launch {
            try {
                val bytes = streamUrlsToUri(urls, outputUri)
                val response = JSObject()
                    .put("ok", true)
                    .put("filename", filename)
                    .put("bytes", bytes)
                    .put("uri", outputUri.toString())
                    .put("systemPicker", true)
                withContext(Dispatchers.Main) { call.resolve(response) }
            } catch (error: Exception) {
                withContext(Dispatchers.Main) {
                    call.reject(error.message ?: "Could not save media file.", error)
                }
            }
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

    private fun streamUrlsToUri(urls: List<String>, outputUri: Uri): Long {
        var lastError: Exception? = null
        for (url in urls) {
            try {
                return streamUrlToUri(url, outputUri)
            } catch (error: Exception) {
                lastError = error
            }
        }
        throw lastError ?: IllegalStateException("No usable download URL was available.")
    }

    private fun streamUrlToUri(url: String, outputUri: Uri): Long {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15000
            readTimeout = 300000
            instanceFollowRedirects = true
            requestMethod = "GET"
        }
        return try {
            val status = connection.responseCode
            if (status !in 200..299) {
                throw IllegalStateException("Download failed: HTTP $status")
            }
            context.contentResolver.openOutputStream(outputUri, "w")?.use { output ->
                connection.inputStream.use { input ->
                    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                    var total = 0L
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        output.write(buffer, 0, read)
                        total += read.toLong()
                    }
                    output.flush()
                    total
                }
            } ?: throw IllegalStateException("Could not open selected save location.")
        } finally {
            connection.disconnect()
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

        addUrl(call.getString("url"))
        val alternates = call.data.optJSONArray("alternateUrls")
        if (alternates != null) {
            for (index in 0 until alternates.length()) {
                addUrl(alternates.optString(index))
            }
        }
        return urls
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
