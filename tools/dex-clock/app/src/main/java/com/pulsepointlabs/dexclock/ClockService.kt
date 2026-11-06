package com.pulsepointlabs.dexclock

import android.annotation.SuppressLint
import android.app.ActivityOptions
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.ServiceInfo
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.view.Display
import android.view.Gravity
import android.view.InputDevice
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.ViewConfiguration
import android.view.WindowManager
import java.util.concurrent.Executors
import kotlin.math.abs

/**
 * Keeps the clock floating on top of everything.
 *
 * DeX runs on the external monitor as its own Android "display". A plain overlay would
 * land on the phone screen, so we look for a non-phone display and put the clock there,
 * and hop back and forth as DeX connects / disconnects.
 */
class ClockService : Service(),
    SharedPreferences.OnSharedPreferenceChangeListener,
    DisplayManager.DisplayListener {

    companion object {
        const val ACTION_STOP = "com.pulsepointlabs.dexclock.STOP"
        private const val CHANNEL = "clock"
        private const val NOTIF_ID = 1
        private const val MIN_SCALE = 0.5f
        private const val MAX_SCALE = 3.0f
        private const val WEATHER_EVERY_MS = 20 * 60_000L
        private const val WEATHER_RETRY_MS = 5 * 60_000L
        private const val WEATHER_STALE_MS = 3 * 60 * 60_000L

        @Volatile var running = false
            private set
    }

    private val handler = Handler(Looper.getMainLooper())
    private lateinit var prefs: SharedPreferences
    private lateinit var displays: DisplayManager

    private var wm: WindowManager? = null
    private var view: ClockView? = null
    private var params: WindowManager.LayoutParams? = null
    private var displayId = Display.DEFAULT_DISPLAY
    private val external get() = displayId != Display.DEFAULT_DISPLAY
    private var density = 1f
    private var scale = 1f
    private var weather: Weather? = null
    private val io = Executors.newSingleThreadExecutor()
    private val weatherTick = Runnable { refreshWeather() }

    private val tick = object : Runnable {
        override fun run() {
            view?.invalidate()
            handler.postDelayed(this, 1000 - System.currentTimeMillis() % 1000 + 5)
        }
    }
    private val hideChrome = Runnable { view?.chrome = false }
    private val savePrefs = Runnable {
        val p = params ?: return@Runnable
        prefs.edit()
            .putInt(Prefs.xKey(external), p.x)
            .putInt(Prefs.yKey(external), p.y)
            .putInt(Prefs.SIZE, (scale * 100).toInt())
            .apply()
    }
    private val recheckDisplay = Runnable {
        val target = pickDisplay()
        if (target.displayId != displayId || view == null) {
            detach()
            attach(target)
        } else {
            clampAndUpdate()
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        running = true
        prefs = Prefs.get(this)
        displays = getSystemService(DisplayManager::class.java)
        startForeground(NOTIF_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)

        if (!Settings.canDrawOverlays(this)) { stopSelf(); return }

        scale = prefs.getInt(Prefs.SIZE, 100) / 100f
        weather = cachedWeather()
        attach(pickDisplay())
        handler.post(weatherTick)
        prefs.registerOnSharedPreferenceChangeListener(this)
        displays.registerDisplayListener(this, handler)
        handler.post(tick)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            prefs.edit().putBoolean(Prefs.WANTED, false).apply()
            stopSelf()
            return START_NOT_STICKY
        }
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        handler.removeCallbacksAndMessages(null)
        if (::prefs.isInitialized) prefs.unregisterOnSharedPreferenceChangeListener(this)
        if (::displays.isInitialized) displays.unregisterDisplayListener(this)
        detach()
        io.shutdownNow()
        super.onDestroy()
    }

    // ---------------------------------------------------------------- displays

    /** Prefer the DeX / external screen if there is one; otherwise the phone. */
    private fun pickDisplay(): Display {
        val ext = displays.displays
            .filter {
                it.displayId != Display.DEFAULT_DISPLAY &&
                    it.state == Display.STATE_ON &&
                    (it.flags and Display.FLAG_PRIVATE) == 0
            }
            .maxByOrNull { it.mode.physicalWidth.toLong() * it.mode.physicalHeight }
        return ext ?: displays.getDisplay(Display.DEFAULT_DISPLAY)
    }

    override fun onDisplayAdded(id: Int) = scheduleRecheck()
    override fun onDisplayRemoved(id: Int) = scheduleRecheck()
    override fun onDisplayChanged(id: Int) = scheduleRecheck()

    private fun scheduleRecheck() {
        handler.removeCallbacks(recheckDisplay)
        handler.postDelayed(recheckDisplay, 600)   // DeX fires a burst of these; settle first
    }

    // ---------------------------------------------------------------- window

    private fun attach(display: Display) {
        try {
            addWindow(display)
        } catch (e: Exception) {
            // Couldn't use that screen for some reason; fall back to the phone.
            detach()
            if (display.displayId != Display.DEFAULT_DISPLAY) {
                runCatching { addWindow(displays.getDisplay(Display.DEFAULT_DISPLAY)) }
            }
        }
    }

    private fun addWindow(display: Display) {
        val ctx = createDisplayContext(display)
            .createWindowContext(WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY, null)
        val windowManager = ctx.getSystemService(WindowManager::class.java)
        displayId = display.displayId
        density = ctx.resources.displayMetrics.density

        val v = ClockView(ctx).apply {
            scale = this@ClockService.scale
            alpha = prefs.getInt(Prefs.OPACITY, 100) / 100f
            bgAlpha = prefs.getInt(Prefs.BG, 62) / 100f
            tint = prefs.getInt(Prefs.TINT, 50) / 100f
            weather = this@ClockService.weather
        }
        val lp = WindowManager.LayoutParams(
            ClockView.windowW(density, scale),
            ClockView.windowH(density, scale),
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            title = "Floating Clock"
        }
        wm = windowManager; view = v; params = lp
        placeFromPrefs()
        wireInput(v)
        windowManager.addView(v, lp)
    }

    private fun detach() {
        val v = view ?: return
        runCatching { wm?.removeViewImmediate(v) }
        view = null; params = null; wm = null
    }

    private fun screen() = wm!!.currentWindowMetrics.bounds

    private fun placeFromPrefs() {
        val lp = params ?: return
        val x = prefs.getInt(Prefs.xKey(external), -1)
        val y = prefs.getInt(Prefs.yKey(external), -1)
        if (x < 0 || y < 0) {
            lp.x = screen().width() - lp.width - (16 * density).toInt()
            lp.y = (16 * density).toInt()
        } else {
            lp.x = x; lp.y = y
        }
        clamp()
    }

    private fun clamp() {
        val lp = params ?: return
        val b = screen()
        lp.x = lp.x.coerceIn(0, (b.width() - lp.width).coerceAtLeast(0))
        lp.y = lp.y.coerceIn(0, (b.height() - lp.height).coerceAtLeast(0))
    }

    private fun clampAndUpdate() {
        clamp()
        val v = view ?: return
        runCatching { wm?.updateViewLayout(v, params) }
    }

    private fun setScale(s: Float, persist: Boolean = true) {
        val next = s.coerceIn(MIN_SCALE, MAX_SCALE)
        if (abs(next - scale) < 0.005f) return
        scale = next
        val lp = params ?: return
        lp.width = ClockView.windowW(density, scale)
        lp.height = ClockView.windowH(density, scale)
        view?.scale = scale
        clampAndUpdate()
        if (persist) { handler.removeCallbacks(savePrefs); handler.postDelayed(savePrefs, 400) }
    }

    private fun showChrome(forMs: Long) {
        view?.chrome = true
        handler.removeCallbacks(hideChrome)
        if (forMs > 0) handler.postDelayed(hideChrome, forMs)
    }

    // ---------------------------------------------------------------- input

    @SuppressLint("ClickableViewAccessibility")
    private fun wireInput(v: ClockView) {
        val slop = ViewConfiguration.get(v.context).scaledTouchSlop
        var downX = 0f; var downY = 0f
        var startX = 0; var startY = 0
        var startScale = 1f; var startW = 1
        var resizing = false; var moved = false; var pinching = false

        val pinch = ScaleGestureDetector(v.context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
            override fun onScaleBegin(d: ScaleGestureDetector): Boolean { pinching = true; moved = true; return true }
            override fun onScale(d: ScaleGestureDetector): Boolean { setScale(scale * d.scaleFactor); return true }
        })

        v.setOnTouchListener { _, e ->
            pinch.onTouchEvent(e)
            val lp = params ?: return@setOnTouchListener false
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = e.rawX; downY = e.rawY
                    startX = lp.x; startY = lp.y
                    startScale = scale; startW = lp.width
                    resizing = v.hitGrip(e.x, e.y)
                    moved = false; pinching = false
                    showChrome(0)
                }
                MotionEvent.ACTION_MOVE -> if (!pinching) {
                    val dx = e.rawX - downX; val dy = e.rawY - downY
                    if (!moved && (abs(dx) > slop || abs(dy) > slop)) moved = true
                    if (moved) {
                        if (resizing) {
                            setScale(startScale * (startW + dx) / startW, persist = false)
                        } else {
                            lp.x = startX + dx.toInt(); lp.y = startY + dy.toInt()
                            clampAndUpdate()
                        }
                    }
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    if (!moved && e.actionMasked == MotionEvent.ACTION_UP && v.hitGear(e.x, e.y)) {
                        openSettings()
                    }
                    if (moved) { handler.removeCallbacks(savePrefs); handler.post(savePrefs) }
                    // Mouse users get hover; fingers get a few seconds to find the gear/grip.
                    val mouse = e.isFromSource(InputDevice.SOURCE_MOUSE)
                    showChrome(if (mouse) 0 else 3500)
                }
            }
            true
        }

        v.setOnHoverListener { _, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_HOVER_ENTER, MotionEvent.ACTION_HOVER_MOVE -> showChrome(0)
                MotionEvent.ACTION_HOVER_EXIT -> showChrome(900)
            }
            true
        }

        // Mouse wheel over the clock = resize. Very DeX-friendly.
        v.setOnGenericMotionListener { _, e ->
            if (e.actionMasked == MotionEvent.ACTION_SCROLL) {
                val d = e.getAxisValue(MotionEvent.AXIS_VSCROLL)
                if (d != 0f) setScale(scale * if (d > 0) 1.06f else 1 / 1.06f)
                true
            } else false
        }
    }

    private fun openSettings() {
        val i = Intent(this, SettingsActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
        val opts = ActivityOptions.makeBasic().setLaunchDisplayId(displayId).toBundle()
        runCatching { startActivity(i, opts) }.onFailure { runCatching { startActivity(i) } }
    }

    // ---------------------------------------------------------------- settings changes

    override fun onSharedPreferenceChanged(p: SharedPreferences, key: String?) {
        when (key) {
            Prefs.OPACITY -> view?.alpha = p.getInt(key, 100) / 100f
            Prefs.BG -> view?.bgAlpha = p.getInt(key, 62) / 100f
            Prefs.TINT -> view?.tint = p.getInt(key, 50) / 100f
            Prefs.WEATHER, Prefs.CELSIUS, Prefs.LAT, Prefs.LON -> {
                handler.removeCallbacks(weatherTick)
                handler.postDelayed(weatherTick, 300)
            }
            Prefs.SIZE -> setScale(p.getInt(key, 100) / 100f, persist = false)
            Prefs.RESET -> {
                p.edit().remove(Prefs.xKey(external)).remove(Prefs.yKey(external)).apply()
                placeFromPrefs(); clampAndUpdate()
            }
        }
    }

    // ---------------------------------------------------------------- weather

    private fun refreshWeather() {
        handler.removeCallbacks(weatherTick)
        if (!running) return
        val on = prefs.getBoolean(Prefs.WEATHER, true)
        if (!on || !prefs.contains(Prefs.LAT)) { setWeather(null); return }
        val lat = prefs.getFloat(Prefs.LAT, 0f).toDouble()
        val lon = prefs.getFloat(Prefs.LON, 0f).toDouble()
        val celsius = prefs.getBoolean(Prefs.CELSIUS, false)
        io.execute {
            val result = runCatching { WeatherApi.current(lat, lon, celsius) }
            handler.post {
                if (!running) return@post
                result.onSuccess { w ->
                    setWeather(w)
                    prefs.edit().putString(
                        Prefs.W_CACHE, "${w.temp},${w.code},${if (w.day) 1 else 0},${System.currentTimeMillis()}"
                    ).apply()
                }
                // Offline? Keep showing the last reading until it's hours old.
                if (result.isFailure && cachedWeather() == null) setWeather(null)
                handler.postDelayed(weatherTick, if (result.isSuccess) WEATHER_EVERY_MS else WEATHER_RETRY_MS)
            }
        }
    }

    private fun setWeather(w: Weather?) {
        weather = w
        view?.weather = w
    }

    private fun cachedWeather(): Weather? {
        if (!prefs.getBoolean(Prefs.WEATHER, true)) return null
        val parts = prefs.getString(Prefs.W_CACHE, null)?.split(",") ?: return null
        if (parts.size != 4) return null
        val age = System.currentTimeMillis() - (parts[3].toLongOrNull() ?: 0L)
        if (age > WEATHER_STALE_MS) return null
        return Weather(parts[0].toInt(), parts[1].toInt(), parts[2] == "1")
    }

    // ---------------------------------------------------------------- notification

    private fun buildNotification(): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, "Floating clock", NotificationManager.IMPORTANCE_LOW).apply {
                setShowBadge(false)
            }
        )
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, SettingsActivity::class.java), PendingIntent.FLAG_IMMUTABLE
        )
        val stop = PendingIntent.getService(
            this, 1, Intent(this, ClockService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE
        )
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_gear)
            .setContentTitle("Clock is floating")
            .setContentText("Tap for settings")
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(null, "Hide clock", stop).build())
            .setOngoing(true)
            .build()
    }
}

/** Small helper so the settings screen and boot receiver start it the same way. */
fun Context.startClock() {
    Prefs.get(this).edit().putBoolean(Prefs.WANTED, true).apply()
    startForegroundService(Intent(this, ClockService::class.java))
}
