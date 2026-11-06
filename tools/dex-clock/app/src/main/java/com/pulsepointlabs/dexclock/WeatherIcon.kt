package com.pulsepointlabs.dexclock

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import kotlin.math.cos
import kotlin.math.sin

/**
 * Thin line-style weather icons drawn straight onto the canvas, so they match the
 * light Inter digits and stay sharp at any clock size. Codes are WMO weather codes.
 */
object WeatherIcon {

    private enum class Kind { CLEAR, PARTLY, CLOUDY, FOG, RAIN, SNOW, STORM }

    private fun kind(code: Int) = when (code) {
        0 -> Kind.CLEAR
        1, 2 -> Kind.PARTLY
        3 -> Kind.CLOUDY
        45, 48 -> Kind.FOG
        in 51..67, in 80..82 -> Kind.RAIN
        in 71..77, 85, 86 -> Kind.SNOW
        in 95..99 -> Kind.STORM
        else -> Kind.CLOUDY
    }

    private val path = Path()
    private val tmp = Path()
    private val oval = RectF()
    private val moonA = Path()
    private val moonB = Path()

    /** Draws an icon filling a [s] x [s] box centred on ([cx], [cy]). [p] should be a stroke paint. */
    fun draw(c: Canvas, code: Int, day: Boolean, cx: Float, cy: Float, s: Float, p: Paint) {
        p.style = Paint.Style.STROKE
        p.strokeWidth = s * 0.085f
        p.strokeCap = Paint.Cap.ROUND
        p.strokeJoin = Paint.Join.ROUND

        when (kind(code)) {
            Kind.CLEAR -> if (day) sun(c, cx, cy, s * 0.5f, p) else moon(c, cx, cy, s * 0.42f, p)
            Kind.PARTLY -> {
                // Sun/moon peeking out from behind the cloud's top-left.
                cloud(cx + s * 0.08f, cy + s * 0.1f, s * 0.8f)
                c.save()
                c.clipOutPath(path)
                if (day) sun(c, cx - s * 0.2f, cy - s * 0.18f, s * 0.32f, p)
                else moon(c, cx - s * 0.18f, cy - s * 0.18f, s * 0.28f, p)
                c.restore()
                c.drawPath(path, p)
            }
            Kind.CLOUDY -> { cloud(cx, cy, s); c.drawPath(path, p) }
            Kind.FOG -> {
                for ((i, w) in listOf(0.8f, 1f, 0.65f).withIndex()) {
                    val y = cy + (i - 1) * s * 0.3f
                    c.drawLine(cx - s * 0.5f * w, y, cx + s * 0.5f * w, y, p)
                }
            }
            Kind.RAIN -> {
                cloud(cx, cy - s * 0.2f, s * 0.92f); c.drawPath(path, p)
                for (i in -1..1) {
                    val x = cx + i * s * 0.26f
                    c.drawLine(x + s * 0.06f, cy + s * 0.24f, x - s * 0.04f, cy + s * 0.46f, p)
                }
            }
            Kind.SNOW -> {
                cloud(cx, cy - s * 0.2f, s * 0.92f); c.drawPath(path, p)
                val r = s * 0.05f
                p.style = Paint.Style.FILL
                for (i in -1..1) c.drawCircle(cx + i * s * 0.26f, cy + s * (if (i == 0) 0.42f else 0.32f), r, p)
                p.style = Paint.Style.STROKE
            }
            Kind.STORM -> {
                cloud(cx, cy - s * 0.2f, s * 0.92f); c.drawPath(path, p)
                tmp.reset()
                tmp.moveTo(cx + s * 0.06f, cy + s * 0.14f)
                tmp.lineTo(cx - s * 0.1f, cy + s * 0.34f)
                tmp.lineTo(cx + s * 0.06f, cy + s * 0.34f)
                tmp.lineTo(cx - s * 0.08f, cy + s * 0.52f)
                c.drawPath(tmp, p)
            }
        }
    }

    private fun sun(c: Canvas, cx: Float, cy: Float, r: Float, p: Paint) {
        c.drawCircle(cx, cy, r * 0.42f, p)
        for (i in 0 until 8) {
            val a = Math.PI * i / 4
            val ca = cos(a).toFloat(); val sa = sin(a).toFloat()
            c.drawLine(cx + ca * r * 0.66f, cy + sa * r * 0.66f, cx + ca * r * 0.92f, cy + sa * r * 0.92f, p)
        }
    }

    private fun moon(c: Canvas, cx: Float, cy: Float, r: Float, p: Paint) {
        moonA.reset(); moonB.reset()
        moonA.addCircle(cx, cy, r, Path.Direction.CW)
        moonB.addCircle(cx + r * 0.55f, cy - r * 0.4f, r * 0.82f, Path.Direction.CW)
        moonA.op(moonB, Path.Op.DIFFERENCE)
        c.drawPath(moonA, p)
    }

    /** Builds a puffy cloud outline into [path], roughly [w] wide, centred on (cx, cy). */
    private fun cloud(cx: Float, cy: Float, w: Float) {
        path.reset()
        val base = cy + w * 0.22f
        path.addCircle(cx - w * 0.24f, base - w * 0.12f, w * 0.17f, Path.Direction.CW)
        tmp.reset(); tmp.addCircle(cx + w * 0.04f, base - w * 0.24f, w * 0.25f, Path.Direction.CW)
        path.op(tmp, Path.Op.UNION)
        tmp.reset(); tmp.addCircle(cx + w * 0.3f, base - w * 0.1f, w * 0.15f, Path.Direction.CW)
        path.op(tmp, Path.Op.UNION)
        tmp.reset()
        oval.set(cx - w * 0.42f, base - w * 0.2f, cx + w * 0.46f, base)
        tmp.addRoundRect(oval, w * 0.1f, w * 0.1f, Path.Direction.CW)
        path.op(tmp, Path.Op.UNION)
    }
}
