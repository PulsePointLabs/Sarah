package com.pulsepointlabs.focusclock

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PorterDuff
import android.graphics.PorterDuffColorFilter
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.os.SystemClock
import android.util.AttributeSet
import android.view.View
import kotlin.math.PI
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.random.Random

/**
 * Animated sky behind the clock: gradient follows the sun, sun/moon ride an arc,
 * stars come out at night, and weather adds clouds, rain, snow, fog or lightning.
 */
class SkyView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : View(context, attrs) {

    var weather = WeatherKind.CLEAR
        private set
    private var cloudCover = 0f
    private var sun = SunTimes.estimate(System.currentTimeMillis())

    /** Fixed clock for previews/screenshots; null means real time. */
    var timeOverride: Long? = null
    var dimmed = false
        set(value) { field = value; invalidate() }
    var animating = true
        set(value) { field = value; if (value) invalidate() }

    /** Brightness of the sky behind the text, so the activity can tune contrast. */
    var onLumaChanged: ((Float) -> Unit)? = null
    private var lastReportedLuma = -1f

    private val density = resources.displayMetrics.density
    private val rnd = Random(7)
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val bitmapPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
    }

    private var palette = SkyPalettes.MIDDAY
    private var paletteAt = 0L
    private var skyShader: Shader? = null
    private var vignette: Shader? = null

    private val cloudBitmaps by lazy { List(3) { makeCloudBitmap(Random(it * 31 + 5)) } }
    private var clouds = emptyList<Cloud>()
    private var stars = emptyList<Star>()
    private var drops = emptyList<Drop>()
    private var flakes = emptyList<Flake>()

    private var lastFrame = 0L
    private var nextLightning = 0L
    private var flash = 0f

    private class Cloud(var x: Float, val y: Float, val scale: Float, val speed: Float, val alpha: Float, val bitmap: Int)
    private class Star(val x: Float, val y: Float, val r: Float, val phase: Float, val rate: Float)
    private class Drop(var x: Float, var y: Float, val len: Float, val speed: Float)
    private class Flake(var x: Float, var y: Float, val r: Float, val speed: Float, val phase: Float)

    fun setWeather(kind: WeatherKind, cover: Float) {
        if (kind == weather && cover == cloudCover && clouds.isNotEmpty()) return
        weather = kind
        cloudCover = cover
        paletteAt = 0
        buildScene()
        invalidate()
    }

    fun setSunTimes(times: SunTimes) {
        if (!times.isUsable) return
        sun = times
        paletteAt = 0
        invalidate()
    }

    private fun now() = timeOverride ?: System.currentTimeMillis()

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        skyShader = null
        vignette = RadialGradient(
            w / 2f, h * 0.48f, max(w, h) * 0.78f,
            intArrayOf(Color.TRANSPARENT, Color.TRANSPARENT, Color.argb(120, 0, 0, 0)),
            floatArrayOf(0f, 0.55f, 1f), Shader.TileMode.CLAMP,
        )
        buildScene()
    }

    private fun buildScene() {
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0 || h <= 0) return

        stars = List(160) {
            Star(rnd.nextFloat() * w, rnd.nextFloat() * rnd.nextFloat() * h * 0.85f,
                (0.5f + rnd.nextFloat() * rnd.nextFloat() * 1.4f) * density,
                rnd.nextFloat() * 6.28f, 0.6f + rnd.nextFloat() * 1.8f)
        }

        val cover = if (weather.overcast > 0.5f) max(cloudCover, 0.9f) else cloudCover
        val count = when (weather) {
            WeatherKind.CLEAR -> (cloudCover * 10).toInt().coerceAtMost(2)
            WeatherKind.PARTLY -> 6
            WeatherKind.FOG -> 4
            else -> 11
        }
        val heavy = (cover * 0.5f + weather.overcast * 0.5f).coerceIn(0f, 1f)
        clouds = List(count) { i ->
            val back = i % 2 == 0
            val scale = (if (back) 0.55f else 0.85f) + rnd.nextFloat() * 0.5f
            Cloud(
                x = rnd.nextFloat() * (w + w * scale) - w * scale * 0.5f,
                y = h * (0.02f + rnd.nextFloat() * (if (weather.overcast > 0.5f) 0.55f else 0.42f)),
                scale = scale,
                speed = (if (back) 4f else 8f) * density * (0.7f + rnd.nextFloat() * 0.6f),
                alpha = (0.22f + heavy * 0.55f) * (if (back) 0.75f else 1f) * (if (weather == WeatherKind.CLEAR) 0.6f else 1f),
                bitmap = rnd.nextInt(3),
            )
        }.sortedBy { it.scale }

        drops = if (weather == WeatherKind.RAIN || weather == WeatherKind.STORM) {
            List(if (weather == WeatherKind.STORM) 190 else 120) {
                Drop(rnd.nextFloat() * w, rnd.nextFloat() * h, (10 + rnd.nextFloat() * 16) * density,
                    h * (0.9f + rnd.nextFloat() * 0.7f))
            }
        } else emptyList()

        flakes = if (weather == WeatherKind.SNOW) {
            List(110) {
                Flake(rnd.nextFloat() * w, rnd.nextFloat() * h, (1.2f + rnd.nextFloat() * rnd.nextFloat() * 3.2f) * density,
                    h * (0.04f + rnd.nextFloat() * 0.08f), rnd.nextFloat() * 6.28f)
            }
        } else emptyList()
    }

    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()
        val t = now()
        val frame = SystemClock.uptimeMillis()
        val dt = if (lastFrame == 0L) 0f else ((frame - lastFrame) / 1000f).coerceAtMost(0.1f)
        lastFrame = frame
        val sunNow = if (timeOverride != null) sun.alignedTo(t) else sun

        if (skyShader == null || kotlin.math.abs(t - paletteAt) > 5_000L) {
            paletteAt = t
            palette = SkyPalettes.weathered(SkyPalettes.at(t, sunNow), weather, cloudCover)
            skyShader = LinearGradient(0f, 0f, 0f, h,
                intArrayOf(palette.top, palette.mid, palette.bottom), floatArrayOf(0f, 0.55f, 1f), Shader.TileMode.CLAMP)
            val luma = SkyPalettes.luma(SkyPalettes.lerp(palette.mid, palette.top, 0.4f))
            if (kotlin.math.abs(luma - lastReportedLuma) > 0.02f) {
                lastReportedLuma = luma
                onLumaChanged?.invoke(luma)
            }
        }

        paint.shader = skyShader
        canvas.drawRect(0f, 0f, w, h, paint)
        paint.shader = null

        drawStars(canvas, frame)
        drawSunOrMoon(canvas, t, sunNow, w, h)
        drawClouds(canvas, dt, w)
        if (weather == WeatherKind.FOG) drawFog(canvas, frame, w, h)
        drawRain(canvas, dt, w, h)
        drawSnow(canvas, dt, frame, w, h)
        drawLightning(canvas, frame, w, h)

        paint.shader = vignette
        canvas.drawRect(0f, 0f, w, h, paint)
        paint.shader = null
        if (dimmed) canvas.drawColor(Color.argb(150, 0, 0, 0))

        if (animating) {
            // Particles need smooth motion; a calm sky only needs a slow drift.
            val busy = drops.isNotEmpty() || flakes.isNotEmpty() || weather == WeatherKind.FOG || flash > 0f
            postInvalidateDelayed(if (busy) 33L else 66L)
        }
    }

    private fun drawStars(canvas: Canvas, frame: Long) {
        val a = palette.stars
        if (a <= 0.01f) return
        val s = frame / 1000f
        for (star in stars) {
            val twinkle = 0.55f + 0.45f * sin(s * star.rate + star.phase)
            paint.color = Color.argb((255 * a * twinkle).toInt(), 235, 240, 255)
            canvas.drawCircle(star.x, star.y, star.r, paint)
        }
    }

    private fun drawSunOrMoon(canvas: Canvas, t: Long, sunNow: SunTimes, w: Float, h: Float) {
        val day = sunNow.isDay(t)
        val p = sunNow.arcProgress(t)
        val cx = w * (0.08f + 0.84f * p)
        val cy = h * (0.9f - 0.68f * sin(PI * p).toFloat())
        val unit = min(w, h)
        val veil = (1f - max(weather.overcast, cloudCover * 0.7f)).coerceIn(0.08f, 1f)

        val glowR = unit * (if (day) 0.62f else 0.38f)
        val glowA = (if (day) 0.55f else 0.22f) * veil
        paint.shader = RadialGradient(cx, cy, glowR,
            intArrayOf(withAlpha(palette.glow, glowA), withAlpha(palette.glow, glowA * 0.35f), Color.TRANSPARENT),
            floatArrayOf(0f, 0.35f, 1f), Shader.TileMode.CLAMP)
        canvas.drawCircle(cx, cy, glowR, paint)
        paint.shader = null

        // Fade the disc while it passes behind the clock so it never sits on the digits;
        // the glow stays and reads as a soft halo instead.
        val behindText = (kotlin.math.abs(cx - w / 2f) / (w * 0.38f)).coerceIn(0f, 1f) +
            ((cy - h * 0.62f) / (h * 0.12f)).coerceIn(0f, 1f)
        val discA = veil * (behindText.coerceAtMost(1f).let { it * it * (3 - 2 * it) })
        if (discA <= 0.01f) return
        val r = unit * (if (day) 0.045f else 0.035f)
        if (day) {
            paint.color = withAlpha(SkyPalettes.lerp(Color.WHITE, palette.glow, 0.35f), 0.95f * discA)
            canvas.drawCircle(cx, cy, r, paint)
        } else {
            val moon = Path().apply { addCircle(cx, cy, r, Path.Direction.CW) }
            val bite = Path().apply { addCircle(cx + r * 0.55f, cy - r * 0.25f, r * 0.92f, Path.Direction.CW) }
            moon.op(bite, Path.Op.DIFFERENCE)
            paint.color = Color.argb((235 * discA).toInt(), 238, 236, 225)
            canvas.drawPath(moon, paint)
        }
    }

    private fun drawClouds(canvas: Canvas, dt: Float, w: Float) {
        if (clouds.isEmpty()) return
        val bitmaps = cloudBitmaps
        bitmapPaint.colorFilter = PorterDuffColorFilter(palette.cloud, PorterDuff.Mode.SRC_IN)
        val dst = RectF()
        for (c in clouds) {
            val bmp = bitmaps[c.bitmap]
            val cw = w * 0.62f * c.scale
            val ch = cw * bmp.height / bmp.width
            c.x += c.speed * dt
            if (c.x > w + cw * 0.1f) c.x = -cw
            dst.set(c.x, c.y, c.x + cw, c.y + ch)
            bitmapPaint.alpha = (255 * c.alpha).toInt().coerceIn(0, 255)
            canvas.drawBitmap(bmp, null, dst, bitmapPaint)
        }
        bitmapPaint.colorFilter = null
    }

    private fun drawFog(canvas: Canvas, frame: Long, w: Float, h: Float) {
        val s = frame / 1000f
        for (i in 0 until 4) {
            val y = h * (0.35f + i * 0.17f) + sin(s * 0.15f + i) * h * 0.02f
            val band = h * 0.22f
            paint.shader = LinearGradient(0f, y - band, 0f, y + band,
                intArrayOf(Color.TRANSPARENT, withAlpha(palette.cloud, 0.28f), Color.TRANSPARENT),
                null, Shader.TileMode.CLAMP)
            canvas.drawRect(0f, y - band, w, y + band, paint)
        }
        paint.shader = null
    }

    private fun drawRain(canvas: Canvas, dt: Float, w: Float, h: Float) {
        if (drops.isEmpty()) return
        val slant = 0.18f
        strokePaint.strokeWidth = 1.1f * density
        strokePaint.color = withAlpha(SkyPalettes.lerp(palette.cloud, Color.WHITE, 0.5f), 0.38f)
        for (d in drops) {
            d.y += d.speed * dt
            d.x += d.speed * slant * dt
            if (d.y > h) { d.y = -d.len; d.x = rnd.nextFloat() * (w + h * slant) - h * slant }
            canvas.drawLine(d.x, d.y, d.x - d.len * slant, d.y - d.len, strokePaint)
        }
    }

    private fun drawSnow(canvas: Canvas, dt: Float, frame: Long, w: Float, h: Float) {
        if (flakes.isEmpty()) return
        val s = frame / 1000f
        for (f in flakes) {
            f.y += f.speed * dt
            if (f.y > h + f.r) { f.y = -f.r; f.x = rnd.nextFloat() * w }
            val x = f.x + sin(s * 0.8f + f.phase) * 14f * density
            paint.color = Color.argb((140 + 100 * (f.r / (4.4f * density))).toInt().coerceAtMost(240), 255, 255, 255)
            canvas.drawCircle(x, f.y, f.r, paint)
        }
    }

    private fun drawLightning(canvas: Canvas, frame: Long, w: Float, h: Float) {
        if (weather != WeatherKind.STORM) { flash = 0f; return }
        if (nextLightning == 0L) nextLightning = frame + 4_000L
        if (frame >= nextLightning) {
            flash = 1f
            nextLightning = frame + 5_000L + rnd.nextLong(9_000L)
        }
        if (flash > 0f) {
            // Two quick flickers then a fade.
            val flicker = if (flash > 0.75f && flash < 0.85f) 0.3f else 1f
            canvas.drawColor(Color.argb((110 * flash * flicker).toInt(), 225, 230, 255))
            flash = (flash - 0.06f).coerceAtLeast(0f)
        }
    }

    private fun makeCloudBitmap(r: Random): Bitmap {
        val bw = 640
        val bh = 300
        val bmp = Bitmap.createBitmap(bw, bh, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        val p = Paint(Paint.ANTI_ALIAS_FLAG)
        val puffs = 9 + r.nextInt(5)
        repeat(puffs) { i ->
            val f = i / (puffs - 1f)
            val cx = bw * (0.15f + 0.7f * f) + (r.nextFloat() - 0.5f) * 60f
            val hump = sin(PI * f).toFloat()
            val radius = 55f + hump * 70f + r.nextFloat() * 30f
            val cy = bh * 0.68f - hump * 55f + (r.nextFloat() - 0.5f) * 30f
            p.shader = RadialGradient(cx, cy, radius,
                intArrayOf(Color.argb(200, 255, 255, 255), Color.argb(110, 255, 255, 255), Color.TRANSPARENT),
                floatArrayOf(0f, 0.5f, 1f), Shader.TileMode.CLAMP)
            c.drawCircle(cx, cy, radius, p)
        }
        return bmp
    }

    private fun withAlpha(color: Int, a: Float) =
        Color.argb((255 * a).toInt().coerceIn(0, 255), Color.red(color), Color.green(color), Color.blue(color))
}
