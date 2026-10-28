package com.pulsepointlabs.focusclock

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.time.LocalDateTime
import java.time.ZoneOffset
import kotlin.math.roundToInt

data class DayForecast(val code: Int, val high: Int, val low: Int, val precipChance: Int?)

data class WeatherReport(
    val currentTemp: Int,
    val feelsLike: Int,
    val currentCode: Int,
    val cloudCover: Float,
    val isDay: Boolean,
    val today: DayForecast,
    val tomorrow: DayForecast,
    val sun: SunTimes,
)

data class Place(val name: String, val latitude: Double, val longitude: Double)

/** Open-Meteo: free, no API key. Call from a background thread. */
object Weather {

    fun fetch(lat: Double, lon: Double, fahrenheit: Boolean): WeatherReport {
        val unit = if (fahrenheit) "fahrenheit" else "celsius"
        val url = "https://api.open-meteo.com/v1/forecast" +
            "?latitude=$lat&longitude=$lon" +
            "&current=temperature_2m,apparent_temperature,weather_code,cloud_cover,is_day" +
            "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset" +
            "&temperature_unit=$unit&timezone=auto&forecast_days=2"
        val json = JSONObject(get(url))
        val current = json.getJSONObject("current")
        val daily = json.getJSONObject("daily")
        val offset = ZoneOffset.ofTotalSeconds(json.optInt("utc_offset_seconds", 0))
        fun epoch(key: String, i: Int) =
            LocalDateTime.parse(daily.getJSONArray(key).getString(i)).toEpochSecond(offset) * 1000

        fun day(i: Int) = DayForecast(
            code = daily.getJSONArray("weather_code").getInt(i),
            high = daily.getJSONArray("temperature_2m_max").getDouble(i).roundToInt(),
            low = daily.getJSONArray("temperature_2m_min").getDouble(i).roundToInt(),
            precipChance = daily.optJSONArray("precipitation_probability_max")
                ?.takeUnless { it.isNull(i) }?.getInt(i),
        )

        return WeatherReport(
            currentTemp = current.getDouble("temperature_2m").roundToInt(),
            feelsLike = current.getDouble("apparent_temperature").roundToInt(),
            currentCode = current.getInt("weather_code"),
            cloudCover = if (current.has("cloud_cover")) current.getDouble("cloud_cover").toFloat() / 100f
                else WeatherKind.cloudCoverFor(current.getInt("weather_code")),
            isDay = current.optInt("is_day", 1) == 1,
            today = day(0),
            tomorrow = day(1),
            sun = SunTimes(epoch("sunrise", 0), epoch("sunset", 0), epoch("sunrise", 1)),
        )
    }

    fun searchPlace(query: String): Place? {
        val url = "https://geocoding-api.open-meteo.com/v1/search?count=1&format=json&name=" +
            URLEncoder.encode(query, "UTF-8")
        val results = JSONObject(get(url)).optJSONArray("results") ?: return null
        if (results.length() == 0) return null
        val r = results.getJSONObject(0)
        val region = r.optString("admin1").takeIf { it.isNotBlank() }
        return Place(
            name = listOfNotNull(r.getString("name"), region).joinToString(", "),
            latitude = r.getDouble("latitude"),
            longitude = r.getDouble("longitude"),
        )
    }

    /** WMO weather interpretation codes. */
    fun describe(code: Int): String = when (code) {
        0 -> "Clear"
        1 -> "Mostly clear"
        2 -> "Partly cloudy"
        3 -> "Overcast"
        45, 48 -> "Fog"
        51, 53, 55 -> "Drizzle"
        56, 57 -> "Freezing drizzle"
        61 -> "Light rain"
        63 -> "Rain"
        65 -> "Heavy rain"
        66, 67 -> "Freezing rain"
        71 -> "Light snow"
        73 -> "Snow"
        75 -> "Heavy snow"
        77 -> "Snow grains"
        80, 81 -> "Showers"
        82 -> "Heavy showers"
        85, 86 -> "Snow showers"
        95 -> "Thunderstorms"
        96, 99 -> "Storms with hail"
        else -> "—"
    }

    private fun get(url: String): String {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 10_000
        conn.readTimeout = 10_000
        try {
            if (conn.responseCode !in 200..299) error("HTTP ${conn.responseCode}")
            return conn.inputStream.bufferedReader().use { it.readText() }
        } finally {
            conn.disconnect()
        }
    }
}
