package com.pulsepointlabs.dexclock

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

data class Weather(val temp: Int, val code: Int, val day: Boolean)
data class Place(val name: String, val lat: Double, val lon: Double)

/**
 * Open-Meteo: free, no API key, no account. Calls are blocking, so run them off the
 * main thread.
 */
object WeatherApi {

    fun current(lat: Double, lon: Double, celsius: Boolean): Weather {
        val unit = if (celsius) "celsius" else "fahrenheit"
        val json = get(
            "https://api.open-meteo.com/v1/forecast?latitude=$lat&longitude=$lon" +
                "&current=temperature_2m,weather_code,is_day&temperature_unit=$unit"
        )
        val c = json.getJSONObject("current")
        return Weather(
            temp = Math.round(c.getDouble("temperature_2m")).toInt(),
            code = c.getInt("weather_code"),
            day = c.optInt("is_day", 1) == 1,
        )
    }

    /** City name or postal code -> best match, or null. */
    fun search(query: String): Place? {
        val q = URLEncoder.encode(query.trim(), "UTF-8")
        val results = get("https://geocoding-api.open-meteo.com/v1/search?name=$q&count=1")
            .optJSONArray("results") ?: return null
        if (results.length() == 0) return null
        val r = results.getJSONObject(0)
        val region = r.optString("admin1").ifBlank { r.optString("country") }
        val name = listOf(r.getString("name"), region).filter { it.isNotBlank() }.joinToString(", ")
        return Place(name, r.getDouble("latitude"), r.getDouble("longitude"))
    }

    private fun get(url: String): JSONObject {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 10_000
        conn.readTimeout = 10_000
        try {
            if (conn.responseCode != 200) error("HTTP ${conn.responseCode}")
            return JSONObject(conn.inputStream.bufferedReader().use { it.readText() })
        } finally {
            conn.disconnect()
        }
    }
}
