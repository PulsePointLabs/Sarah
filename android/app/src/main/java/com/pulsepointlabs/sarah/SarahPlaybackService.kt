package com.pulsepointlabs.sarah

import android.content.Intent
import android.webkit.CookieManager
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import org.json.JSONObject

class SarahPlaybackService : MediaSessionService() {
    companion object {
        const val ACTION_PLAY = "com.pulsepointlabs.sarah.media.PLAY"
        const val EXTRA_URL = "url"
        const val EXTRA_TITLE = "title"
        const val EXTRA_MIME_TYPE = "mimeType"
        const val EXTRA_HEADERS_JSON = "headersJson"
        const val EXTRA_POSITION_MS = "positionMs"
    }

    private var player: ExoPlayer? = null
    private var mediaSession: MediaSession? = null

    override fun onCreate() {
        super.onCreate()
        replacePlayer(emptyMap())
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = mediaSession

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_PLAY) playIntent(intent)
        return super.onStartCommand(intent, flags, startId)
    }

    private fun playIntent(intent: Intent) {
        val url = intent.getStringExtra(EXTRA_URL).orEmpty()
        if (url.isBlank()) return
        val title = intent.getStringExtra(EXTRA_TITLE).orEmpty().ifBlank { "Sarah media" }
        val mimeType = intent.getStringExtra(EXTRA_MIME_TYPE).orEmpty()
        val headers = headersFromJson(intent.getStringExtra(EXTRA_HEADERS_JSON).orEmpty()).toMutableMap()
        CookieManager.getInstance().getCookie(url)?.takeIf { it.isNotBlank() }?.let { cookie ->
            if (!headers.keys.any { it.equals("Cookie", true) }) headers["Cookie"] = cookie
        }

        val nextPlayer = replacePlayer(headers)
        val item = MediaItem.Builder()
            .setUri(url)
            .setMimeType(mimeType.ifBlank { null })
            .setMediaMetadata(MediaMetadata.Builder().setTitle(title).build())
            .build()
        nextPlayer.setMediaItem(item)
        nextPlayer.prepare()
        val positionMs = intent.getLongExtra(EXTRA_POSITION_MS, 0L)
        if (positionMs > 0L) nextPlayer.seekTo(positionMs)
        nextPlayer.playWhenReady = true
    }

    private fun replacePlayer(headers: Map<String, String>): ExoPlayer {
        val httpFactory = DefaultHttpDataSource.Factory()
            .setUserAgent("Sarah Android")
            .setAllowCrossProtocolRedirects(true)
            .setDefaultRequestProperties(headers)
        val next = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(this).setDataSourceFactory(httpFactory))
            .build()
        if (mediaSession == null) mediaSession = MediaSession.Builder(this, next).build()
        else mediaSession?.setPlayer(next)
        player?.release()
        player = next
        return next
    }

    override fun onDestroy() {
        mediaSession?.release()
        mediaSession = null
        player?.release()
        player = null
        super.onDestroy()
    }

    private fun headersFromJson(json: String): Map<String, String> {
        if (json.isBlank()) return emptyMap()
        return try {
            val raw = JSONObject(json)
            raw.keys().asSequence().associateWith { raw.optString(it) }.filterValues { it.isNotBlank() }
        } catch (_: Exception) {
            emptyMap()
        }
    }
}
