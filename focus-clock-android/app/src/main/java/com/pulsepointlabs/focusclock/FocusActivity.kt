package com.pulsepointlabs.focusclock

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.graphics.Color
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.text.format.DateFormat
import android.util.TypedValue
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.widget.EditText
import android.widget.TextView
import java.util.Calendar
import java.util.Locale
import java.util.concurrent.Executors
import kotlin.random.Random

class FocusActivity : Activity() {

    private lateinit var prefs: SharedPreferences
    private lateinit var root: View
    private lateinit var sky: SkyView
    private lateinit var content: View
    private lateinit var timeView: TextView
    private lateinit var ampmView: TextView
    private lateinit var dateView: TextView
    private lateinit var weatherView: View
    private lateinit var nowIcon: WeatherIconView
    private lateinit var nowTemp: TextView
    private lateinit var nowDetail: TextView
    private lateinit var tomorrowIcon: WeatherIconView
    private lateinit var tomorrowTemp: TextView
    private lateinit var tomorrowDetail: TextView
    private lateinit var statusView: TextView
    private lateinit var previewBadge: TextView
    private val shadowed = mutableListOf<TextView>()
    private val cards = mutableListOf<View>()

    private val handler = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private var lastWeather: WeatherReport? = null
    private var lastWeatherAt = 0L
    private var lastShiftMinute = -1
    private var previewStartedAt = 0L

    private val timeOnly get() = prefs.getBoolean(KEY_TIME_ONLY, false)
    private val use24h get() = prefs.getBoolean(KEY_24H, DateFormat.is24HourFormat(this))
    private val fahrenheit get() = prefs.getBoolean(KEY_FAHRENHEIT, Locale.getDefault().country in FAHRENHEIT_COUNTRIES)
    private val showSeconds get() = prefs.getBoolean(KEY_SECONDS, false)
    private val dim get() = prefs.getBoolean(KEY_DIM, false)
    private val previewing get() = previewStartedAt != 0L

    private val tick = object : Runnable {
        override fun run() {
            renderClock(Calendar.getInstance())
            if (System.currentTimeMillis() - lastWeatherAt > WEATHER_REFRESH_MS) refreshWeather()
            val step = if (showSeconds) 1_000L else 60_000L
            handler.postDelayed(this, step - System.currentTimeMillis() % step + 20)
        }
    }

