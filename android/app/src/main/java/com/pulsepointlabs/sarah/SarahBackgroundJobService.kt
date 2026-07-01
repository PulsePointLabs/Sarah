package com.pulsepointlabs.sarah

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import android.webkit.CookieManager
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.abs
import kotlin.math.max

class SarahBackgroundJobService : Service() {
    companion object {
        const val ACTION_TRACK = "com.pulsepointlabs.sarah.jobs.TRACK"
        const val ACTION_SUBMIT = "com.pulsepointlabs.sarah.jobs.SUBMIT"
        const val ACTION_CANCEL_JOB = "com.pulsepointlabs.sarah.jobs.CANCEL"
        const val ACTION_RETRY_JOB = "com.pulsepointlabs.sarah.jobs.RETRY"

        const val EXTRA_JOB_ID = "jobId"
        const val EXTRA_SUBMISSION_ID = "submissionId"
        const val EXTRA_PAYLOAD_FILE = "payloadFile"
        const val EXTRA_REQUEST_PATH = "requestPath"
        const val EXTRA_API_BASE = "apiBase"
        const val EXTRA_TITLE = "title"
        const val EXTRA_ROUTE = "route"
        const val EXTRA_HEADERS_JSON = "headersJson"

        private const val TAG = "SarahJobService"
        private const val CHANNEL_ID = "sarah_background_work"
        private const val CHANNEL_NAME = "Sarah background work"
        private const val POLL_INTERVAL_MS = 2_500L
    }

    private data class TrackedJob(
        val id: String,
        val apiBase: String,
        val title: String,
        val route: String,
        val headers: Map<String, String>,
        val trackedAt: Long = System.currentTimeMillis(),
        var lastCurrent: Double = 0.0,
        var lastProgressAt: Long = System.currentTimeMillis(),
        var secondsPerUnit: Double? = null,
    )

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val monitors = ConcurrentHashMap<String, Job>()
    private val configs = ConcurrentHashMap<String, TrackedJob>()
    private lateinit var notificationManager: NotificationManager

