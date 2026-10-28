package com.pulsepointlabs.focusclock

import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.ContextThemeWrapper
import android.view.LayoutInflater
import android.view.View
import android.widget.TextView
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.util.Calendar
import android.text.format.DateFormat
import android.util.TypedValue

/**
 * Renders the focus screen for a set of times/weathers to PNGs (build/snapshots) so the
 * design can be reviewed without a device. Run: ./gradlew testDebugUnitTest
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w800dp-h360dp-land-xhdpi")
class SkySnapshotTest {

    private data class Scene(
        val name: String,
        val hour: Int,
        val minute: Int,
        val kind: WeatherKind,
        val cover: Float,
        val temp: Int,
        val code: Int,
        val timeOnly: Boolean = false,
    )

    private val scenes = listOf(
        Scene("01-predawn-clear", 6, 15, WeatherKind.CLEAR, 0f, 41, 0),
        Scene("02-sunrise-clear", 7, 5, WeatherKind.CLEAR, 0.1f, 44, 1),
        Scene("03-morning-partly", 9, 30, WeatherKind.PARTLY, 0.45f, 52, 2),
        Scene("04-midday-clear", 12, 40, WeatherKind.CLEAR, 0.1f, 63, 0),
        Scene("05-afternoon-cloudy", 15, 10, WeatherKind.CLOUDY, 0.9f, 58, 3),
        Scene("06-golden-hour", 17, 20, WeatherKind.PARTLY, 0.35f, 57, 2),
        Scene("07-sunset", 18, 12, WeatherKind.CLEAR, 0.1f, 54, 0),
        Scene("08-dusk", 18, 45, WeatherKind.CLEAR, 0f, 51, 0),
        Scene("09-night-clear", 22, 30, WeatherKind.CLEAR, 0f, 46, 0),
        Scene("10-rain-day", 11, 0, WeatherKind.RAIN, 0.9f, 49, 63),
        Scene("11-snow-day", 13, 30, WeatherKind.SNOW, 0.9f, 29, 73),
        Scene("12-storm-evening", 19, 30, WeatherKind.STORM, 0.95f, 66, 95),
        Scene("13-fog-morning", 8, 20, WeatherKind.FOG, 0.8f, 47, 45),
        Scene("14-time-only-night", 23, 41, WeatherKind.CLEAR, 0f, 45, 0, timeOnly = true),
    )

    @Test
    fun renderScenes() {
        val app = RuntimeEnvironment.getApplication()
        val ctx = ContextThemeWrapper(app, R.style.FocusTheme)
        val out = File("build/snapshots").apply { mkdirs() }
        val dm = ctx.resources.displayMetrics
        val w = (800 * dm.density).toInt()
        val h = (360 * dm.density).toInt()

        for (s in scenes) {
            val cal = Calendar.getInstance().apply {
                set(2026, Calendar.OCTOBER, 28, s.hour, s.minute, 0)
                set(Calendar.MILLISECOND, 0)
            }
            val base = Calendar.getInstance().apply {
                timeInMillis = cal.timeInMillis
                set(Calendar.HOUR_OF_DAY, 7); set(Calendar.MINUTE, 22)
            }.timeInMillis
            val sun = SunTimes(base, base + (10 * 60 + 52) * 60_000L, base + SunTimes.DAY + 60_000L)

            val root = LayoutInflater.from(ctx).inflate(R.layout.activity_focus, null)
            val sky = root.findViewById<SkyView>(R.id.sky)
            sky.animating = false
            sky.timeOverride = cal.timeInMillis
            sky.setSunTimes(sun)
            sky.setWeather(s.kind, s.cover)

            val time = root.findViewById<TextView>(R.id.time)
            time.text = DateFormat.format("h:mm", cal)
            root.findViewById<TextView>(R.id.ampm).text = DateFormat.format("a", cal).toString().uppercase()
            root.findViewById<TextView>(R.id.date).text = DateFormat.format("EEEE, MMMM d", cal)
            val ratio = if (s.timeOnly) R.dimen.time_only_size_ratio else R.dimen.time_size_ratio
            time.setTextSize(TypedValue.COMPLEX_UNIT_PX, h * ctx.resources.getFloat(ratio))
            root.findViewById<TextView>(R.id.ampm).setTextSize(TypedValue.COMPLEX_UNIT_PX, h * ctx.resources.getFloat(ratio) * 0.13f)

            root.findViewById<WeatherIconView>(R.id.nowIcon).set(s.kind, sun.isDay(cal.timeInMillis))
            root.findViewById<TextView>(R.id.nowTemp).text = "${s.temp}°"
            root.findViewById<TextView>(R.id.nowDetail).text = "${Weather.describe(s.code)}\nH ${s.temp + 6}°  ·  L ${s.temp - 9}°"
            root.findViewById<WeatherIconView>(R.id.tomorrowIcon).set(WeatherKind.RAIN, true)
            root.findViewById<TextView>(R.id.tomorrowTemp).text = "${s.temp + 3}°"
            root.findViewById<TextView>(R.id.tomorrowDetail).text = "Light rain  ·  60%\nLow ${s.temp - 7}°"
            if (s.timeOnly) {
                root.findViewById<View>(R.id.date).visibility = View.GONE
                root.findViewById<View>(R.id.weather).visibility = View.GONE
            }

            root.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY))
            root.layout(0, 0, w, h)
            // Shadow strength normally comes from the sky's brightness callback.
            val luma = SkyPalettes.luma(SkyPalettes.weathered(SkyPalettes.at(cal.timeInMillis, sun), s.kind, s.cover).mid)
            val alpha = (70 + luma * 150).toInt().coerceIn(60, 190)
            listOf(R.id.time, R.id.ampm, R.id.date, R.id.nowTemp, R.id.nowDetail, R.id.tomorrowTemp, R.id.tomorrowDetail)
                .forEach { root.findViewById<TextView>(it).setShadowLayer(10f + luma * 16f, 0f, 2f, android.graphics.Color.argb(alpha, 4, 10, 30)) }

            Glass.tint(listOf(root.findViewById(R.id.nowCard), root.findViewById(R.id.tomorrowCard)), luma)

            val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            root.draw(Canvas(bmp))
            File(out, "${s.name}.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
    }
}
