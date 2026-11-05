package com.pulsepointlabs.dexclock

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.WindowInsets
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
        size = slider(R.id.size, R.id.sizeVal, Prefs.SIZE, 100)
        sizeVal = findViewById(R.id.sizeVal)

        findViewById<Switch>(R.id.boot).apply {
            isChecked = prefs.getBoolean(Prefs.BOOT, true)
            setOnCheckedChangeListener { _, on -> prefs.edit().putBoolean(Prefs.BOOT, on).apply() }
        }
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