    override fun onCreate() {
        super.onCreate()
        notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        ensureChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val config = configFromIntent(intent)
        when (intent?.action) {
            ACTION_SUBMIT -> submitPayload(intent, startId)
            ACTION_TRACK -> if (config != null) startTracking(config, startId)
            ACTION_CANCEL_JOB -> if (config != null) performAction(config, "cancel", startId)
            ACTION_RETRY_JOB -> if (config != null) performAction(config, "retry", startId)
        }
        return START_REDELIVER_INTENT
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun submitPayload(intent: Intent, startId: Int) {
        val submissionId = intent.getStringExtra(EXTRA_SUBMISSION_ID).orEmpty()
        val apiBase = intent.getStringExtra(EXTRA_API_BASE).orEmpty().trimEnd('/')
        val requestPath = intent.getStringExtra(EXTRA_REQUEST_PATH).orEmpty()
        val payloadFile = File(intent.getStringExtra(EXTRA_PAYLOAD_FILE).orEmpty())
        val title = intent.getStringExtra(EXTRA_TITLE).orEmpty().ifBlank { "Sarah background task" }
        val route = intent.getStringExtra(EXTRA_ROUTE).orEmpty().ifBlank { "/settings" }
        val headers = headersFromJson(intent.getStringExtra(EXTRA_HEADERS_JSON).orEmpty())
        if (submissionId.isBlank() || apiBase.isBlank() || requestPath.isBlank() || !payloadFile.isFile) {
            stopSelf(startId)
            return
        }

        val pendingConfig = TrackedJob(submissionId, apiBase, title, route, headers)
        val notification = progressNotification(pendingConfig, "Sending request to desktop", 0.0, 0.0, null, true)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(notificationId(submissionId), notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(notificationId(submissionId), notification)
        }

        monitors[submissionId] = scope.launch {
            try {
                val response = postJsonFile("$apiBase$requestPath", payloadFile, headers)
                val jobId = response.optString("id")
                if (jobId.isBlank()) throw IOException("Sarah desktop accepted the request without returning a job ID.")
                payloadFile.delete()
                notificationManager.cancel(notificationId(submissionId))
                monitors.remove(submissionId)
                startTracking(TrackedJob(jobId, apiBase, title, route, headers), startId)
            } catch (error: Exception) {
                Log.e(TAG, "submission failed id=$submissionId ${error.javaClass.simpleName}: ${error.message}")
                terminalNotification(pendingConfig, "Submission failed", specificNetworkError(error), false)
                finishMonitor(submissionId, startId)
            }
        }
    }

    private fun startTracking(config: TrackedJob, startId: Int) {
        configs[config.id] = config
        val notification = progressNotification(config, "Queued", 0.0, 0.0, null, true)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(notificationId(config.id), notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(notificationId(config.id), notification)
        }
        monitors.remove(config.id)?.cancel()
        monitors[config.id] = scope.launch { monitor(config, startId) }
    }

    private fun performAction(config: TrackedJob, actionName: String, startId: Int) {
        configs[config.id] = config
        val notification = progressNotification(config, if (actionName == "retry") "Retrying" else "Cancelling", 0.0, 0.0, null, true)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(notificationId(config.id), notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(notificationId(config.id), notification)
        }
        monitors.remove(config.id)?.cancel()
        monitors[config.id] = scope.launch {
            try {
                postJobAction(config, actionName)
                if (actionName == "retry") monitor(config, startId) else finishMonitor(config.id, startId)
            } catch (error: Exception) {
                terminalNotification(config, "Action failed", specificNetworkError(error), true)
                finishMonitor(config.id, startId)
            }
        }
    }

    private suspend fun monitor(config: TrackedJob, startId: Int) {
        var consecutiveFailures = 0
        try {
            while (true) {
                try {
                    val job = requestJson("${config.apiBase}/jobs/${config.id}", "GET", config.headers)
                    consecutiveFailures = 0
                    val status = job.optString("status", "running")
                    val progress = job.optJSONObject("progress") ?: JSONObject()
                    val current = progress.optDouble("current", 0.0).takeIf { it.isFinite() } ?: 0.0
                    val total = progress.optDouble("total", 0.0).takeIf { it.isFinite() } ?: 0.0
                    updateRate(config, current)
                    val etaSeconds = explicitEta(progress) ?: calculatedEta(config, current, total)
                    val message = progress.optString("message").ifBlank { status.replaceFirstChar { it.uppercase() } }

                    when (status) {
                        "complete" -> {
                            terminalNotification(config, "Complete", message, false)
                            break
                        }
                        "error" -> {
                            val error = job.optString("error").ifBlank { message }
                            terminalNotification(config, "Failed", error, true)
                            break
                        }
                        "cancelled" -> {
                            terminalNotification(config, "Cancelled", message, false)
                            break
                        }
                        else -> notificationManager.notify(
                            notificationId(config.id),
                            progressNotification(config, message, current, total, etaSeconds, total <= 0.0)
                        )
                    }
                } catch (error: Exception) {
                    consecutiveFailures += 1
                    val detail = if (consecutiveFailures == 1) {
                        "Desktop temporarily unreachable; retrying"
                    } else {
                        "Desktop unreachable (${consecutiveFailures} attempts); retrying"
                    }
                    notificationManager.notify(
                        notificationId(config.id),
                        progressNotification(config, detail, 0.0, 0.0, null, true)
                    )
                    Log.w(TAG, "poll failed job=${config.id} ${error.javaClass.simpleName}: ${error.message}")
                }
                delay(POLL_INTERVAL_MS)
            }
        } catch (_: CancellationException) {
            // Replaced by a notification action or a newer tracker for this job.
        } finally {
            finishMonitor(config.id, startId)
        }
    }

    private fun updateRate(config: TrackedJob, current: Double) {
        if (current <= config.lastCurrent) return
        val now = System.currentTimeMillis()
        val elapsedSeconds = max(0.1, (now - config.lastProgressAt) / 1000.0)
        val units = current - config.lastCurrent
        val observed = elapsedSeconds / units
        config.secondsPerUnit = config.secondsPerUnit?.let { previous -> previous * 0.65 + observed * 0.35 } ?: observed
        config.lastCurrent = current
        config.lastProgressAt = now
    }

    private fun calculatedEta(config: TrackedJob, current: Double, total: Double): Long? {
        if (total <= current || current <= 0.0) return null
        return config.secondsPerUnit?.let { max(0L, ((total - current) * it).toLong()) }
    }

    private fun explicitEta(progress: JSONObject): Long? {
        for (key in listOf("eta_seconds", "estimated_remaining_seconds", "remaining_seconds")) {
            if (progress.has(key)) return progress.optLong(key).takeIf { it >= 0L }
        }
        return null
    }

    private fun progressNotification(
        config: TrackedJob,
        message: String,
        current: Double,
        total: Double,
        etaSeconds: Long?,
        indeterminate: Boolean,
    ): android.app.Notification {
        val percent = if (total > 0.0) ((current / total) * 100.0).toInt().coerceIn(0, 100) else 0
        val detail = buildString {
            append(message)
            if (total > 0.0) append(" · ${current.toInt()}/${total.toInt()} · $percent%")
            if (etaSeconds != null) append(" · ${formatEta(etaSeconds)} left")
        }
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle(config.title)
            .setContentText(detail)
            .setStyle(NotificationCompat.BigTextStyle().bigText(detail))
            .setContentIntent(openAppIntent(config))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setProgress(100, percent, indeterminate)
            .addAction(0, "Cancel", actionIntent(config, ACTION_CANCEL_JOB))
            .build()
    }

    private fun terminalNotification(config: TrackedJob, state: String, message: String, retryable: Boolean) {
        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(if (retryable) android.R.drawable.stat_notify_error else android.R.drawable.stat_sys_download_done)
            .setContentTitle("${config.title}: $state")
            .setContentText(message)
            .setStyle(NotificationCompat.BigTextStyle().bigText(message))
            .setContentIntent(openAppIntent(config))
            .setAutoCancel(true)
            .setOngoing(false)
            .setProgress(0, 0, false)
            .addAction(0, "Open", openAppIntent(config))
        if (retryable) builder.addAction(0, "Retry", actionIntent(config, ACTION_RETRY_JOB))
        notificationManager.notify(notificationId(config.id), builder.build())
    }

    private fun openAppIntent(config: TrackedJob): PendingIntent {
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(EXTRA_ROUTE, config.route)
        }
        return PendingIntent.getActivity(
            this,
            notificationId("${config.id}-open"),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun actionIntent(config: TrackedJob, actionName: String): PendingIntent {
        val intent = Intent(this, SarahBackgroundJobService::class.java).apply {
            action = actionName
            putExtra(EXTRA_JOB_ID, config.id)
            putExtra(EXTRA_API_BASE, config.apiBase)
            putExtra(EXTRA_TITLE, config.title)
            putExtra(EXTRA_ROUTE, config.route)
            putExtra(EXTRA_HEADERS_JSON, JSONObject(config.headers).toString())
        }
        return PendingIntent.getService(
            this,
            notificationId("${config.id}-$actionName"),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun configFromIntent(intent: Intent?): TrackedJob? {
        if (intent == null) return null
        val id = intent.getStringExtra(EXTRA_JOB_ID).orEmpty()
        val apiBase = intent.getStringExtra(EXTRA_API_BASE).orEmpty().trimEnd('/')
        if (id.isBlank() || apiBase.isBlank()) return null
        return configs[id] ?: TrackedJob(
            id = id,
            apiBase = apiBase,
            title = intent.getStringExtra(EXTRA_TITLE).orEmpty().ifBlank { "Sarah background task" },
            route = intent.getStringExtra(EXTRA_ROUTE).orEmpty().ifBlank { "/settings" },
            headers = headersFromJson(intent.getStringExtra(EXTRA_HEADERS_JSON).orEmpty()),
        )
    }

    private fun postJobAction(config: TrackedJob, actionName: String) {
        requestJson("${config.apiBase}/jobs/${config.id}/$actionName", "POST", config.headers)
    }

    private fun requestJson(url: String, method: String, headers: Map<String, String>): JSONObject {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 8_000
            readTimeout = 15_000
            requestMethod = method
            instanceFollowRedirects = true
            if (method == "POST") doOutput = true
            for ((key, value) in headers) setRequestProperty(key, value)
            CookieManager.getInstance().getCookie(url)?.takeIf { it.isNotBlank() }?.let { cookie ->
                if (!headers.keys.any { it.equals("Cookie", true) }) setRequestProperty("Cookie", cookie)
            }
            setRequestProperty("Accept", "application/json")
            if (method == "POST") setRequestProperty("Content-Type", "application/json")
        }
        try {
            if (method == "POST") connection.outputStream.use { it.write("{}".toByteArray()) }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            if (status !in 200..299) throw IOException("Sarah server returned HTTP $status${if (text.isNotBlank()) ": ${text.take(240)}" else "."}")
            if (text.isBlank()) throw IOException("Sarah server returned no job status.")
            return JSONObject(text)
        } finally {
            connection.disconnect()
        }
    }

    private fun postJsonFile(url: String, payloadFile: File, headers: Map<String, String>): JSONObject {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15_000
            readTimeout = 60_000
            requestMethod = "POST"
            instanceFollowRedirects = true
            doOutput = true
            setRequestProperty("Accept", "application/json")
            setRequestProperty("Content-Type", "application/json")
            setFixedLengthStreamingMode(payloadFile.length())
            for ((key, value) in headers) setRequestProperty(key, value)
            CookieManager.getInstance().getCookie(url)?.takeIf { it.isNotBlank() }?.let { cookie ->
                if (!headers.keys.any { it.equals("Cookie", true) }) setRequestProperty("Cookie", cookie)
            }
        }
        try {
            payloadFile.inputStream().use { input ->
                connection.outputStream.use { output -> input.copyTo(output, 64 * 1024) }
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            if (status !in 200..299) throw IOException("Sarah server returned HTTP $status${if (text.isNotBlank()) ": ${text.take(240)}" else "."}")
            if (text.isBlank()) throw IOException("Sarah server returned no job status.")
            return JSONObject(text)
        } finally {
            connection.disconnect()
        }
    }

    private fun finishMonitor(jobId: String, startId: Int) {
        monitors.remove(jobId)
        configs.remove(jobId)
        if (monitors.isEmpty()) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_DETACH)
            else @Suppress("DEPRECATION") stopForeground(false)
            stopSelf(startId)
        }
    }

    private fun specificNetworkError(error: Exception): String = error.message ?: "Could not reach the Sarah desktop API."

    private fun headersFromJson(json: String): Map<String, String> {
        if (json.isBlank()) return emptyMap()
        return try {
            val raw = JSONObject(json)
            raw.keys().asSequence().associateWith { raw.optString(it) }.filterValues { it.isNotBlank() }
        } catch (_: Exception) {
            emptyMap()
        }
    }

    private fun formatEta(seconds: Long): String = when {
        seconds < 60 -> "${seconds}s"
        seconds < 3_600 -> "${seconds / 60}m ${seconds % 60}s"
        else -> "${seconds / 3_600}h ${(seconds % 3_600) / 60}m"
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        notificationManager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_LOW).apply {
                description = "Progress, completion, and failure status for Sarah analysis, audio, and video jobs."
                setShowBadge(false)
            }
        )
    }

    private fun notificationId(value: String): Int = value.hashCode().let { if (it == Int.MIN_VALUE) 1 else abs(it) }
}
