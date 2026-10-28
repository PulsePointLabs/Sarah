package com.pulsepointlabs.focusclock

import android.graphics.Color
import java.util.Calendar
import kotlin.math.max
import kotlin.math.min

enum class WeatherKind(val label: String, val overcast: Float) {
    CLEAR("Clear", 0f),
    PARTLY("Partly cloudy", 0.12f),
    CLOUDY("Cloudy", 0.6f),
    FOG("Fog", 0.55f),
    RAIN("Rain", 0.7f),
    SNOW("Snow", 0.5f),
    STORM("Storm", 0.85f);

    companion object {
        fun fromCode(code: Int): WeatherKind = when (code) {
            0, 1 -> CLEAR
            2 -> PARTLY
            3 -> CLOUDY
            45, 48 -> FOG
            in 51..67, in 80..82 -> RAIN
            in 71..77, 85, 86 -> SNOW
            in 95..99 -> STORM
            else -> CLEAR
        }

        /** Rough cloud cover (0..1) implied by a WMO code when the API doesn't send one. */
        fun cloudCoverFor(code: Int): Float = when (code) {
            0 -> 0f
            1 -> 0.15f
            2 -> 0.45f
            else -> 0.9f
        }
    }
}

/** Colors of the sky at one moment of the day. */
data class SkyPalette(
    val top: Int,
    val mid: Int,
    val bottom: Int,
    val cloud: Int,
    val glow: Int,
    val stars: Float,
)

data class SunTimes(val sunrise: Long, val sunset: Long, val nextSunrise: Long) {
    val isUsable get() = sunset > sunrise && nextSunrise > sunset

    fun isDay(t: Long) = t in sunrise until sunset

    /** 0..1 across the day arc (sun) or the night arc (moon). */
    fun arcProgress(t: Long): Float = if (isDay(t)) {
        (t - sunrise).toFloat() / (sunset - sunrise)
    } else {
        val nightStart = if (t >= sunset) sunset else sunset - DAY
        val nightEnd = if (t >= sunset) nextSunrise else sunrise
        ((t - nightStart).toFloat() / (nightEnd - nightStart)).coerceIn(0f, 1f)
    }

    /** Same sun times shifted onto whichever day [t] falls in (used by the preview fast-forward). */
    fun alignedTo(t: Long): SunTimes {
        var shift = 0L
        while (t < sunrise + shift - DAY / 2) shift -= DAY
        while (t > sunset + shift + DAY / 2) shift += DAY
        return SunTimes(sunrise + shift, sunset + shift, nextSunrise + shift)
    }

    companion object {
        const val DAY = 24 * 60 * 60_000L

        /** Placeholder until the forecast tells us the real times. */
        fun estimate(now: Long): SunTimes {
            val cal = Calendar.getInstance().apply {
                timeInMillis = now
                set(Calendar.HOUR_OF_DAY, 6); set(Calendar.MINUTE, 50)
                set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
            }
            val sunrise = cal.timeInMillis
            val sunset = sunrise + (11 * 60 + 20) * 60_000L
            return SunTimes(sunrise, sunset, sunrise + DAY)
        }
    }
}

object SkyPalettes {
    private fun c(hex: String) = Color.parseColor(hex)

    val NIGHT = SkyPalette(c("#03060F"), c("#0A1230"), c("#17224A"), c("#283150"), c("#C9D6FF"), 1f)
    val PREDAWN = SkyPalette(c("#0B1235"), c("#2A2C60"), c("#6E4C7E"), c("#625382"), c("#FFB9A0"), 0.45f)
    val SUNRISE = SkyPalette(c("#283B78"), c("#C46A7F"), c("#FFB47A"), c("#FFC7AA"), c("#FFB070"), 0f)
    val MORNING = SkyPalette(c("#3474CF"), c("#78ADE6"), c("#D3E6F6"), c("#FFFFFF"), c("#FFF2D0"), 0f)
    val MIDDAY = SkyPalette(c("#1F63C9"), c("#549BEA"), c("#A6D0F8"), c("#FFFFFF"), c("#FFFFFF"), 0f)
    val GOLDEN = SkyPalette(c("#2F5EAE"), c("#D99A6C"), c("#FFD397"), c("#FFE3C4"), c("#FFCF85"), 0f)
    val SUNSET = SkyPalette(c("#232768"), c("#B04F7A"), c("#FF875A"), c("#FFB096"), c("#FF8A55"), 0f)
    val DUSK = SkyPalette(c("#0E1640"), c("#35296A"), c("#844B78"), c("#4F4176"), c("#E79AA0"), 0.4f)

