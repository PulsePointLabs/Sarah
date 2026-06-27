package com.pulsepointlabs.sarah

import android.content.Intent
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject

@CapacitorPlugin(name = "SarahMedia")
class SarahMediaPlugin : Plugin() {
    @PluginMethod
    fun open(call: PluginCall) {
        val url = call.getString("url")?.trim().orEmpty()
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            call.reject("Native playback requires an HTTP or HTTPS media URL.")
            return
        }
        val headers = mutableMapOf<String, String>()
        call.data.optJSONObject("headers")?.let { raw ->
            val keys = raw.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                val value = raw.optString(key)
                if (key.isNotBlank() && value.isNotBlank()) headers[key] = value
            }
        }
        val title = call.getString("title")?.trim().orEmpty().ifBlank { "Sarah media" }
        val mimeType = call.getString("mimeType")?.trim().orEmpty().ifBlank { "video/mp4" }
        val positionMs = call.getLong("positionMs") ?: 0L
        val headersJson = JSONObject(headers).toString()

        val serviceIntent = Intent(context, SarahPlaybackService::class.java).apply {
            action = SarahPlaybackService.ACTION_PLAY
            putExtra(SarahPlaybackService.EXTRA_URL, url)
            putExtra(SarahPlaybackService.EXTRA_TITLE, title)
            putExtra(SarahPlaybackService.EXTRA_MIME_TYPE, mimeType)
            putExtra(SarahPlaybackService.EXTRA_HEADERS_JSON, headersJson)
            putExtra(SarahPlaybackService.EXTRA_POSITION_MS, positionMs)
        }
        try {
            context.startService(serviceIntent)
            if (mimeType.startsWith("video/")) {
                val playerIntent = Intent(context, SarahPlayerActivity::class.java).apply {
                    putExtra(SarahPlaybackService.EXTRA_TITLE, title)
                    putExtra(SarahPlaybackService.EXTRA_MIME_TYPE, mimeType)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(playerIntent)
            }
            call.resolve(JSObject().put("ok", true).put("nativePlayer", true).put("title", title))
        } catch (error: Exception) {
            call.reject(error.message ?: "Could not open the Android media player.", error)
        }
    }
}
