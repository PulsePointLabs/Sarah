package com.pulsepointlabs.dexclock

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.view.View
import java.time.Duration
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Style C: smoked-glass card, white 24h digits, full date + weather, and a bar along
 * the bottom that fills across the hour and drifts blue -> violet -> red. The card
 * itself can take on the same colour ([tint]).
 *
 * With [bedtime] set, the same card becomes a bedtime countdown instead: big H:MM
 * left until bed, and the colour runs blue -> red over the last [WIND_DOWN_H] hours.
 *
 * Everything is laid out in "base" dp units (card is 280 x 120) and multiplied by
 * [k] = density * scale at draw time, so text stays crisp at any size.
 */
class ClockView(ctx: Context) : View(ctx) {

    companion object {
        const val BASE_W = 280f
        const val BASE_H = 120f
        const val MARGIN = 10f          // room around the card for its shadow
        const val BAR_H = 7f
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

        /** Colour/bar for the bedtime card starts moving this many hours before bed. */
        const val WIND_DOWN_H = 4L
        /** Keep showing "past bedtime" this long before switching to tomorrow's countdown. */
        const val OVERDUE_H = 4L

        /**
         * Seconds until the bedtime that matters right now (negative = past it), and the
         * matching 0..1 progress through the wind-down window.
         */
        fun bedState(now: LocalDateTime, bed: LocalTime): Pair<Long, Float> {
            val target = (-1L..1L)
                .map { now.toLocalDate().plusDays(it).atTime(bed) }
                .first { it.plusHours(OVERDUE_H).isAfter(now) }
            val secs = Duration.between(now, target).seconds
            val p = 1f - secs.toFloat() / (WIND_DOWN_H * 3600f)
            return secs to p.coerceIn(0f, 1f)
        }

        fun lerp(a: Int, b: Int, f: Float): Int = Color.rgb(
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
    /** 0 = plain dark glass, 1 = strongly tinted with the hour colour. */
    var tint = 0.5f
        set(v) { field = v; invalidate() }
    var weather: Weather? = null
        set(v) { field = v; invalidate() }
    /** Non-null turns this card into the bedtime countdown. */
    var bedtime: LocalTime? = null
        set(v) { field = v; invalidate() }
    /** For previews/tests only: freeze the clock at this time. */
    var timeOverride: LocalDateTime? = null
        set(v) { field = v; invalidate() }
    var chrome = false
        set(v) { if (field != v) { field = v; invalidate() } }

    private val k get() = density * scale

    private val dateFmt = DateTimeFormatter.ofPattern("EEEE, MMMM d", Locale.getDefault())
    private val hhmm = DateTimeFormatter.ofPattern("HH:mm")

    private val baseCard = Color.rgb(16, 18, 24)
    private val cardPaint = Paint(Paint.ANTI_ALIAS_FLAG)
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
        letterSpacing = 0.01f
    }
    private val tempPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = resources.getFont(R.font.inter_medium)
        color = Color.rgb(236, 238, 243)
        fontFeatureSettings = "tnum"
    }
    private val iconPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(236, 238, 243) }
    private val trackPaint = Paint()
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
        val now = timeOverride ?: LocalDateTime.now()
        val bed = bedtime
        val bedSecs: Long
        val progress: Float
        if (bed != null) {
            val st = bedState(now, bed); bedSecs = st.first; progress = st.second
        } else {
            bedSecs = 0
            progress = (now.minute * 60 + now.second + now.nano / 1e9f) / 3600f
        }
        val accent = hourColor(progress)

        card.set(x(0f), y(0f), x(BASE_W), y(BASE_H))
        val r = RADIUS * k
        val mix = tint.coerceIn(0f, 1f) * 0.75f

        // Card + soft shadow. Both fade out with the Background slider.
        if (bgAlpha > 0.01f) {
            cardPaint.color = lerp(baseCard, accent, mix)
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
        tempPaint.setShadowLayer(2 * k, 0f, 1 * k, textShadow)
        iconPaint.setShadowLayer(2 * k, 0f, 1 * k, textShadow)

        timePaint.textSize = 58 * k
        if (bed != null) {
            // Round up while counting down, so it reads 0:00 right at bedtime.
            val mins = if (bedSecs >= 0) (bedSecs + 59) / 60 else -bedSecs / 60
            val text = (if (bedSecs < 0) "+" else "") + "%d:%02d".format(mins / 60, mins % 60)
            canvas.drawText(text, x(BASE_W / 2), y(66f), timePaint)
            drawBedLine(canvas, if (bedSecs >= 0) "until bed at ${bed.format(hhmm)}" else "past bedtime (${bed.format(hhmm)})")
        } else {
            canvas.drawText("%02d:%02d".format(now.hour, now.minute), x(BASE_W / 2), y(66f), timePaint)
            drawDateLine(canvas, now.format(dateFmt))
        }

        // Hour bar, clipped to the card's rounded bottom corners.
        canvas.save()
        clip.reset()
        clip.addRoundRect(card, r, r, Path.Direction.CW)
        canvas.clipPath(clip)
        // On a tinted card the bar would vanish into its own colour, so lift it toward white.
        trackPaint.color = Color.argb((20 + 40 * mix).toInt(), 255, 255, 255)
        canvas.drawRect(x(0f), y(BASE_H - BAR_H), x(BASE_W), y(BASE_H), trackPaint)
        barPaint.color = lerp(accent, Color.WHITE, mix * bgAlpha.coerceAtMost(1f) * 0.6f)
        val end = x(BASE_W * progress)
        canvas.drawRoundRect(x(-4f), y(BASE_H - BAR_H), end, y(BASE_H), 3.5f * k, 3.5f * k, barPaint)
        canvas.restore()

        if (chrome) drawChrome(canvas)
    }

    /** "Friday, November 6   ☁ 71°", centred, shrinking a touch if a long date won't fit. */
    private fun drawDateLine(canvas: Canvas, date: String) {
        val w = weather
        var size = 15f
        val icon = 18f; val gapA = 11f; val gapB = 5f
        // Paints work in screen pixels; layout here is in base units, hence the * k and / k.
        fun widthAt(sz: Float): Float {
            datePaint.textSize = sz * k; tempPaint.textSize = sz * k
            var total = datePaint.measureText(date) / k
            if (w != null) total += gapA + icon * sz / 15f + gapB + tempPaint.measureText("${w.temp}°") / k
            return total
        }
        var total = widthAt(size)
        val room = BASE_W - 32
        if (total > room) { size *= room / total; total = widthAt(size) }

        val baseline = 95.5f
        var cur = BASE_W / 2 - total / 2
        canvas.drawText(date, x(cur), y(baseline), datePaint)
        if (w == null) return
        cur += datePaint.measureText(date) / k + gapA
        val s = icon * size / 15f
        WeatherIcon.draw(canvas, w.code, w.day, x(cur + s / 2), y(baseline - size * 0.36f), s * k, iconPaint)
        cur += s + gapB
        canvas.drawText("${w.temp}°", x(cur), y(baseline), tempPaint)
    }

    /** "☾ until bed at 22:30", centred. */
    private fun drawBedLine(canvas: Canvas, label: String) {
        val size = 15f; val icon = 16f; val gap = 7f
        datePaint.textSize = size * k
        val total = icon + gap + datePaint.measureText(label) / k
        val baseline = 95.5f
        var cur = BASE_W / 2 - total / 2
        WeatherIcon.draw(canvas, 0, false, x(cur + icon / 2), y(baseline - size * 0.36f), icon * k, iconPaint)
        cur += icon + gap
        canvas.drawText(label, x(cur), y(baseline), datePaint)
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
