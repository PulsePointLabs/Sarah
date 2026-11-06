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
import java.time.LocalTime
import java.util.concurrent.Executors
import kotlin.math.abs

/**
 * Keeps the floating cards (the clock, plus the optional bedtime countdown) on top of
 * everything.
 *
 * DeX runs on the external monitor as its own Android "display". A plain overlay would
 * land on the phone screen, so we look for a non-phone display and put the cards there,
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

    /** One floating card: its window, size and saved-position keys. */
    private inner class Card(val id: String) {
        var view: ClockView? = null
        var params: WindowManager.LayoutParams? = null
        var scale = 1f
        val save = Runnable {
            val p = params ?: return@Runnable
            prefs.edit()
                .putInt(Prefs.xKey(external, id), p.x)
                .putInt(Prefs.yKey(external, id), p.y)
                .putInt(Prefs.sizeKey(id), (scale * 100).toInt())
                .apply()
        }
        val hideChrome = Runnable { view?.chrome = false }
        val isBed get() = id == "bed"
    }

    private val handler = Handler(Looper.getMainLooper())
    private lateinit var prefs: SharedPreferences
    private lateinit var displays: DisplayManager

    private val clock = Card("")
    private val bed = Card("bed")
    private val cards = listOf(clock, bed)

    private var wm: WindowManager? = null
    private var windowCtx: Context? = null
    private var displayId = Display.DEFAULT_DISPLAY
    private val external get() = displayId != Display.DEFAULT_DISPLAY
    private var density = 1f
    private var weather: Weather? = null
    private val io = Executors.newSingleThreadExecutor()
    private val weatherTick = Runnable { refreshWeather() }

    private val tick = object : Runnable {
        override fun run() {
            cards.forEach { it.view?.invalidate() }
            handler.postDelayed(this, 1000 - System.currentTimeMillis() % 1000 + 5)
        }
    }
    private val recheckDisplay = Runnable {
        val target = pickDisplay()
        if (target.displayId != displayId || clock.view == null) {
            detachAll()
            attachAll(target)
        } else {
            cards.forEach { clampAndUpdate(it) }
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

        cards.forEach { it.scale = prefs.getInt(Prefs.sizeKey(it.id), 100) / 100f }
        weather = cachedWeather()
        attachAll(pickDisplay())
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
        detachAll()
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

    // ---------------------------------------------------------------- windows

    private fun wanted(c: Card) = !c.isBed || prefs.getBoolean(Prefs.BED_ON, false)

    private fun attachAll(display: Display) {
        try {
            useDisplay(display)
            cards.filter(::wanted).forEach(::addWindow)
        } catch (e: Exception) {
            // Couldn't use that screen for some reason; fall back to the phone.
            detachAll()
            if (display.displayId != Display.DEFAULT_DISPLAY) {
                runCatching {
                    useDisplay(displays.getDisplay(Display.DEFAULT_DISPLAY))
                    cards.filter(::wanted).forEach(::addWindow)
                }
            }
        }
    }

    private fun useDisplay(display: Display) {
        val ctx = createDisplayContext(display)
            .createWindowContext(WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY, null)
        windowCtx = ctx
        wm = ctx.getSystemService(WindowManager::class.java)
        displayId = display.displayId
        density = ctx.resources.displayMetrics.density
    }

    private fun addWindow(c: Card) {
        val ctx = windowCtx ?: return
        if (c.view != null) return
        val v = ClockView(ctx).apply {
            scale = c.scale
            alpha = prefs.getInt(Prefs.OPACITY, 100) / 100f
            bgAlpha = prefs.getInt(Prefs.BG, 62) / 100f
            tint = prefs.getInt(Prefs.TINT, 50) / 100f
            if (c.isBed) bedtime = bedtimePref() else weather = this@ClockService.weather
        }
        val lp = WindowManager.LayoutParams(
            ClockView.windowW(density, c.scale),
            ClockView.windowH(density, c.scale),
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            title = if (c.isBed) "Bedtime Countdown" else "Floating Clock"
        }
        c.view = v; c.params = lp
        placeFromPrefs(c)
        wireInput(c)
        wm!!.addView(v, lp)
    }

    private fun detach(c: Card) {
        val v = c.view ?: return
        runCatching { wm?.removeViewImmediate(v) }
        c.view = null; c.params = null
    }

    private fun detachAll() {
        cards.forEach(::detach)
        wm = null; windowCtx = null
    }

    private fun bedtimePref(): LocalTime =
        LocalTime.ofSecondOfDay(prefs.getInt(Prefs.BED_TIME, Prefs.BED_DEFAULT) * 60L)

    private fun screen() = wm!!.currentWindowMetrics.bounds

    private fun placeFromPrefs(c: Card) {
        val lp = c.params ?: return
        val x = prefs.getInt(Prefs.xKey(external, c.id), -1)
        val y = prefs.getInt(Prefs.yKey(external, c.id), -1)
        if (x < 0 || y < 0) {
            // Top-right corner; the bedtime card tucks in just under the clock.
            val pad = (16 * density).toInt()
            lp.x = screen().width() - lp.width - pad
            lp.y = if (c.isBed) pad + ClockView.windowH(density, clock.scale) else pad
        } else {
            lp.x = x; lp.y = y
        }
        clamp(c)
    }

    private fun clamp(c: Card) {
        val lp = c.params ?: return
        val b = screen()
        lp.x = lp.x.coerceIn(0, (b.width() - lp.width).coerceAtLeast(0))
        lp.y = lp.y.coerceIn(0, (b.height() - lp.height).coerceAtLeast(0))
    }

    private fun clampAndUpdate(c: Card) {
        val v = c.view ?: return
        clamp(c)
        runCatching { wm?.updateViewLayout(v, c.params) }
    }

    private fun setScale(c: Card, s: Float, persist: Boolean = true) {
        val next = s.coerceIn(MIN_SCALE, MAX_SCALE)
        if (abs(next - c.scale) < 0.005f) return
        c.scale = next
        val lp = c.params ?: return
        lp.width = ClockView.windowW(density, c.scale)
        lp.height = ClockView.windowH(density, c.scale)
        c.view?.scale = c.scale
        clampAndUpdate(c)
        if (persist) { handler.removeCallbacks(c.save); handler.postDelayed(c.save, 400) }
    }

    private fun showChrome(c: Card, forMs: Long) {
        c.view?.chrome = true
        handler.removeCallbacks(c.hideChrome)
        if (forMs > 0) handler.postDelayed(c.hideChrome, forMs)
    }

    // ---------------------------------------------------------------- input

    @SuppressLint("ClickableViewAccessibility")
    private fun wireInput(c: Card) {
        val v = c.view ?: return
        val slop = ViewConfiguration.get(v.context).scaledTouchSlop
        var downX = 0f; var downY = 0f
        var startX = 0; var startY = 0
        var startScale = 1f; var startW = 1
        var resizing = false; var moved = false; var pinching = false

        val pinch = ScaleGestureDetector(v.context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
            override fun onScaleBegin(d: ScaleGestureDetector): Boolean { pinching = true; moved = true; return true }
            override fun onScale(d: ScaleGestureDetector): Boolean { setScale(c, c.scale * d.scaleFactor); return true }
        })

        v.setOnTouchListener { _, e ->
            pinch.onTouchEvent(e)
            val lp = c.params ?: return@setOnTouchListener false
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = e.rawX; downY = e.rawY
                    startX = lp.x; startY = lp.y
                    startScale = c.scale; startW = lp.width
                    resizing = v.hitGrip(e.x, e.y)
                    moved = false; pinching = false
                    showChrome(c, 0)
                }
                MotionEvent.ACTION_MOVE -> if (!pinching) {
                    val dx = e.rawX - downX; val dy = e.rawY - downY
                    if (!moved && (abs(dx) > slop || abs(dy) > slop)) moved = true
                    if (moved) {
                        if (resizing) {
                            setScale(c, startScale * (startW + dx) / startW, persist = false)
                        } else {
                            lp.x = startX + dx.toInt(); lp.y = startY + dy.toInt()
                            clampAndUpdate(c)
                        }
                    }
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    if (!moved && e.actionMasked == MotionEvent.ACTION_UP && v.hitGear(e.x, e.y)) {
                        openSettings()
                    }
                    if (moved) { handler.removeCallbacks(c.save); handler.post(c.save) }
                    // Mouse users get hover; fingers get a few seconds to find the gear/grip.
                    val mouse = e.isFromSource(InputDevice.SOURCE_MOUSE)
                    showChrome(c, if (mouse) 0 else 3500)
                }
            }
            true
        }

        v.setOnHoverListener { _, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_HOVER_ENTER, MotionEvent.ACTION_HOVER_MOVE -> showChrome(c, 0)
                MotionEvent.ACTION_HOVER_EXIT -> showChrome(c, 900)
            }
            true
        }

        // Mouse wheel over a card = resize it. Very DeX-friendly.
        v.setOnGenericMotionListener { _, e ->
            if (e.actionMasked == MotionEvent.ACTION_SCROLL) {
                val d = e.getAxisValue(MotionEvent.AXIS_VSCROLL)
                if (d != 0f) setScale(c, c.scale * if (d > 0) 1.06f else 1 / 1.06f)
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
            Prefs.OPACITY -> cards.forEach { it.view?.alpha = p.getInt(key, 100) / 100f }
            Prefs.BG -> cards.forEach { it.view?.bgAlpha = p.getInt(key, 62) / 100f }
            Prefs.TINT -> cards.forEach { it.view?.tint = p.getInt(key, 50) / 100f }
            Prefs.WEATHER, Prefs.CELSIUS, Prefs.LAT, Prefs.LON -> {
                handler.removeCallbacks(weatherTick)
                handler.postDelayed(weatherTick, 300)
            }
            Prefs.SIZE -> setScale(clock, p.getInt(key, 100) / 100f, persist = false)
            Prefs.BED_ON -> when {
                !p.getBoolean(key, false) -> detach(bed)
                wm != null -> runCatching { addWindow(bed) }
            }
            Prefs.BED_TIME -> bed.view?.bedtime = bedtimePref()
            Prefs.RESET -> {
                val e = p.edit()
                cards.forEach { e.remove(Prefs.xKey(external, it.id)).remove(Prefs.yKey(external, it.id)) }
                e.apply()
                cards.forEach { placeFromPrefs(it); clampAndUpdate(it) }
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
        clock.view?.weather = w
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
