package com.pulsepointlabs.sarah

import android.Manifest
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import org.json.JSONObject
import org.vosk.Model
import org.vosk.Recognizer
import org.vosk.android.RecognitionListener
import org.vosk.android.SpeechService
import org.vosk.android.StorageService

@CapacitorPlugin(name = "SarahVoice", permissions = [
    Permission(alias = "microphone", strings = [Manifest.permission.RECORD_AUDIO])
])
class SarahVoicePlugin : Plugin() {
    private val main = Handler(Looper.getMainLooper())
    private var model: Model? = null
    private var recognizer: Recognizer? = null
    private var speech: SpeechService? = null
    private var loading = false
    private var destroyed = false
    private var visible = false
    private var wanted = false
    private var pendingPermission: PluginCall? = null
    private var tone: ToneGenerator? = null
    private var failures = 0
    private val retry = Runnable { listen() }

    @PluginMethod
    fun start(call: PluginCall) = activity.runOnUiThread {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            enable(call)
        } else if (pendingPermission != null) {
            call.reject("A microphone permission request is already open.")
        } else {
            pendingPermission = call
            requestPermissionForAlias("microphone", call, "microphonePermission")
        }
    }

    @PermissionCallback
    private fun microphonePermission(call: PluginCall) = activity.runOnUiThread {
        if (pendingPermission !== call) return@runOnUiThread
        pendingPermission = null
        if (getPermissionState("microphone") == PermissionState.GRANTED) enable(call)
        else call.reject("Allow Sarah microphone access to use Wake Listening.")
    }

    private fun enable(call: PluginCall) {
        wanted = true
        failures = 0
        call.resolve()
        if (visible) listen() else emit("suspended")
    }

    @PluginMethod
    fun stop(call: PluginCall) = activity.runOnUiThread {
        wanted = false
        pendingPermission?.reject("Wake listening cancelled.")
        pendingPermission = null
        releaseSpeech()
        releaseTone()
        call.resolve()
    }

    @PluginMethod
    fun cue(call: PluginCall) = activity.runOnUiThread {
        if (visible && wanted) playTone(ToneGenerator.TONE_PROP_BEEP)
        call.resolve()
    }

    @PluginMethod
    fun acknowledge(call: PluginCall) = activity.runOnUiThread {
        if (visible && wanted) playTone(ToneGenerator.TONE_PROP_ACK)
        call.resolve()
    }

    private fun playTone(type: Int) {
        releaseTone()
        try {
            // Mix into the media stream without requesting audio focus.
            val player = ToneGenerator(AudioManager.STREAM_MUSIC, 28)
            tone = player
            player.startTone(type, 110)
            main.postDelayed({ if (tone === player) releaseTone() }, 180)
        } catch (_: RuntimeException) {
            releaseTone()
        }
    }

    override fun handleOnStart() {
        visible = true
        failures = 0
        if (wanted) listen()
    }

    override fun handleOnStop() {
        visible = false
        releaseSpeech()
        releaseTone()
        if (wanted) emit("suspended")
    }

    override fun handleOnDestroy() {
        destroyed = true
        wanted = false
        releaseSpeech()
        releaseTone()
        model?.close()
        model = null
    }

    private fun listen() {
        if (!wanted || !visible || speech != null) return
        val loadedModel = model
        if (loadedModel == null) {
            if (loading) return
            loading = true
            StorageService.unpack(context, "model-en-us", "sarah-wake-model", { loaded ->
                loading = false
                if (destroyed) loaded.close() else {
                    model = loaded
                    listen()
                }
            }, {
                loading = false
                if (wanted) fail("Could not load Sarah's offline English speech model.")
            })
            return
        }
        try {
            val decoder = Recognizer(loadedModel, 16000f)
            recognizer = decoder
            val service = SpeechService(decoder, 16000f)
            speech = service
            val startedAt = SystemClock.elapsedRealtime()
            val started = service.startListening(object : RecognitionListener {
                override fun onPartialResult(hypothesis: String?) {}
                override fun onFinalResult(hypothesis: String?) {}
                override fun onResult(hypothesis: String?) {
                    if (speech !== service) return
                    val transcript = runCatching { JSONObject(hypothesis.orEmpty()).optString("text").trim() }.getOrDefault("")
                    if (transcript.isNotEmpty()) emit("recognized", "transcript", transcript)
                }
                override fun onError(exception: Exception?) {
                    if (speech === service) recover(startedAt)
                }
                override fun onTimeout() {
                    if (speech === service) recover(startedAt)
                }
            })
            if (!started) {
                fail("Could not start continuous microphone capture.")
                return
            }
            emit("ready")
        } catch (_: Exception) {
            fail("Could not start continuous microphone capture. Check microphone access and try again.")
        }
    }

    private fun recover(startedAt: Long) {
        if (SystemClock.elapsedRealtime() - startedAt > 15000) failures = 0
        failures++
        if (failures >= 4) {
            fail("Wake lost access to the microphone. Check microphone access and try again.")
            return
        }
        releaseSpeech()
        emit("retrying")
        main.postDelayed(retry, 500L * failures)
    }

    private fun fail(message: String) {
        wanted = false
        releaseSpeech()
        emit("error", "message", message)
    }

    private fun releaseSpeech() {
        main.removeCallbacks(retry)
        val service = speech
        speech = null
        service?.stop()
        service?.shutdown()
        recognizer?.close()
        recognizer = null
    }

    private fun releaseTone() {
        tone?.release()
        tone = null
    }

    private fun emit(type: String, key: String = "state", value: String = type) {
        notifyListeners("speech", JSObject().put("type", type).put(key, value))
    }
}