    /** Fast-forwards a whole day (and every kind of weather) so the skies can be checked at a glance. */
    private val previewTick = object : Runnable {
        override fun run() {
            val elapsed = System.currentTimeMillis() - previewStartedAt
            val dayStart = Calendar.getInstance().apply {
                timeInMillis = previewStartedAt
                set(Calendar.HOUR_OF_DAY, 4); set(Calendar.MINUTE, 0)
            }.timeInMillis
            val sim = dayStart + elapsed * PREVIEW_SPEED
            val kinds = WeatherKind.values()
            val kind = kinds[((elapsed / PREVIEW_WEATHER_MS) % kinds.size).toInt()]
            sky.timeOverride = sim
            sky.setWeather(kind, when (kind) {
                WeatherKind.CLEAR -> 0.1f
                WeatherKind.PARTLY -> 0.45f
                else -> 0.9f
            })
            val cal = Calendar.getInstance().apply { timeInMillis = sim }
            renderClock(cal)
            previewBadge.text = "Preview · ${kind.label} · tap to exit"
            handler.postDelayed(this, 250)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(R.layout.activity_focus)
        prefs = getSharedPreferences("focus", Context.MODE_PRIVATE)

        root = findViewById(R.id.root)
        sky = findViewById(R.id.sky)
        content = findViewById(R.id.content)
        timeView = findViewById(R.id.time)
        ampmView = findViewById(R.id.ampm)
        dateView = findViewById(R.id.date)
        weatherView = findViewById(R.id.weather)
        nowIcon = findViewById(R.id.nowIcon)
        nowTemp = findViewById(R.id.nowTemp)
        nowDetail = findViewById(R.id.nowDetail)
        tomorrowIcon = findViewById(R.id.tomorrowIcon)
        tomorrowTemp = findViewById(R.id.tomorrowTemp)
        tomorrowDetail = findViewById(R.id.tomorrowDetail)
        statusView = findViewById(R.id.status)
        previewBadge = findViewById(R.id.previewBadge)
        cards += listOf(findViewById(R.id.nowCard), findViewById<View>(R.id.tomorrowCard), previewBadge)
        shadowed += listOf(timeView, ampmView, dateView, nowTemp, nowDetail, tomorrowTemp, tomorrowDetail, statusView)

        root.setOnClickListener {
            if (previewing) return@setOnClickListener stopPreview()
            prefs.edit().putBoolean(KEY_TIME_ONLY, !timeOnly).apply()
            applyMode()
        }
        root.setOnLongClickListener { showSettings(); true }
        root.addOnLayoutChangeListener { _, l, t, r, b, ol, ot, or, ob ->
            if (r - l != or - ol || b - t != ob - ot) sizeClock()
        }
        sky.onLumaChanged = ::tuneContrast

        applyMode()
        applyDim()
    }

    override fun onResume() {
        super.onResume()
        hideSystemBars()
        sky.animating = true
        handler.removeCallbacks(tick)
        handler.post(tick)
    }

    override fun onPause() {
        super.onPause()
        sky.animating = false
        handler.removeCallbacks(tick)
        if (previewing) stopPreview()
    }

    override fun onDestroy() {
        super.onDestroy()
        io.shutdownNow()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    // ---- Clock ----

    private fun renderClock(now: Calendar) {
        val seconds = showSeconds && !previewing
        val pattern = when {
            use24h && seconds -> "HH:mm:ss"
            use24h -> "HH:mm"
            seconds -> "h:mm:ss"
            else -> "h:mm"
        }
        timeView.text = DateFormat.format(pattern, now)
        ampmView.text = if (use24h) "" else DateFormat.format("a", now).toString().uppercase()
        ampmView.visibility = if (use24h) View.GONE else View.VISIBLE
        dateView.text = DateFormat.format("EEEE, MMMM d", now)

        val minute = now.get(Calendar.MINUTE)
        if (!previewing && minute != lastShiftMinute) {
            lastShiftMinute = minute
            shiftForBurnIn()
        }
    }

    private fun sizeClock() {
        val shortEdge = minOf(root.width, root.height).toFloat()
        if (shortEdge <= 0f) return
        val ratioRes = if (timeOnly) R.dimen.time_only_size_ratio else R.dimen.time_size_ratio
        var size = shortEdge * resources.getFloat(ratioRes)
        if (showSeconds) size *= 0.72f
        timeView.setTextSize(TypedValue.COMPLEX_UNIT_PX, size)
        ampmView.setTextSize(TypedValue.COMPLEX_UNIT_PX, size * 0.13f)
    }

    /** Nudges everything a few pixels each minute so a screen left on doesn't burn in. */
    private fun shiftForBurnIn() {
        val max = resources.getDimension(R.dimen.burn_in_shift)
        content.animate()
            .translationX(Random.nextFloat() * 2 * max - max)
            .translationY(Random.nextFloat() * 2 * max - max)
            .setDuration(1_500)
            .start()
    }

    /** Bright daytime skies get a stronger text shadow so white type stays readable. */
    private fun tuneContrast(luma: Float) {
        val alpha = (70 + luma * 150).toInt().coerceIn(60, 190)
        val radius = 10f + luma * 16f
        for (v in shadowed) v.setShadowLayer(radius, 0f, 2f, Color.argb(alpha, 4, 10, 30))
        Glass.tint(cards, luma)
    }

    private fun applyMode() {
        val gone = if (timeOnly) View.GONE else View.VISIBLE
        dateView.visibility = gone
        weatherView.visibility = gone
        statusView.visibility = if (timeOnly || statusView.text.isNullOrEmpty()) View.GONE else View.VISIBLE
        sizeClock()
        renderClock(Calendar.getInstance())
    }

    private fun applyDim() {
        window.attributes = window.attributes.apply {
            screenBrightness = if (dim) 0.05f else WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
        }
        content.alpha = if (dim) 0.6f else 1f
        sky.dimmed = dim
    }

    // ---- Preview ----

    private fun startPreview() {
        previewStartedAt = System.currentTimeMillis()
        handler.removeCallbacks(tick)
        previewBadge.visibility = View.VISIBLE
        handler.post(previewTick)
    }

    private fun stopPreview() {
        previewStartedAt = 0L
        handler.removeCallbacks(previewTick)
        previewBadge.visibility = View.GONE
        sky.timeOverride = null
        val w = lastWeather
        if (w != null) sky.setWeather(WeatherKind.fromCode(w.currentCode), w.cloudCover) else sky.setWeather(WeatherKind.CLEAR, 0f)
        handler.post(tick)
    }

    // ---- Weather ----

    private fun refreshWeather() {
        lastWeatherAt = System.currentTimeMillis()
        val manualLat = prefs.getString(KEY_PLACE_LAT, null)?.toDoubleOrNull()
        val manualLon = prefs.getString(KEY_PLACE_LON, null)?.toDoubleOrNull()
        if (manualLat != null && manualLon != null) {
            fetchWeather(manualLat, manualLon)
            return
        }
        if (checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.ACCESS_COARSE_LOCATION), REQ_LOCATION)
            return
        }
        withDeviceLocation { loc ->
            if (loc == null) {
                setStatus("No location yet — long-press to set a city")
                lastWeatherAt = System.currentTimeMillis() - WEATHER_REFRESH_MS + RETRY_MS
            } else {
                fetchWeather(loc.latitude, loc.longitude)
            }
        }
    }

