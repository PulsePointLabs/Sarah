package com.pulsepointlabs.sarah

import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "SarahVoiceOverlay")
class SarahVoiceOverlayPlugin : Plugin() {
    private val preferences
        get() = context.getSharedPreferences(SarahVoiceOverlayService.PREFERENCES_NAME, 0)

    @PluginMethod
    fun getState(call: PluginCall) {
        call.resolve(state())
    }

    @PluginMethod
    fun requestPermission(call: PluginCall) {
        if (Settings.canDrawOverlays(context)) {
            call.resolve(state())
            return
        }
        val intent = Intent(
            Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
            Uri.parse("package:${context.packageName}")
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        call.resolve(state().put("permissionScreenOpened", true))
    }

    @PluginMethod
    fun setEnabled(call: PluginCall) {
        saveConfiguration(call)
        val enabled = call.getBoolean("enabled") ?: false
        if (enabled && !Settings.canDrawOverlays(context)) {
            call.reject("Allow Sarah to display over other apps before enabling the floating microphone.")
            return
        }

        preferences.edit().putBoolean(SarahVoiceOverlayService.KEY_ENABLED, enabled).apply()
        val intent = Intent(context, SarahVoiceOverlayService::class.java).apply {
            action = if (enabled) {
                SarahVoiceOverlayService.ACTION_START
            } else {
                SarahVoiceOverlayService.ACTION_STOP
            }
        }
        if (enabled) ContextCompat.startForegroundService(context, intent)
        else context.startService(intent)
        call.resolve(state())
    }

    @PluginMethod
    fun ensureRunning(call: PluginCall) {
        saveConfiguration(call)
        val enabled = preferences.getBoolean(SarahVoiceOverlayService.KEY_ENABLED, false)
        if (enabled && Settings.canDrawOverlays(context)) {
            ContextCompat.startForegroundService(
                context,
                Intent(context, SarahVoiceOverlayService::class.java).apply {
                    action = SarahVoiceOverlayService.ACTION_START
                }
            )
        }
        call.resolve(state())
    }

    @PluginMethod
    fun configure(call: PluginCall) {
        saveConfiguration(call)
        call.resolve(state())
    }

    private fun saveConfiguration(call: PluginCall) {
        val editor = preferences.edit()
        call.getString("apiBase")?.trim()?.trimEnd('/')?.takeIf { it.isNotBlank() }?.let {
            editor.putString(SarahVoiceOverlayService.KEY_API_BASE, it)
        }
        call.getString("sttProvider")?.trim()?.takeIf { it.isNotBlank() }?.let {
            editor.putString(SarahVoiceOverlayService.KEY_STT_PROVIDER, it)
        }
        call.getString("personalitySettings")?.takeIf { it.isNotBlank() }?.let {
            editor.putString(SarahVoiceOverlayService.KEY_PERSONALITY_SETTINGS, it)
        }
        call.getString("intimateChatSettings")?.takeIf { it.isNotBlank() }?.let {
            editor.putString(SarahVoiceOverlayService.KEY_INTIMATE_CHAT_SETTINGS, it)
        }
        call.getString("ttsSettings")?.takeIf { it.isNotBlank() }?.let {
            editor.putString(SarahVoiceOverlayService.KEY_TTS_SETTINGS, it)
        }
        editor.apply()
    }

    private fun state(): JSObject {
        val permitted = Settings.canDrawOverlays(context)
        return JSObject()
            .put("native", true)
            .put("permissionGranted", permitted)
            .put(
                "enabled",
                permitted && preferences.getBoolean(SarahVoiceOverlayService.KEY_ENABLED, false)
            )
            .put("serviceState", preferences.getString(SarahVoiceOverlayService.KEY_STATE, "idle"))
            .put("lastError", preferences.getString(SarahVoiceOverlayService.KEY_LAST_ERROR, ""))
            .put("lastTranscript", preferences.getString(SarahVoiceOverlayService.KEY_LAST_TRANSCRIPT, ""))
    }
}
