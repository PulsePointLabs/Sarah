package com.pulsepointlabs.dexclock

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.view.View
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Style C: smoked-glass card, white 24h digits, full date, and a thin bar along the
 * bottom that fills across the hour and drifts blue -> violet -> red.
 *
 * Everything is laid out in "base" dp units (card is 260 x 118) and multiplied by
 * [k] = density * scale at draw time, so text stays crisp at any size.
 */
class ClockView(ctx: Context) : View(ctx) {

    companion object {
        const val BASE_W = 260f
        const val BASE_H = 118f
        const val MARGIN = 10f          // room around the card for its shadow
        const val BAR_H = 5f
        const val RADIUS = 18f

        fun windowW(density: Float, scale: Float) = ((BASE_W + 2 * MARGIN) * density * scale).toInt()
        fun windowH(density: Float, scale: Float) = ((BASE_H + 2 * MARGIN) * density * scale).toInt()

        private val STOPS = intArrayOf(0xFF4F8DFF.toInt(), 0xFFA06CF0.toInt(), 0xFFFF5252.toInt())

        /** 0.0 at :00 -> 1.0 at :59:59. Blue, through violet at half past, to red. */
        fun hourColor(p: Float): Int {
            val t = p.coerceIn(0f, 1f) * (STOPS.size - 1)
            val i = t.toInt().coerceAtMost(STOPS.size - 2)
            return lerp(STOPS[i], STOPS[i + 1], t - i)
        }

        private fun lerp(a: Int, b: Int, f: Float): Int = Color.rgb(
            (Color.red(a) + (Color.red(b) - Color.red(a)) * f).toInt(),
            (Color.green(a) + (Color.green(b) - Color.green(a)) * f).toInt(),
            (Color.blue(a) + (Color.blue(b) - Color.blue(a)) * f).toInt(),
        )
    }

    private val density = resources.displayMetrics.density

    var scale = 1f
        set(v) { field = v; invalidate() }
    var bgAlpha = 0.62f
        set(v) { field = v; invalidate() }
    var chrome = false
        set(v) { if (field != v) { field = v; invalidate() } }

    private val k get() = density * scale

    private val dateFmt = DateTimeFormatter.ofPattern("EEEE, MMMM d", Locale.getDefault())

    private val cardPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(16, 18, 24) }
    private val borderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; color = Color.WHITE }
    private val timePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = resources.getFont(R.font.inter_light)
        color = Color.rgb(244, 245, 248)
        textAlign = Paint.Align.CENTER
        fontFeatureSettings = "tnum"          // fixed-width digits, no jiggle
        letterSpacing = -0.03f
    }
    private val datePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = resources.getFont(R.font.inter_medium)
        color = Color.rgb(201, 205, 214)
        textAlign = Paint.Align.CENTER
        letterSpacing = 0.01f
    }
    private val trackPaint = Paint().apply { color = Color.argb(20, 255, 255, 255) }
    private val barPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val gripPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; color = Color.argb(150, 255, 255, 255)
    }
    private val gear = context.getDrawable(R.drawable.ic_gear)!!.mutate().apply { alpha = 140 }

    private val card = RectF()
    private val clip = Path()

    private fun x(v: Float) = (MARGIN + v) * k
    private fun y(v: Float) = (MARGIN + v) * k

    override fun onDraw(canvas: Canvas) {
        val now = LocalDateTime.now()
        val progress = (now.minute * 60 + now.second + now.nano / 1e9f) / 3600f
        val accent = hourColor(progress)

        card.set(x(0f), y(0f), x(BASE_W), y(BASE_H))
        val r = RADIUS * k

        // Card + soft shadow. Both fade out with the Background slider.
        if (bgAlpha > 0.01f) {
            cardPaint.alpha = (bgAlpha * 255).toInt()
            cardPaint.setShadowLayer(8 * k, 0f, 3 * k, Color.argb((90 * bgAlpha).toInt(), 0, 0, 0))
            canvas.drawRoundRect(card, r, r, cardPaint)
            borderPaint.strokeWidth = 1f * density
            borderPaint.alpha = (28 * bgAlpha.coerceAtMost(1f) / 0.62f).toInt().coerceAtMost(28)
            canvas.drawRoundRect(card, r, r, borderPaint)
        }

        // With little or no card behind them, give the words a faint shadow so they
        // still read on top of a white app.
        val textShadow = Color.argb(((1f - bgAlpha) * 140).toInt().coerceAtLeast(0), 0, 0, 0)
        timePaint.setShadowLayer(3 * k, 0f, 1 * k, textShadow)
        datePaint.setShadowLayer(2 * k, 0f, 1 * k, textShadow)

        timePaint.textSize = 58 * k
        canvas.drawText("%02d:%02d".format(now.hour, now.minute), x(BASE_W / 2), y(66f), timePaint)

        datePaint.textSize = 15 * k
        canvas.drawText(now.format(dateFmt), x(BASE_W / 2), y(95.5f), datePaint)

        // Hour bar, clipped to the card's rounded bottom corners.
        canvas.save()
        clip.reset()
        clip.addRoundRect(card, r, r, Path.Direction.CW)
        canvas.clipPath(clip)
        canvas.drawRect(x(0f), y(BASE_H - BAR_H), x(BASE_W), y(BASE_H), trackPaint)
        barPaint.color = accent
        val end = x(BASE_W * progress)
        canvas.drawRoundRect(x(-4f), y(BASE_H - BAR_H), end, y(BASE_H), 2.5f * k, 2.5f * k, barPaint)
        canvas.restore()

        if (chrome) drawChrome(canvas)
    }

    private fun drawChrome(canvas: Canvas) {
        val g = 16f
        gear.setBounds(x(BASE_W - 12 - g).toInt(), y(10f).toInt(), x(BASE_W - 12).toInt(), y(10 + g).toInt())
        gear.draw(canvas)

        gripPaint.strokeWidth = 1.6f * density * scale.coerceAtLeast(0.8f)
        val ox = BASE_W - 9; val oy = BASE_H - BAR_H - 7; val s = 12f
        canvas.drawLine(x(ox - s), y(oy), x(ox), y(oy - s), gripPaint)
        canvas.drawLine(x(ox - s / 2), y(oy), x(ox), y(oy - s / 2), gripPaint)
    }

    // ---- hit testing in view pixels ----
    private fun bx(px: Float) = px / k - MARGIN
    private fun by(py: Float) = py / k - MARGIN

    fun hitGrip(px: Float, py: Float) = bx(px) > BASE_W - 36 && by(py) > BASE_H - 36
    fun hitGear(px: Float, py: Float) = bx(px) > BASE_W - 40 && by(py) < 36
}