    private val STORM_GRAY = c("#5A6680")

    /** Palette for time [t], blended between keyframes anchored to sunrise and sunset. */
    fun at(t: Long, sun: SunTimes): SkyPalette {
        val m = 60_000L
        val noon = (sun.sunrise + sun.sunset) / 2
        val keys = listOf(
            sun.sunrise - 90 * m to NIGHT,
            sun.sunrise - 40 * m to PREDAWN,
            sun.sunrise to SUNRISE,
            min(sun.sunrise + 70 * m, noon - 1) to MORNING,
            noon to MIDDAY,
            max(sun.sunset - 80 * m, noon + 1) to GOLDEN,
            sun.sunset to SUNSET,
            sun.sunset + 30 * m to DUSK,
            sun.sunset + 85 * m to NIGHT,
        )
        if (t <= keys.first().first || t >= keys.last().first) return NIGHT
        val i = keys.indexOfLast { it.first <= t }
        val (t0, a) = keys[i]
        val (t1, b) = keys[i + 1]
        return blend(a, b, (t - t0).toFloat() / (t1 - t0))
    }

    /** Desaturates and darkens a palette for cloudy, rainy or stormy skies. */
    fun weathered(p: SkyPalette, kind: WeatherKind, cloudCover: Float): SkyPalette {
        val o = max(kind.overcast, cloudCover * 0.55f).coerceIn(0f, 1f)
        val dark = when (kind) {
            WeatherKind.STORM -> 0.22f
            WeatherKind.RAIN -> 0.18f
            WeatherKind.CLOUDY -> 0.08f
            else -> 0f
        }
        fun adj(color: Int) = darken(lerp(color, gray(color), o * 0.85f), dark)
        return SkyPalette(
            top = adj(p.top),
            mid = adj(p.mid),
            bottom = adj(p.bottom),
            cloud = darken(lerp(p.cloud, lerp(STORM_GRAY, p.cloud, 0.35f), o), dark * 0.6f),
            glow = p.glow,
            stars = p.stars * (1f - o).coerceAtLeast(0f),
        )
    }

    fun blend(a: SkyPalette, b: SkyPalette, f: Float) = SkyPalette(
        lerp(a.top, b.top, f), lerp(a.mid, b.mid, f), lerp(a.bottom, b.bottom, f),
        lerp(a.cloud, b.cloud, f), lerp(a.glow, b.glow, f), a.stars + (b.stars - a.stars) * f,
    )

    fun lerp(a: Int, b: Int, f: Float): Int {
        val t = f.coerceIn(0f, 1f)
        fun ch(shift: Int) = ((a shr shift and 0xFF) + ((b shr shift and 0xFF) - (a shr shift and 0xFF)) * t).toInt()
        return Color.argb(ch(24), ch(16), ch(8), ch(0))
    }

    /** Perceived brightness 0..1. */
    fun luma(color: Int) = (0.299f * Color.red(color) + 0.587f * Color.green(color) + 0.114f * Color.blue(color)) / 255f

    private fun gray(color: Int): Int {
        val l = (luma(color) * 255).toInt()
        // Slightly cool gray reads as "overcast" rather than "broken screen".
        return Color.argb(Color.alpha(color), (l * 0.96f).toInt(), (l * 0.99f).toInt(), min(255, (l * 1.06f).toInt()))
    }

    private fun darken(color: Int, f: Float) = lerp(color, Color.BLACK, f)
}
