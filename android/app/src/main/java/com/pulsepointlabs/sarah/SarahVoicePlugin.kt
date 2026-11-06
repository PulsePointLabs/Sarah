package com.pulsepointlabs.sarah

import android.Manifest
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
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
    private var tts: TextToSpeech? = null
    private var ttsReady = false

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
        tts?.stop()
        call.resolve()
    }

    @PluginMethod
    fun cue(call: PluginCall) = activity.runOnUiThread {
        if (visible && wanted) playTone(ToneGenerator.TONE_PROP_BEEP)
        call.resolve()
    }

    @PluginMethod
    fun acknowledge(call: PluginCall) = activity.runOnUiThread {
        if (visible && wanted) {
            val phrase = if (call.getBoolean("command") == true) "Command heard" else "Note saved"
            if (!ttsReady || tts?.speak(phrase, TextToSpeech.QUEUE_FLUSH, null, phrase) != TextToSpeech.SUCCESS) {
                playTone(ToneGenerator.TONE_PROP_ACK)
            }
        }
        call.resolve()
    }

    private fun playTone(type: Int) {
        releaseTone()
        try {
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
        if (wanted) listen()
    }

    override fun handleOnStop() {
        visible = false
        releaseSpeech()
        releaseTone()
        tts?.stop()
        if (wanted) emit("suspended")
    }

    override fun handleOnDestroy() {
        destroyed = true
        wanted = false
        releaseSpeech()
        releaseTone()
        tts?.shutdown()
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
            val started = service.startListening(object : RecognitionListener {
                override fun onPartialResult(hypothesis: String?) {}
                override fun onFinalResult(hypothesis: String?) {}
                override fun onResult(hypothesis: String?) {
                    if (speech !== service) return
                    val transcript = runCatching { JSONObject(hypothesis.orEmpty()).optString("text").trim() }.getOrDefault("")
                    if (transcript.isNotEmpty()) emit("recognized", "transcript", transcript)
                }
                override fun onError(exception: Exception?) {
                    if (speech === service) fail("Wake lost access to the microphone. Check microphone access and try again.")
                }
                override fun onTimeout() {
                    if (speech === service) fail("Wake listening stopped. Select Enable Wake to restart it.")
                }
            })
            if (!started) {
                fail("Could not start continuous microphone capture.")
                return
            }
            if (tts == null) tts = TextToSpeech(context) { result ->
                main.post {
                    if (destroyed || result != TextToSpeech.SUCCESS) return@post
                    ttsReady = tts?.voices.orEmpty().firstOrNull {
                        it.locale.language == "en" && !it.isNetworkConnectionRequired
                    }?.let { tts?.setVoice(it) == TextToSpeech.SUCCESS } ?: false
                }
            }
            emit("ready")
        } catch (_: Exception) {
            fail("Could not start continuous microphone capture. Check microphone access and try again.")
        }
    }

    private fun fail(message: String) {
        wanted = false
        releaseSpeech()
        emit("error", "message", message)
    }

    private fun releaseSpeech() {
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
