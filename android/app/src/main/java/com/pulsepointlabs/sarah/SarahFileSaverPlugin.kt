package com.pulsepointlabs.sarah

import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.provider.Settings
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "SarahFileSaver")
class SarahFileSaverPlugin : Plugin() {
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

        try {
            val manager = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
            val request = DownloadManager.Request(Uri.parse(url)).apply {
                setTitle(filename)
                setDescription("Downloading from Sarah")
                setMimeType(mimeType)
                setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                setAllowedOverMetered(true)
                setAllowedOverRoaming(true)
                setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, filename)
            }
            val downloadId = manager.enqueue(request)
            call.resolve(
                JSObject()
                    .put("ok", true)
                    .put("filename", filename)
                    .put("downloadId", downloadId)
                    .put("systemDownload", true)
            )
        } catch (error: Exception) {
            call.reject(error.message ?: "Could not hand download to Android.", error)
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
