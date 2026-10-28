package com.pulsepointlabs.focusclock

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.util.AttributeSet
import android.view.View
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin

/** Thin line-art weather glyphs that match the clock's light type. */
class WeatherIconView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : View(context, attrs) {

    private var kind: WeatherKind? = null
    private var day = true

    private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
        color = Color.WHITE
    }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }

    fun set(kind: WeatherKind, isDay: Boolean) {
        this.kind = kind
        this.day = isDay
        contentDescription = kind.label
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        val k = kind ?: return
        val s = min(width, height).toFloat()
        canvas.translate((width - s) / 2f, (height - s) / 2f)
        line.strokeWidth = s * 0.045f

        when (k) {
            WeatherKind.CLEAR -> if (day) sun(canvas, s * 0.5f, s * 0.5f, s * 0.2f, null) else moon(canvas, s * 0.5f, s * 0.5f, s * 0.28f, null)
            WeatherKind.PARTLY -> {
                val c = cloud(s * 0.16f, s * 0.36f, s * 0.92f, s * 0.82f)
                if (day) sun(canvas, s * 0.36f, s * 0.36f, s * 0.15f, c) else moon(canvas, s * 0.36f, s * 0.36f, s * 0.2f, c)
                canvas.drawPath(c, line)
            }
            WeatherKind.CLOUDY -> canvas.drawPath(cloud(s * 0.08f, s * 0.24f, s * 0.92f, s * 0.76f), line)
            WeatherKind.FOG -> {
                canvas.drawPath(cloud(s * 0.14f, s * 0.12f, s * 0.86f, s * 0.54f), line)
                canvas.drawLine(s * 0.12f, s * 0.7f, s * 0.88f, s * 0.7f, line)
                canvas.drawLine(s * 0.22f, s * 0.86f, s * 0.78f, s * 0.86f, line)
            }
            WeatherKind.RAIN -> {
                canvas.drawPath(cloud(s * 0.1f, s * 0.08f, s * 0.9f, s * 0.56f), line)
                for (i in 0..2) {
                    val x = s * (0.32f + i * 0.18f)
                    canvas.drawLine(x, s * 0.68f, x - s * 0.06f, s * 0.88f, line)
                }
            }
            WeatherKind.SNOW -> {
                canvas.drawPath(cloud(s * 0.1f, s * 0.08f, s * 0.9f, s * 0.56f), line)
                for (i in 0..2) {
                    val x = s * (0.3f + i * 0.2f)
                    val y = s * (if (i == 1) 0.84f else 0.74f)
                    canvas.drawCircle(x, y, s * 0.04f, fill)
                }
            }
            WeatherKind.STORM -> {
                canvas.drawPath(cloud(s * 0.1f, s * 0.06f, s * 0.9f, s * 0.54f), line)
                val bolt = Path().apply {
                    moveTo(s * 0.54f, s * 0.6f)
                    lineTo(s * 0.42f, s * 0.78f)
                    lineTo(s * 0.56f, s * 0.78f)
                    lineTo(s * 0.46f, s * 0.96f)
                }
                canvas.drawPath(bolt, line)
            }
        }
    }

    /** Cloud outline fitted to the given box. */
    private fun cloud(l: Float, t: Float, r: Float, b: Float): Path {
        val w = r - l
        val h = b - t
        val base = b - h * 0.02f
        val path = Path().apply {
            addRoundRect(RectF(l + w * 0.04f, t + h * 0.5f, r - w * 0.04f, base), h * 0.25f, h * 0.25f, Path.Direction.CW)
        }
        fun puff(cx: Float, cy: Float, rad: Float) =
            path.op(Path().apply { addCircle(l + w * cx, t + h * cy, h * rad, Path.Direction.CW) }, Path.Op.UNION)
        puff(0.3f, 0.6f, 0.3f)
        puff(0.56f, 0.42f, 0.4f)
        puff(0.78f, 0.64f, 0.26f)
        return path
    }

    private fun sun(canvas: Canvas, cx: Float, cy: Float, r: Float, mask: Path?) {
        val shape = Path().apply { addCircle(cx, cy, r, Path.Direction.CW) }
        for (i in 0 until 8) {
            val a = i * Math.PI / 4
            val ray = Path().apply {
                moveTo(cx + (r * 1.45f * cos(a)).toFloat(), cy + (r * 1.45f * sin(a)).toFloat())
                lineTo(cx + (r * 1.9f * cos(a)).toFloat(), cy + (r * 1.9f * sin(a)).toFloat())
            }
            stroke(canvas, ray, mask)
        }
        stroke(canvas, shape, mask)
    }

    private fun moon(canvas: Canvas, cx: Float, cy: Float, r: Float, mask: Path?) {
        val shape = Path().apply { addCircle(cx, cy, r, Path.Direction.CW) }
        shape.op(Path().apply { addCircle(cx + r * 0.55f, cy - r * 0.35f, r * 0.85f, Path.Direction.CW) }, Path.Op.DIFFERENCE)
        stroke(canvas, shape, mask)
    }

    /** Strokes [path], hiding whatever falls behind [mask] (the cloud in front). */
    private fun stroke(canvas: Canvas, path: Path, mask: Path?) {
        if (mask == null) {
            canvas.drawPath(path, line)
            return
        }
        canvas.save()
        canvas.clipOutPath(mask)
        canvas.drawPath(path, line)
        canvas.restore()
    }
}
