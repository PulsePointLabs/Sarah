package com.pulsepointlabs.sarah

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.util.Log
import android.webkit.CookieManager
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.max

class SarahDownloadService : Service() {
    companion object {
        const val ACTION_START = "com.pulsepointlabs.sarah.download.START"
        const val ACTION_CANCEL = "com.pulsepointlabs.sarah.download.CANCEL"

        const val EXTRA_URLS = "urls"
        const val EXTRA_DESTINATION_URI = "destinationUri"
        const val EXTRA_FILENAME = "filename"
        const val EXTRA_MIME_TYPE = "mimeType"
        const val EXTRA_HEADERS_JSON = "headersJson"
        const val EXTRA_DOWNLOAD_ID = "downloadId"

        private const val TAG = "SarahDownloadService"
        private const val CHANNEL_ID = "sarah_file_downloads"
        private const val CHANNEL_NAME = "Sarah downloads"

        private val activeJobs = ConcurrentHashMap<String, Job>()
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private lateinit var notificationManager: NotificationManager

    override fun onCreate() {
        super.onCreate()
        notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        ensureChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_CANCEL) {
            val id = intent.getStringExtra(EXTRA_DOWNLOAD_ID).orEmpty()
            activeJobs.remove(id)?.cancel()
            showTerminalNotification(
                notificationId(id),
                intent.getStringExtra(EXTRA_FILENAME).orEmpty().ifBlank { "Sarah download" },
                "Download cancelled",
                "cancelled",
                null,
                intent.getStringExtra(EXTRA_MIME_TYPE).orEmpty()
            )
            return START_NOT_STICKY
        }

        if (intent?.action != ACTION_START) return START_NOT_STICKY

        val downloadId = intent.getStringExtra(EXTRA_DOWNLOAD_ID).orEmpty().ifBlank {
            "sarah-${System.currentTimeMillis()}"
        }
        val filename = intent.getStringExtra(EXTRA_FILENAME).orEmpty().ifBlank { "Sarah download" }
        val notificationId = notificationId(downloadId)
        val started = progressNotification(
            filename = filename,
            text = "Queued",
            bytes = 0L,
            total = -1L,
            indeterminate = true,
            downloadId = downloadId
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(notificationId, started, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(notificationId, started)
        }

        val job = scope.launch { runDownload(intent, downloadId, notificationId, startId) }
        activeJobs[downloadId] = job
        return START_REDELIVER_INTENT
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun runDownload(intent: Intent, downloadId: String, notificationId: Int, startId: Int) {
        val urls = intent.getStringArrayListExtra(EXTRA_URLS).orEmpty()
        val destination = intent.getStringExtra(EXTRA_DESTINATION_URI).orEmpty()
        val filename = intent.getStringExtra(EXTRA_FILENAME).orEmpty().ifBlank { "Sarah download" }
        val mimeType = intent.getStringExtra(EXTRA_MIME_TYPE).orEmpty().ifBlank { "application/octet-stream" }
        val headers = headersFromJson(intent.getStringExtra(EXTRA_HEADERS_JSON).orEmpty())
        val destinationUri = Uri.parse(destination)
        val startedAt = System.currentTimeMillis()
        var lastError: Exception? = null

        if (urls.isEmpty()) {
            fail(notificationId, filename, mimeType, null, "No usable download URL was provided.", startedAt)
            activeJobs.remove(downloadId)
            stopSelf(startId)
            return
        }

        for (url in urls) {
            try {
                streamOneUrl(url, destinationUri, filename, mimeType, headers, downloadId, notificationId, startedAt)
                activeJobs.remove(downloadId)
                stopSelf(startId)
                return
            } catch (error: Exception) {
                lastError = error
                Log.w(TAG, "Download URL failed: ${redactUrl(url)} ${error.javaClass.simpleName}: ${error.message}")
            }
        }

        fail(
            notificationId,
            filename,
            mimeType,
            destinationUri,
            lastError?.message ?: "Sarah could not download this file from any available server address.",
            startedAt
        )
        activeJobs.remove(downloadId)
        stopSelf(startId)
    }

    private fun streamOneUrl(
        url: String,
        destinationUri: Uri,
        filename: String,
        mimeType: String,
        headers: Map<String, String>,
        downloadId: String,
        notificationId: Int,
        startedAt: Long
    ) {
        notificationManager.notify(
            notificationId,
            progressNotification(filename, "Connecting", 0L, -1L, true, downloadId)
        )

        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15000
            readTimeout = 300000
            instanceFollowRedirects = true
            requestMethod = "GET"
            for ((key, value) in headers) {
                if (key.isNotBlank() && value.isNotBlank()) setRequestProperty(key, value)
            }
            CookieManager.getInstance().getCookie(url)?.takeIf { it.isNotBlank() }?.let { cookie ->
                if (!headers.keys.any { it.equals("Cookie", ignoreCase = true) }) {
                    setRequestProperty("Cookie", cookie)
                }
            }
        }

        var bytesWritten = 0L
        try {
            val status = connection.responseCode
            val responseType = connection.contentType.orEmpty()
            val contentLength = connection.contentLengthLong
            Log.i(
                TAG,
                "download start url=${redactUrl(url)} status=$status type=$responseType length=$contentLength dest=$destinationUri"
            )

            if (status == HttpURLConnection.HTTP_UNAUTHORIZED || status == HttpURLConnection.HTTP_FORBIDDEN) {
                throw IOException("Server refused the download: HTTP $status.")
            }
            if (status == HttpURLConnection.HTTP_NOT_FOUND) {
                throw IOException("File was not found on the Sarah server: HTTP 404.")
            }
            if (status !in 200..299) {
                throw IOException("Sarah server returned HTTP $status.")
            }

            val input = connection.inputStream ?: throw IOException("Sarah server returned no response body.")
            val output = contentResolver.openOutputStream(destinationUri, "w")
                ?: throw IOException("Could not open the selected save location.")

            input.use { source ->
                output.use { target ->
                    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                    var lastNotifyAt = 0L
                    while (true) {
                        val read = source.read(buffer)
                        if (read < 0) break
                        target.write(buffer, 0, read)
                        bytesWritten += read.toLong()

                        val now = System.currentTimeMillis()
                        if (now - lastNotifyAt > 500L) {
                            lastNotifyAt = now
                            notificationManager.notify(
                                notificationId,
                                progressNotification(
                                    filename = filename,
                                    text = progressText(bytesWritten, contentLength),
                                    bytes = bytesWritten,
                                    total = contentLength,
                                    indeterminate = contentLength <= 0L,
                                    downloadId = downloadId
                                )
                            )
                        }
                    }
                    target.flush()
                }
            }

            if (contentLength > 0L && bytesWritten != contentLength) {
                throw IOException("Download was incomplete: saved ${formatBytes(bytesWritten)} of ${formatBytes(contentLength)}.")
            }
            if (bytesWritten <= 0L) {
                throw IOException("Download completed with no saved bytes.")
            }

            val elapsed = System.currentTimeMillis() - startedAt
            Log.i(
                TAG,
                "download complete url=${redactUrl(url)} type=$responseType length=$contentLength bytes=$bytesWritten elapsedMs=$elapsed dest=$destinationUri"
            )
            showTerminalNotification(
                notificationId,
                filename,
                "Download complete",
                "${formatBytes(bytesWritten)} saved",
                destinationUri,
                responseType.ifBlank { mimeType }
            )
        } catch (error: Exception) {
            val elapsed = System.currentTimeMillis() - startedAt
            Log.e(
                TAG,
                "download failed url=${redactUrl(url)} bytes=$bytesWritten elapsedMs=$elapsed dest=$destinationUri ${error.javaClass.simpleName}: ${error.message}",
                error
            )
            clearPartialDestination(destinationUri)
            throw error
        } finally {
            connection.disconnect()
        }
    }

    private fun clearPartialDestination(destinationUri: Uri) {
        try {
            contentResolver.openOutputStream(destinationUri, "wt")?.use { target ->
                target.flush()
            }
        } catch (clearError: Exception) {
            Log.w(TAG, "Could not clear incomplete download dest=$destinationUri ${clearError.javaClass.simpleName}: ${clearError.message}")
        }
    }

    private fun fail(
        notificationId: Int,
        filename: String,
        mimeType: String,
        destinationUri: Uri?,
        message: String,
        startedAt: Long
    ) {
        Log.e(TAG, "download failed final filename=$filename dest=$destinationUri elapsedMs=${System.currentTimeMillis() - startedAt} error=$message")
        showTerminalNotification(notificationId, filename, "Download failed", message, null, mimeType)
    }

    private fun progressNotification(
        filename: String,
        text: String,
        bytes: Long,
        total: Long,
        indeterminate: Boolean,
        downloadId: String
    ) = NotificationCompat.Builder(this, CHANNEL_ID)
        .setSmallIcon(android.R.drawable.stat_sys_download)
        .setContentTitle(filename)
        .setContentText(text)
        .setStyle(NotificationCompat.BigTextStyle().bigText(text))
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setCategory(NotificationCompat.CATEGORY_PROGRESS)
        .setProgress(100, percent(bytes, total), indeterminate)
        .addAction(0, "Cancel", cancelIntent(downloadId, filename))
        .build()

    private fun showTerminalNotification(
        notificationId: Int,
        filename: String,
        title: String,
        text: String,
        uri: Uri?,
        mimeType: String
    ) {
        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(
                if (title.contains("failed", ignoreCase = true)) android.R.drawable.stat_notify_error
                else android.R.drawable.stat_sys_download_done
            )
            .setContentTitle("$title: $filename")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setOngoing(false)
            .setAutoCancel(true)
            .setProgress(0, 0, false)

        openIntent(uri, mimeType)?.let { builder.setContentIntent(it).addAction(0, "Open", it) }
        notificationManager.notify(notificationId, builder.build())
    }

    private fun cancelIntent(downloadId: String, filename: String): PendingIntent {
        val intent = Intent(this, SarahDownloadService::class.java).apply {
            action = ACTION_CANCEL
            putExtra(EXTRA_DOWNLOAD_ID, downloadId)
            putExtra(EXTRA_FILENAME, filename)
        }
        return PendingIntent.getService(
            this,
            notificationId("$downloadId-cancel"),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun openIntent(uri: Uri?, mimeType: String): PendingIntent? {
        if (uri == null) return null
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, mimeType.ifBlank { "application/octet-stream" })
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        return PendingIntent.getActivity(
            this,
            notificationId(uri.toString()),
            Intent.createChooser(intent, "Open Sarah download"),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            CHANNEL_NAME,
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Progress and completion notifications for Sarah MP3 and MP4 downloads."
        }
        notificationManager.createNotificationChannel(channel)
    }

    private fun headersFromJson(json: String): Map<String, String> {
        if (json.isBlank()) return emptyMap()
        val parsed = JSONObject(json)
        val headers = mutableMapOf<String, String>()
        val keys = parsed.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            val value = parsed.optString(key)
            if (key.isNotBlank() && value.isNotBlank()) headers[key] = value
        }
        return headers
    }

    private fun progressText(bytes: Long, total: Long): String {
        if (total > 0L) return "${formatBytes(bytes)} / ${formatBytes(total)} (${percent(bytes, total)}%)"
        return "${formatBytes(bytes)} downloaded"
    }

    private fun percent(bytes: Long, total: Long): Int {
        if (total <= 0L) return 0
        return max(0, ((bytes * 100L) / total).coerceAtMost(100L).toInt())
    }

    private fun formatBytes(value: Long): String {
        val mb = value.toDouble() / 1024.0 / 1024.0
        if (mb >= 1.0) return String.format("%.1f MB", mb)
        val kb = value.toDouble() / 1024.0
        return String.format("%.0f KB", kb)
    }

    private fun notificationId(value: String): Int = value.hashCode().let {
        if (it == Int.MIN_VALUE) 1 else kotlin.math.abs(it)
    }

    private fun redactUrl(url: String): String {
        return url
            .replace(Regex("([?&](?:token|key|authorization|auth|signature|sig)=)[^&]+", RegexOption.IGNORE_CASE), "$1REDACTED")
            .replace(Regex("(Bearer\\s+)[^&\\s]+", RegexOption.IGNORE_CASE), "$1REDACTED")
    }
}
