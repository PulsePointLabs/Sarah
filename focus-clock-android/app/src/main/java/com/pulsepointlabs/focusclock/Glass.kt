package com.pulsepointlabs.focusclock

import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.view.View

/** Frosted cards: darker glass over bright skies so white text keeps its contrast. */
object Glass {
    fun tint(views: List<View>, skyLuma: Float) {
        val fill = Color.argb((40 + skyLuma * 70).toInt().coerceIn(40, 100), 10, 16, 40)
        val edge = Color.argb((50 + skyLuma * 30).toInt(), 255, 255, 255)
        for (v in views) {
            val bg = v.background?.mutate() as? GradientDrawable ?: continue
            bg.setColor(fill)
            bg.setStroke((v.resources.displayMetrics.density).toInt().coerceAtLeast(1), edge)
        }
    }
}
