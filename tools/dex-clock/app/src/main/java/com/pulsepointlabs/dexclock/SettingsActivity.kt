package com.pulsepointlabs.dexclock

import android.Manifest
import android.app.Activity
import android.app.TimePickerDialog
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.location.Geocoder
import android.location.Location
import android.location.LocationManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.WindowInsets
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.Button
import android.widget.SeekBar
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast

class SettingsActivity : Activity(), SharedPreferences.OnSharedPreferenceChangeListener {

    private lateinit var prefs: SharedPreferences
    private lateinit var toggle: Button
    private lateinit var status: TextView
    private lateinit var size: SeekBar
    private lateinit var sizeVal: TextView
    private val handler = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)
        prefs = Prefs.get(this)

        // Android 15 draws edge-to-edge; keep content clear of the status/nav bars.
        findViewById<android.view.View>(R.id.root).setOnApplyWindowInsetsListener { v, insets ->
            val b = insets.getInsets(WindowInsets.Type.systemBars())
            v.setPadding(b.left, b.top, b.right, b.bottom)
            insets
        }

        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }

        toggle = findViewById(R.id.toggle)
        status = findViewById(R.id.status)
        toggle.setOnClickListener { onToggle() }

        slider(R.id.opacity, R.id.opacityVal, Prefs.OPACITY, 100)
        slider(R.id.bg, R.id.bgVal, Prefs.BG, 62)
        slider(R.id.tint, R.id.tintVal, Prefs.TINT, 50)
        size = slider(R.id.size, R.id.sizeVal, Prefs.SIZE, 100)
        sizeVal = findViewById(R.id.sizeVal)

        findViewById<Switch>(R.id.boot).apply {
            isChecked = prefs.getBoolean(Prefs.BOOT, true)
            setOnCheckedChangeListener { _, on -> prefs.edit().putBoolean(Prefs.BOOT, on).apply() }
        }
        setupWeather()
        setupBedtime()

        findViewById<Button>(R.id.reset).setOnClickListener {
            prefs.edit().putLong(Prefs.RESET, System.currentTimeMillis()).apply()
        }
        findViewById<Button>(R.id.battery).setOnClickListener {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
        }
    }

    private fun slider(id: Int, labelId: Int, key: String, def: Int): SeekBar {
        val bar = findViewById<SeekBar>(id)
        val label = findViewById<TextView>(labelId)
        bar.progress = prefs.getInt(key, def)
        label.text = "${bar.progress}%"
        bar.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(s: SeekBar, p: Int, fromUser: Boolean) {
                label.text = "$p%"
                if (fromUser) prefs.edit().putInt(key, p).apply()
            }
            override fun onStartTrackingTouch(s: SeekBar) {}
            override fun onStopTrackingTouch(s: SeekBar) {}
        })
        return bar
    }

    // ---------------------------------------------------------------- bedtime

    private fun setupBedtime() {
        findViewById<Switch>(R.id.bedOn).apply {
            isChecked = prefs.getBoolean(Prefs.BED_ON, false)
            setOnCheckedChangeListener { _, on -> prefs.edit().putBoolean(Prefs.BED_ON, on).apply() }
        }
        val btn = findViewById<Button>(R.id.bedTime)
        fun show() {
            val m = prefs.getInt(Prefs.BED_TIME, Prefs.BED_DEFAULT)
            btn.text = "%02d:%02d".format(m / 60, m % 60)
        }
        show()
        btn.setOnClickListener {
            val m = prefs.getInt(Prefs.BED_TIME, Prefs.BED_DEFAULT)
            TimePickerDialog(this, { _, h, min ->
                prefs.edit().putInt(Prefs.BED_TIME, h * 60 + min).apply()
                show()
            }, m / 60, m % 60, true).show()
        }
    }

    // ---------------------------------------------------------------- weather

    private lateinit var place: TextView

    private fun setupWeather() {
        place = findViewById(R.id.place)
        findViewById<Switch>(R.id.weather).apply {
            isChecked = prefs.getBoolean(Prefs.WEATHER, true)
            setOnCheckedChangeListener { _, on -> prefs.edit().putBoolean(Prefs.WEATHER, on).apply() }
        }
        findViewById<Switch>(R.id.celsius).apply {
            isChecked = prefs.getBoolean(Prefs.CELSIUS, false)
            setOnCheckedChangeListener { _, on -> prefs.edit().putBoolean(Prefs.CELSIUS, on).apply() }
        }
        findViewById<Button>(R.id.locate).setOnClickListener {
            if (checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
                locate()
            } else {
                requestPermissions(arrayOf(Manifest.permission.ACCESS_COARSE_LOCATION), 2)
            }
        }
        val query = findViewById<EditText>(R.id.query)
        val go = {
            val q = query.text.toString()
            if (q.isNotBlank()) {
                getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(query.windowToken, 0)
                search(q)
            }
        }
        findViewById<Button>(R.id.search).setOnClickListener { go() }
        query.setOnEditorActionListener { _, action, _ ->
            if (action == EditorInfo.IME_ACTION_SEARCH) { go(); true } else false
        }
        showPlace()
    }

    private fun showPlace() {
        place.text = prefs.getString(Prefs.PLACE, null)?.let { "Weather for $it" }
            ?: "No location yet. Pick one below."
    }

    override fun onRequestPermissionsResult(code: Int, perms: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(code, perms, results)
        if (code == 2) {
            if (results.firstOrNull() == PackageManager.PERMISSION_GRANTED) locate()
            else place.text = "No location permission. Type a city or ZIP instead."
        }
    }

    /** One-shot location fix. Coarse is plenty for weather. */
    @Suppress("MissingPermission")
    private fun locate() {
        place.text = "Finding you…"
        val lm = getSystemService(LocationManager::class.java)
        val provider = listOf(LocationManager.FUSED_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER)
            .firstOrNull { runCatching { lm.isProviderEnabled(it) }.getOrDefault(false) }
        val fallback = {
            listOf(LocationManager.FUSED_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER)
                .mapNotNull { runCatching { lm.getLastKnownLocation(it) }.getOrNull() }
                .maxByOrNull { it.time }
        }
        if (provider == null) { gotLocation(fallback()); return }
        lm.getCurrentLocation(provider, null, mainExecutor) { loc -> gotLocation(loc ?: fallback()) }
    }

    private fun gotLocation(loc: Location?) {
        if (loc == null) {
            place.text = "Couldn't get a location. Is Location turned on? Or type a city or ZIP."
            return
        }
        val lat = loc.latitude; val lon = loc.longitude
        val save = { name: String -> runOnUiThread { savePlace(Place(name, lat, lon)) } }
        val coords = "%.2f, %.2f".format(lat, lon)
        if (!Geocoder.isPresent()) { save(coords); return }
        runCatching {
            Geocoder(this).getFromLocation(lat, lon, 1, object : Geocoder.GeocodeListener {
                override fun onGeocode(list: MutableList<android.location.Address>) {
                    val a = list.firstOrNull()
                    val town = a?.locality ?: a?.subAdminArea
                    save(listOfNotNull(town, a?.adminArea).joinToString(", ").ifBlank { coords })
                }
                override fun onError(msg: String?) = save(coords)
            })
        }.onFailure { save(coords) }
    }

    private fun search(q: String) {
        place.text = "Looking up \"$q\"…"
        Thread {
            val found = runCatching { WeatherApi.search(q) }
            runOnUiThread {
                found.getOrNull()?.let { savePlace(it) }
                    ?: run { place.text = if (found.isFailure) "Couldn't reach the weather service. Online?" else "Couldn't find \"$q\"." }
            }
        }.start()
    }

    private fun savePlace(p: Place) {
        prefs.edit()
            .putFloat(Prefs.LAT, p.lat.toFloat())
            .putFloat(Prefs.LON, p.lon.toFloat())
            .putString(Prefs.PLACE, p.name)
            .remove(Prefs.W_CACHE)
            .apply()
        showPlace()
    }

    override fun onResume() {
        super.onResume()
        prefs.registerOnSharedPreferenceChangeListener(this)
        // Coming back from the "display over other apps" screen? Start right away.
        if (pendingStart && Settings.canDrawOverlays(this)) startClock()
        pendingStart = false
        handler.postDelayed(::refresh, 150)
    }

    override fun onPause() {
        prefs.unregisterOnSharedPreferenceChangeListener(this)
        super.onPause()
    }

    // Keep the size slider honest when the clock is resized by dragging / wheel / pinch.
    override fun onSharedPreferenceChanged(p: SharedPreferences, key: String?) {
        if (key == Prefs.SIZE) size.progress = p.getInt(key, 100)
    }

    private var pendingStart = false

    private fun onToggle() {
        if (ClockService.running) {
            startService(Intent(this, ClockService::class.java).setAction(ClockService.ACTION_STOP))
        } else if (!Settings.canDrawOverlays(this)) {
            pendingStart = true
            Toast.makeText(this, "Turn on \"Allow display over other apps\", then come back", Toast.LENGTH_LONG).show()
            startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
            return
        } else {
            startClock()
        }
        handler.postDelayed(::refresh, 300)
    }

    private fun refresh() {
        val on = ClockService.running
        toggle.text = if (on) "Hide clock" else "Show clock"
        status.text = when {
            !Settings.canDrawOverlays(this) -> "Needs permission to float over other apps"
            on -> "Floating. Drag it anywhere."
            else -> "Hidden"
        }
    }
}