    @Suppress("MissingPermission")
    private fun withDeviceLocation(done: (Location?) -> Unit) {
        val lm = getSystemService(LocationManager::class.java)
        val providers = lm.getProviders(true)
        val cached = providers.mapNotNull { runCatching { lm.getLastKnownLocation(it) }.getOrNull() }
            .maxByOrNull { it.time }
        if (cached != null) return done(cached)

        val provider = listOf(LocationManager.NETWORK_PROVIDER, LocationManager.FUSED_PROVIDER, LocationManager.GPS_PROVIDER)
            .firstOrNull { it in providers } ?: return done(null)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            lm.getCurrentLocation(provider, null, mainExecutor) { done(it) }
        } else {
            @Suppress("DEPRECATION")
            lm.requestSingleUpdate(provider, { done(it) }, Looper.getMainLooper())
        }
    }

    private fun fetchWeather(lat: Double, lon: Double) {
        val f = fahrenheit
        io.execute {
            val result = runCatching { Weather.fetch(lat, lon, f) }
            handler.post {
                result.onSuccess {
                    lastWeather = it
                    renderWeather(it)
                    setStatus(null)
                }.onFailure {
                    // Keep showing the last good forecast; just retry sooner.
                    lastWeatherAt = System.currentTimeMillis() - WEATHER_REFRESH_MS + RETRY_MS
                    if (lastWeather == null) setStatus("Weather unavailable — retrying")
                }
            }
        }
    }

    private fun renderWeather(w: WeatherReport) {
        val nowKind = WeatherKind.fromCode(w.currentCode)
        sky.setSunTimes(w.sun)
        if (!previewing) sky.setWeather(nowKind, w.cloudCover)

        nowIcon.set(nowKind, w.isDay)
        nowTemp.text = "${w.currentTemp}°"
        nowDetail.text = "${Weather.describe(w.currentCode)}\nH ${w.today.high}°  ·  L ${w.today.low}°"

        tomorrowIcon.set(WeatherKind.fromCode(w.tomorrow.code), true)
        tomorrowTemp.text = "${w.tomorrow.high}°"
        val rain = w.tomorrow.precipChance?.takeIf { it >= 20 }?.let { "  ·  $it%" } ?: ""
        tomorrowDetail.text = "${Weather.describe(w.tomorrow.code)}$rain\nLow ${w.tomorrow.low}°"
    }

    private fun setStatus(text: String?) {
        statusView.text = text ?: ""
        statusView.visibility = if (text == null || timeOnly) View.GONE else View.VISIBLE
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_LOCATION) return
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
            refreshWeather()
        } else {
            setStatus("Location off — long-press to set a city")
        }
    }

    // ---- Settings ----

    private fun showSettings() {
        val place = prefs.getString(KEY_PLACE_NAME, null)
        val items = arrayOf(
            if (timeOnly) "Show date & weather" else "Time only",
            if (use24h) "Use 12-hour time" else "Use 24-hour time",
            if (showSeconds) "Hide seconds" else "Show seconds",
            if (fahrenheit) "Use °C" else "Use °F",
            if (dim) "Normal brightness" else "Night dim",
            if (place != null) "City: $place (change)" else "Set city manually",
            "Use device location",
            "Preview skies",
        )
        AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setItems(items) { _, which ->
                when (which) {
                    0 -> { toggle(KEY_TIME_ONLY, timeOnly); applyMode() }
                    1 -> { toggle(KEY_24H, use24h); renderClock(Calendar.getInstance()) }
                    2 -> { toggle(KEY_SECONDS, showSeconds); sizeClock(); handler.removeCallbacks(tick); handler.post(tick) }
                    3 -> { toggle(KEY_FAHRENHEIT, fahrenheit); refreshWeather() }
                    4 -> { toggle(KEY_DIM, dim); applyDim() }
                    5 -> askForCity()
                    6 -> {
                        prefs.edit().remove(KEY_PLACE_NAME).remove(KEY_PLACE_LAT).remove(KEY_PLACE_LON).apply()
                        refreshWeather()
                    }
                    7 -> startPreview()
                }
            }
            .setOnDismissListener { hideSystemBars() }
            .show()
    }

    private fun toggle(key: String, current: Boolean) = prefs.edit().putBoolean(key, !current).apply()

    private fun askForCity() {
        val input = EditText(this).apply {
            hint = "City or ZIP"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_WORDS
            setText(prefs.getString(KEY_PLACE_NAME, ""))
        }
        AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle("Weather location")
            .setView(input)
            .setPositiveButton("Save") { _, _ ->
                val query = input.text.toString().trim()
                if (query.isEmpty()) return@setPositiveButton
                setStatus("Looking up $query…")
                io.execute {
                    val place = runCatching { Weather.searchPlace(query) }.getOrNull()
                    handler.post {
                        if (place == null) {
                            setStatus("Couldn't find \"$query\"")
                        } else {
                            prefs.edit()
                                .putString(KEY_PLACE_NAME, place.name)
                                .putString(KEY_PLACE_LAT, place.latitude.toString())
                                .putString(KEY_PLACE_LON, place.longitude.toString())
                                .apply()
                            refreshWeather()
                        }
                    }
                }
            }
            .setNegativeButton("Cancel", null)
            .setOnDismissListener { hideSystemBars() }
            .show()
    }

    // ---- Fullscreen ----

    private fun hideSystemBars() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false)
            window.insetsController?.apply {
                hide(WindowInsets.Type.systemBars())
                systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION)
        }
    }

    companion object {
        private const val REQ_LOCATION = 1
        private const val WEATHER_REFRESH_MS = 30 * 60_000L
        private const val RETRY_MS = 2 * 60_000L
        private const val PREVIEW_SPEED = 1_800L        // 30 sim-minutes per real second
        private const val PREVIEW_WEATHER_MS = 9_000L   // next weather type every 9 s
        private val FAHRENHEIT_COUNTRIES = setOf("US", "LR", "MM", "BS", "BZ", "KY", "PW")

        private const val KEY_TIME_ONLY = "time_only"
        private const val KEY_24H = "use_24h"
        private const val KEY_SECONDS = "show_seconds"
        private const val KEY_FAHRENHEIT = "fahrenheit"
        private const val KEY_DIM = "dim"
        private const val KEY_PLACE_NAME = "place_name"
        private const val KEY_PLACE_LAT = "place_lat"
        private const val KEY_PLACE_LON = "place_lon"
    }
}
