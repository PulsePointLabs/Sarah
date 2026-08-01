package com.pulsepointlabs.sarah

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.res.ColorStateList
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.media.ToneGenerator
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.util.Base64
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.view.animation.AlphaAnimation
import android.view.animation.Animation
import android.view.animation.AnimationSet
import android.view.animation.LinearInterpolator
import android.view.animation.RotateAnimation
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.abs
import kotlin.math.sqrt

class SarahVoiceOverlayService : Service() {
    private enum class OverlayState { IDLE, RECORDING, PROCESSING, SPEAKING, ERROR }

    private val mainHandler = Handler(Looper.getMainLooper())
    private val stopRecordingRequested = AtomicBoolean(false)
    private var windowManager: WindowManager? = null
    private var overlayRoot: LinearLayout? = null
    private var bubble: ImageButton? = null
    private var thinkingSpinner: ProgressBar? = null
    private var thinkingStatus: TextView? = null
    private var audioRecord: AudioRecord? = null
    private var mediaPlayer: MediaPlayer? = null
    private var state = OverlayState.IDLE
    private var processingStartedAt = 0L
    private val processingTicker = object : Runnable {
        override fun run() {
            if (state != OverlayState.PROCESSING) return
            val elapsed = ((System.currentTimeMillis() - processingStartedAt) / 1_000L).coerceAtLeast(0L)
            val dots = ".".repeat(((elapsed % 3L) + 1L).toInt())
            thinkingStatus?.text = "Sarah is thinking$dots\n${elapsed}s elapsed"
            mainHandler.postDelayed(this, 500L)
        }
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            preferences().edit().putBoolean(KEY_ENABLED, false).apply()
            stopEverything()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        if (!Settings.canDrawOverlays(this)) {
            stopSelf()
            return START_NOT_STICKY
        }
        startForeground(NOTIFICATION_ID, buildNotification())
        showOverlay()
        return START_NOT_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        stopEverything()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        stopEverything()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun showOverlay() {
        if (bubble != null) return
        val manager = getSystemService(WINDOW_SERVICE) as WindowManager
        windowManager = manager
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            dp(66),
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = preferences().getInt(KEY_X, dp(14))
            y = preferences().getInt(KEY_Y, dp(220))
        }
        val button = ImageButton(this).apply {
            contentDescription = "Talk with Sarah"
            elevation = dp(8).toFloat()
            setPadding(dp(16), dp(16), dp(16), dp(16))
            isClickable = false
            isFocusable = false
        }
        val spinner = ProgressBar(this).apply {
            isIndeterminate = true
            indeterminateTintList = ColorStateList.valueOf(Color.WHITE)
            visibility = View.GONE
        }
        val bubbleFrame = FrameLayout(this).apply {
            addView(button, FrameLayout.LayoutParams(dp(66), dp(66)))
            addView(spinner, FrameLayout.LayoutParams(dp(42), dp(42), Gravity.CENTER))
        }
        val status = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 13f
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            setPadding(dp(12), dp(7), dp(12), dp(7))
            background = GradientDrawable().apply {
                cornerRadius = dp(14).toFloat()
                setColor(Color.argb(232, 21, 31, 47))
                setStroke(dp(1), Color.argb(180, 255, 255, 255))
            }
            visibility = View.GONE
        }
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(bubbleFrame, LinearLayout.LayoutParams(dp(66), dp(66)))
            addView(
                status,
                LinearLayout.LayoutParams(
                    WindowManager.LayoutParams.WRAP_CONTENT,
                    WindowManager.LayoutParams.WRAP_CONTENT,
                ).apply { marginStart = dp(7) },
            )
        }
        installDragAndTap(root, params)
        overlayRoot = root
        bubble = button
        thinkingSpinner = spinner
        thinkingStatus = status
        applyState(OverlayState.IDLE)
        manager.addView(root, params)
    }

    private fun installDragAndTap(view: View, params: WindowManager.LayoutParams) {
        var initialX = 0
        var initialY = 0
        var downX = 0f
        var downY = 0f
        view.setOnTouchListener { _, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    initialX = params.x
                    initialY = params.y
                    downX = event.rawX
                    downY = event.rawY
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    params.x = initialX + (event.rawX - downX).toInt()
                    params.y = initialY + (event.rawY - downY).toInt()
                    windowManager?.updateViewLayout(view, params)
                    true
                }
                MotionEvent.ACTION_UP -> {
                    val moved = abs(event.rawX - downX) > dp(8) || abs(event.rawY - downY) > dp(8)
                    if (moved) {
                        preferences().edit().putInt(KEY_X, params.x).putInt(KEY_Y, params.y).apply()
                    } else {
                        handleBubbleTap()
                    }
                    true
                }
                else -> false
            }
        }
    }

    private fun handleBubbleTap() {
        when (state) {
            OverlayState.IDLE, OverlayState.ERROR -> startRecording()
            OverlayState.RECORDING -> stopRecordingRequested.set(true)
            OverlayState.PROCESSING -> Unit
            OverlayState.SPEAKING -> {
                mediaPlayer?.stop()
                mediaPlayer?.release()
                mediaPlayer = null
                applyState(OverlayState.IDLE)
            }
        }
    }

    private fun startRecording() {
        if (ActivityCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            fail("Microphone permission is not granted. Open Sarah once and allow microphone access.")
            return
        }
        if (preferences().getString(KEY_API_BASE, "").orEmpty().isBlank()) {
            fail("Sarah desktop API is not configured. Open Sarah once while connected to the desktop.")
            return
        }

        val sampleRate = 16_000
        val minBuffer = AudioRecord.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        if (minBuffer <= 0) {
            fail("Android could not initialize the microphone buffer.")
            return
        }
        val recorder = AudioRecord(
            MediaRecorder.AudioSource.VOICE_RECOGNITION,
            sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            minBuffer * 2,
        )
        if (recorder.state != AudioRecord.STATE_INITIALIZED) {
            recorder.release()
            fail("Android could not initialize microphone recording.")
            return
        }

        stopRecordingRequested.set(false)
        audioRecord = recorder
        playTone(ToneGenerator.TONE_PROP_BEEP, 120)
        applyState(OverlayState.RECORDING)
        recorder.startRecording()
        Thread {
            captureUntilPause(recorder, sampleRate, minBuffer * 2)
        }.apply {
            name = "SarahVoiceOverlayRecorder"
            start()
        }
    }

    private fun captureUntilPause(recorder: AudioRecord, sampleRate: Int, bufferSize: Int) {
        val output = ByteArrayOutputStream()
        val samples = ShortArray(bufferSize / 2)
        val startedAt = System.currentTimeMillis()
        var silenceStartedAt = 0L
        var speechDetected = false
        var noiseFloor = Double.POSITIVE_INFINITY
        var aboveThresholdFrames = 0
        var readError: String? = null
        try {
            while (!stopRecordingRequested.get()) {
                val count = recorder.read(samples, 0, samples.size)
                if (count <= 0) {
                    readError = "Android microphone read failed ($count)."
                    break
                }
                val bytes = ByteBuffer.allocate(count * 2).order(ByteOrder.LITTLE_ENDIAN)
                var energy = 0.0
                for (index in 0 until count) {
                    val sample = samples[index]
                    bytes.putShort(sample)
                    energy += sample.toDouble() * sample.toDouble()
                }
                output.write(bytes.array())
                val rms = sqrt(energy / count)
                val now = System.currentTimeMillis()
                if (!speechDetected && now - startedAt < VAD_CALIBRATION_MS) {
                    // The start tone can leak into the first frame, so calibrate from the
                    // quietest ambient frame rather than averaging that tone into the floor.
                    noiseFloor = minOf(noiseFloor, rms)
                    continue
                }
                if (!noiseFloor.isFinite()) noiseFloor = 250.0
                val speechThreshold = maxOf(VAD_MIN_SPEECH_RMS, noiseFloor * VAD_SPEECH_MULTIPLIER)
                val silenceThreshold = maxOf(VAD_MIN_SILENCE_RMS, noiseFloor * VAD_SILENCE_MULTIPLIER)
                if (!speechDetected) {
                    if (rms >= speechThreshold) {
                        aboveThresholdFrames += 1
                        if (aboveThresholdFrames >= VAD_SPEECH_CONFIRM_FRAMES) {
                            speechDetected = true
                            silenceStartedAt = 0L
                        }
                    } else {
                        aboveThresholdFrames = 0
                        noiseFloor = (noiseFloor * 0.96) + (rms * 0.04)
                    }
                } else if (rms <= silenceThreshold) {
                    if (silenceStartedAt == 0L) silenceStartedAt = now
                } else if (rms >= speechThreshold) {
                    silenceStartedAt = 0L
                }
                if (
                    speechDetected
                    && silenceStartedAt > 0L
                    && now - startedAt >= MIN_RECORDING_MS
                    && now - silenceStartedAt >= SILENCE_STOP_MS
                ) break
                if (!speechDetected && now - startedAt >= INITIAL_SILENCE_TIMEOUT_MS) break
                if (now - startedAt >= MAX_RECORDING_MS) break
            }
        } catch (error: Exception) {
            readError = error.message ?: error.javaClass.simpleName
        } finally {
            runCatching { recorder.stop() }
            recorder.release()
            audioRecord = null
        }

        val pcm = output.toByteArray()
        mainHandler.post {
            playTone(ToneGenerator.TONE_PROP_ACK, 150)
            when {
                readError != null -> fail(readError)
                !speechDetected || pcm.size < 3_200 -> fail("No clear speech was detected. Tap and try again.")
                else -> {
                    applyState(OverlayState.PROCESSING)
                    submitTurn(wavFromPcm(pcm, sampleRate))
                }
            }
        }
    }

    private fun submitTurn(wavBytes: ByteArray) {
        val requestId = UUID.randomUUID().toString()
        Thread {
            try {
                val prefs = preferences()
                val apiBase = prefs.getString(KEY_API_BASE, "").orEmpty().trimEnd('/')
                val payload = JSONObject()
                    .put("request_id", requestId)
                    .put("audio_base64", Base64.encodeToString(wavBytes, Base64.NO_WRAP))
                    .put("mime_type", "audio/wav")
                    .put("stt_provider", prefs.getString(KEY_STT_PROVIDER, "auto") ?: "auto")
                parseJsonPreference(KEY_PERSONALITY_SETTINGS)?.let { payload.put("personality_settings", it) }
                parseJsonPreference(KEY_INTIMATE_CHAT_SETTINGS)?.let { payload.put("intimate_chat_settings", it) }
                parseJsonPreference(KEY_TTS_SETTINGS)?.let { payload.put("tts_settings", it) }
                val response = postJson("$apiBase/voice-overlay/turn", payload)
                preferences().edit()
                    .putString(KEY_LAST_TRANSCRIPT, response.optString("transcript"))
                    .putString(KEY_LAST_REPLY, response.optString("reply"))
                    .remove(KEY_LAST_ERROR)
                    .apply()
                val segments = response.optJSONArray("audio_segments")
                val queuedAudio = mutableListOf<Pair<ByteArray, String>>()
                if (segments != null) {
                    for (index in 0 until segments.length()) {
                        val segment = segments.optJSONObject(index) ?: continue
                        val encoded = segment.optString("audio_base64")
                        if (encoded.isBlank()) continue
                        queuedAudio.add(
                            Base64.decode(encoded, Base64.DEFAULT) to
                                segment.optString("audio_mime_type", "audio/mpeg"),
                        )
                    }
                }
                if (queuedAudio.isEmpty()) {
                    queuedAudio.add(
                        Base64.decode(response.getString("audio_base64"), Base64.DEFAULT) to
                            response.optString("audio_mime_type", "audio/mpeg"),
                    )
                }
                mainHandler.post { playResponseQueue(queuedAudio) }
            } catch (error: Exception) {
                mainHandler.post { fail(error.message ?: "Sarah voice response failed.") }
            }
        }.apply {
            name = "SarahVoiceOverlayTurn"
            start()
        }
    }

    private fun postJson(url: String, payload: JSONObject): JSONObject {
        val connection = URL(url).openConnection() as HttpURLConnection
        return try {
            connection.requestMethod = "POST"
            connection.connectTimeout = 15_000
            connection.readTimeout = 150_000
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.outputStream.use { it.write(payload.toString().toByteArray(Charsets.UTF_8)) }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val body = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            val json = runCatching { JSONObject(body) }.getOrElse {
                throw IllegalStateException("Sarah returned HTTP $status without a readable response.")
            }
            if (status !in 200..299) {
                val providerError = json.optJSONObject("provider_error")
                val detail = providerError?.optString("user_message").orEmpty()
                    .ifBlank { json.optString("error", "Sarah returned HTTP $status.") }
                val stage = json.optString("stage").replaceFirstChar { it.uppercase() }
                throw IllegalStateException(if (stage.isBlank()) detail else "$stage: $detail")
            }
            json
        } finally {
            connection.disconnect()
        }
    }

    private fun playResponseQueue(segments: List<Pair<ByteArray, String>>, index: Int = 0) {
        if (index >= segments.size) {
            applyState(OverlayState.IDLE)
            return
        }
        val (audioBytes, mimeType) = segments[index]
        val extension = if (mimeType.contains("wav")) "wav" else "mp3"
        val audioFile = File(cacheDir, "voice-overlay-${UUID.randomUUID()}.$extension")
        FileOutputStream(audioFile).use { it.write(audioBytes) }
        mediaPlayer?.release()
        mediaPlayer = MediaPlayer().apply {
            setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            setDataSource(audioFile.absolutePath)
            setOnPreparedListener {
                applyState(OverlayState.SPEAKING)
                it.start()
            }
            setOnCompletionListener {
                it.release()
                mediaPlayer = null
                audioFile.delete()
                playResponseQueue(segments, index + 1)
            }
            setOnErrorListener { player, _, _ ->
                player.release()
                mediaPlayer = null
                audioFile.delete()
                fail("Sarah's response was saved, but Android could not play the audio.")
                true
            }
            prepareAsync()
        }
    }

    private fun applyState(next: OverlayState) {
        state = next
        preferences().edit().putString(KEY_STATE, next.name.lowercase()).apply()
        mainHandler.removeCallbacks(processingTicker)
        thinkingSpinner?.visibility = if (next == OverlayState.PROCESSING) View.VISIBLE else View.GONE
        thinkingStatus?.visibility = if (next == OverlayState.PROCESSING) View.VISIBLE else View.GONE
        if (next == OverlayState.PROCESSING) {
            processingStartedAt = System.currentTimeMillis()
            processingTicker.run()
        }
        bubble?.let { button ->
            button.clearAnimation()
            val (color, icon) = when (next) {
                OverlayState.IDLE -> Color.rgb(151, 71, 220) to android.R.drawable.ic_btn_speak_now
                OverlayState.RECORDING -> Color.rgb(225, 48, 82) to android.R.drawable.ic_media_pause
                OverlayState.PROCESSING -> Color.rgb(38, 174, 214) to android.R.drawable.stat_notify_sync_noanim
                OverlayState.SPEAKING -> Color.rgb(24, 169, 119) to android.R.drawable.ic_lock_silent_mode_off
                OverlayState.ERROR -> Color.rgb(222, 126, 31) to android.R.drawable.stat_notify_error
            }
            if (next == OverlayState.PROCESSING) {
                button.setImageDrawable(null)
            } else {
                button.setImageResource(icon)
            }
            button.setColorFilter(Color.WHITE)
            button.contentDescription = when (next) {
                OverlayState.IDLE -> "Talk with Sarah"
                OverlayState.RECORDING -> "Recording. Tap to stop."
                OverlayState.PROCESSING -> "Sarah is thinking"
                OverlayState.SPEAKING -> "Sarah is speaking. Tap to stop."
                OverlayState.ERROR -> "Voice turn failed. Tap to retry."
            }
            button.background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(color)
                setStroke(dp(if (next == OverlayState.RECORDING) 4 else 2), Color.WHITE)
            }
            if (next == OverlayState.RECORDING) {
                button.startAnimation(AlphaAnimation(1f, 0.55f).apply {
                    duration = 550
                    repeatMode = AlphaAnimation.REVERSE
                    repeatCount = AlphaAnimation.INFINITE
                })
            } else if (next == OverlayState.PROCESSING) {
                button.startAnimation(AnimationSet(true).apply {
                    interpolator = LinearInterpolator()
                    addAnimation(RotateAnimation(
                        0f,
                        360f,
                        Animation.RELATIVE_TO_SELF,
                        0.5f,
                        Animation.RELATIVE_TO_SELF,
                        0.5f,
                    ).apply {
                        duration = 1_250
                        repeatCount = Animation.INFINITE
                    })
                    addAnimation(AlphaAnimation(1f, 0.68f).apply {
                        duration = 625
                        repeatMode = AlphaAnimation.REVERSE
                        repeatCount = Animation.INFINITE
                    })
                })
            }
        }
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification())
    }

    private fun fail(message: String) {
        preferences().edit().putString(KEY_LAST_ERROR, message).apply()
        playTone(ToneGenerator.TONE_PROP_NACK, 220)
        applyState(OverlayState.ERROR)
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
    }

    private fun playTone(tone: Int, durationMs: Int) {
        runCatching {
            ToneGenerator(android.media.AudioManager.STREAM_MUSIC, 70).also { generator ->
                generator.startTone(tone, durationMs)
                mainHandler.postDelayed({ generator.release() }, durationMs.toLong() + 100L)
            }
        }
    }

    private fun wavFromPcm(pcm: ByteArray, sampleRate: Int): ByteArray {
        val output = ByteArrayOutputStream(44 + pcm.size)
        fun ascii(value: String) = output.write(value.toByteArray(Charsets.US_ASCII))
        fun int32(value: Int) = output.write(ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(value).array())
        fun int16(value: Int) = output.write(ByteBuffer.allocate(2).order(ByteOrder.LITTLE_ENDIAN).putShort(value.toShort()).array())
        ascii("RIFF")
        int32(36 + pcm.size)
        ascii("WAVEfmt ")
        int32(16)
        int16(1)
        int16(1)
        int32(sampleRate)
        int32(sampleRate * 2)
        int16(2)
        int16(16)
        ascii("data")
        int32(pcm.size)
        output.write(pcm)
        return output.toByteArray()
    }

    private fun parseJsonPreference(key: String): JSONObject? {
        val raw = preferences().getString(key, "").orEmpty()
        return if (raw.isBlank()) null else runCatching { JSONObject(raw) }.getOrNull()
    }

    private fun stopEverything() {
        mainHandler.removeCallbacks(processingTicker)
        stopRecordingRequested.set(true)
        runCatching { audioRecord?.stop() }
        audioRecord?.release()
        audioRecord = null
        mediaPlayer?.stop()
        mediaPlayer?.release()
        mediaPlayer = null
        overlayRoot?.let { current -> runCatching { windowManager?.removeView(current) } }
        overlayRoot = null
        bubble = null
        thinkingSpinner = null
        thinkingStatus = null
        preferences().edit().putString(KEY_STATE, OverlayState.IDLE.name.lowercase()).apply()
    }

    private fun buildNotification(): android.app.Notification {
        val stateText = when (state) {
            OverlayState.IDLE -> "Tap the bubble to talk with Sarah."
            OverlayState.RECORDING -> "Listening. Pause or tap the bubble to send."
            OverlayState.PROCESSING -> "Sarah is transcribing and responding."
            OverlayState.SPEAKING -> "Sarah is speaking. Tap the bubble to stop."
            OverlayState.ERROR -> preferences().getString(KEY_LAST_ERROR, "Voice turn failed.") ?: "Voice turn failed."
        }
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("Sarah floating conversation")
            .setContentText(stateText)
            .setStyle(NotificationCompat.BigTextStyle().bigText(stateText))
            .setOngoing(true)
            .setContentIntent(
                PendingIntent.getActivity(
                    this,
                    1,
                    Intent(this, MainActivity::class.java),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                ),
            )
            .addAction(
                android.R.drawable.ic_menu_close_clear_cancel,
                "Stop",
                PendingIntent.getService(
                    this,
                    2,
                    Intent(this, SarahVoiceOverlayService::class.java).apply { action = ACTION_STOP },
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                ),
            )
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Sarah floating conversation", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Keeps the optional Chat with Sarah microphone available over other apps."
                setShowBadge(false)
            },
        )
    }

    private fun preferences() = getSharedPreferences(PREFERENCES_NAME, 0)
    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    companion object {
        const val PREFERENCES_NAME = "sarah_voice_overlay"
        const val KEY_ENABLED = "enabled"
        const val KEY_X = "bubble_x"
        const val KEY_Y = "bubble_y"
        const val KEY_API_BASE = "api_base"
        const val KEY_STT_PROVIDER = "stt_provider"
        const val KEY_PERSONALITY_SETTINGS = "personality_settings"
        const val KEY_INTIMATE_CHAT_SETTINGS = "intimate_chat_settings"
        const val KEY_TTS_SETTINGS = "tts_settings"
        const val KEY_STATE = "state"
        const val KEY_LAST_ERROR = "last_error"
        const val KEY_LAST_TRANSCRIPT = "last_transcript"
        const val KEY_LAST_REPLY = "last_reply"
        const val ACTION_START = "com.pulsepointlabs.sarah.voiceoverlay.START"
        const val ACTION_STOP = "com.pulsepointlabs.sarah.voiceoverlay.STOP"
        private const val CHANNEL_ID = "sarah_voice_overlay"
        private const val NOTIFICATION_ID = 9157
        private const val VAD_CALIBRATION_MS = 450L
        private const val VAD_MIN_SPEECH_RMS = 650.0
        private const val VAD_MIN_SILENCE_RMS = 500.0
        private const val VAD_SPEECH_MULTIPLIER = 1.85
        private const val VAD_SILENCE_MULTIPLIER = 1.30
        private const val VAD_SPEECH_CONFIRM_FRAMES = 2
        private const val MIN_RECORDING_MS = 1_200L
        private const val SILENCE_STOP_MS = 3_600L
        private const val INITIAL_SILENCE_TIMEOUT_MS = 12_000L
        private const val MAX_RECORDING_MS = 120_000L
    }
}
