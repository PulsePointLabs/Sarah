package com.pulsepointlabs.sarah

import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.provider.Settings
import android.widget.Toast
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
                setAllowedNetworkTypes(DownloadManager.Request.NETWORK_WIFI or DownloadManager.Request.NETWORK_MOBILE)
                setAllowedOverMetered(true)
                setAllowedOverRoaming(true)
                setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, filename)
            }
            val downloadId = manager.enqueue(request)
            Toast.makeText(context, "Download started: $filename", Toast.LENGTH_SHORT).show()
            call.resolve(
                JSObject()
                    .put("ok", true)
                    .put("filename", filename)
                    .put("downloadId", downloadId)
                    .put("systemDownload", true)
            )
        } catch (error: Exception) {
            try {
                openExternalUrl(url)
                Toast.makeText(context, "Opened download link", Toast.LENGTH_SHORT).show()
                call.resolve(
                    JSObject()
                        .put("ok", true)
                        .put("filename", filename)
                        .put("openedExternally", true)
                        .put("systemDownload", false)
                        .put("downloadManagerError", error.message ?: "Android DownloadManager rejected this download.")
                )
            } catch (fallbackError: Exception) {
                call.reject(error.message ?: "Could not hand download to Android.", error)
            }
        }
    }

    @PluginMethod
    fun openUrl(call: PluginCall) {
        val url = call.getString("url")?.trim().orEmpty()
        if (url.isBlank()) {
            call.reject("Missing URL.")
            return
        }
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            call.reject("Sarah can only open HTTP/HTTPS URLs from the Android app.")
            return
        }
        try {
            openExternalUrl(url)
            call.resolve(JSObject().put("ok", true).put("openedExternally", true))
        } catch (error: Exception) {
            call.reject(error.message ?: "Could not open Android download link.", error)
        }
    }

    @PluginMethod
    fun getDownloadStatus(call: PluginCall) {
        val downloadId = call.getDouble("downloadId")?.toLong()
        if (downloadId == null || downloadId <= 0) {
            call.reject("Missing Android download id.")
            return
        }

        try {
            val manager = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
            val query = DownloadManager.Query().setFilterById(downloadId)
            manager.query(query).use { cursor ->
                if (!cursor.moveToFirst()) {
                    call.resolve(
                        JSObject()
                            .put("ok", false)
                            .put("downloadId", downloadId)
                            .put("status", "missing")
                            .put("message", "Android no longer has this download in its queue.")
                    )
                    return
                }

                val status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
                val reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON))
                val downloaded = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
                val total = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))
                val localUriIndex = cursor.getColumnIndex(DownloadManager.COLUMN_LOCAL_URI)
                val localUri = if (localUriIndex >= 0) cursor.getString(localUriIndex) else null

                call.resolve(
                    JSObject()
                        .put("ok", true)
                        .put("downloadId", downloadId)
                        .put("status", downloadStatusLabel(status))
                        .put("reason", reason)
                        .put("reasonLabel", downloadReasonLabel(status, reason))
                        .put("bytesDownloaded", downloaded)
                        .put("totalBytes", total)
                        .put("localUri", localUri)
                )
            }
        } catch (error: Exception) {
            call.reject(error.message ?: "Could not read Android download status.", error)
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

    private fun downloadStatusLabel(status: Int): String {
        return when (status) {
            DownloadManager.STATUS_PENDING -> "pending"
            DownloadManager.STATUS_RUNNING -> "running"
            DownloadManager.STATUS_PAUSED -> "paused"
            DownloadManager.STATUS_SUCCESSFUL -> "successful"
            DownloadManager.STATUS_FAILED -> "failed"
            else -> "unknown"
        }
    }

    private fun downloadReasonLabel(status: Int, reason: Int): String {
        if (status == DownloadManager.STATUS_PAUSED) {
            return when (reason) {
                DownloadManager.PAUSED_WAITING_TO_RETRY -> "waiting_to_retry"
                DownloadManager.PAUSED_WAITING_FOR_NETWORK -> "waiting_for_network"
                DownloadManager.PAUSED_QUEUED_FOR_WIFI -> "queued_for_wifi"
                DownloadManager.PAUSED_UNKNOWN -> "paused_unknown"
                else -> "paused_$reason"
            }
        }
        if (status == DownloadManager.STATUS_FAILED) {
            return when (reason) {
                DownloadManager.ERROR_CANNOT_RESUME -> "cannot_resume"
                DownloadManager.ERROR_DEVICE_NOT_FOUND -> "device_not_found"
                DownloadManager.ERROR_FILE_ALREADY_EXISTS -> "file_already_exists"
                DownloadManager.ERROR_FILE_ERROR -> "file_error"
                DownloadManager.ERROR_HTTP_DATA_ERROR -> "http_data_error"
                DownloadManager.ERROR_INSUFFICIENT_SPACE -> "insufficient_space"
                DownloadManager.ERROR_TOO_MANY_REDIRECTS -> "too_many_redirects"
                DownloadManager.ERROR_UNHANDLED_HTTP_CODE -> "unhandled_http_code"
                DownloadManager.ERROR_UNKNOWN -> "unknown_error"
                else -> "error_$reason"
            }
        }
        return ""
    }

    private fun openExternalUrl(url: String) {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(intent)
        } catch (error: ActivityNotFoundException) {
            throw Exception("No Android app can open this download URL.", error)
        }
    }
}
