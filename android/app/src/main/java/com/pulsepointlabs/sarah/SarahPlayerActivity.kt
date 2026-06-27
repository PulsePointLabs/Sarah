package com.pulsepointlabs.sarah

import android.app.PictureInPictureParams
import android.content.ComponentName
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Rational
import android.view.View
import android.view.WindowManager
import androidx.annotation.OptIn
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import androidx.media3.ui.PlayerView
import com.google.common.util.concurrent.ListenableFuture

@OptIn(UnstableApi::class)
class SarahPlayerActivity : AppCompatActivity() {
    private lateinit var playerView: PlayerView
    private var controllerFuture: ListenableFuture<MediaController>? = null
    private var controller: MediaController? = null
    private var isVideo = true

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        isVideo = intent.getStringExtra(SarahPlaybackService.EXTRA_MIME_TYPE).orEmpty().startsWith("video/")
        playerView = PlayerView(this).apply {
            setBackgroundColor(android.graphics.Color.BLACK)
            useController = true
            controllerAutoShow = true
            keepScreenOn = true
        }
        setContentView(playerView)

        val token = SessionToken(this, ComponentName(this, SarahPlaybackService::class.java))
        controllerFuture = MediaController.Builder(this, token).buildAsync().also { future ->
            future.addListener({
                try {
                    controller = future.get()
                    playerView.player = controller
                    updatePictureInPictureParams()
                } catch (_: Exception) {
                    finish()
                }
            }, ContextCompat.getMainExecutor(this))
        }
    }

    private fun updatePictureInPictureParams() {
        if (!isVideo || Build.VERSION.SDK_INT < Build.VERSION_CODES.O || !supportsPictureInPicture()) return
        val builder = PictureInPictureParams.Builder().setAspectRatio(Rational(16, 9))
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) builder.setAutoEnterEnabled(true)
        setPictureInPictureParams(builder.build())
    }

    private fun supportsPictureInPicture(): Boolean =
        packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (
            isVideo
            && Build.VERSION.SDK_INT in Build.VERSION_CODES.O until Build.VERSION_CODES.S
            && supportsPictureInPicture()
            && controller?.isPlaying == true
        ) {
            enterPictureInPictureMode(PictureInPictureParams.Builder().setAspectRatio(Rational(16, 9)).build())
        }
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: android.content.res.Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        playerView.useController = !isInPictureInPictureMode
        window.decorView.systemUiVisibility = if (isInPictureInPictureMode) {
            View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
        } else {
            View.SYSTEM_UI_FLAG_VISIBLE
        }
    }

    override fun onDestroy() {
        playerView.player = null
        controllerFuture?.let { MediaController.releaseFuture(it) }
        controllerFuture = null
        controller = null
        super.onDestroy()
    }
}
