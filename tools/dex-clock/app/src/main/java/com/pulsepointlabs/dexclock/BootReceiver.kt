package com.pulsepointlabs.dexclock

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Settings

/** Brings the clock back after a reboot (or an app update) if it was showing before. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val prefs = Prefs.get(ctx)
        val wanted = prefs.getBoolean(Prefs.WANTED, false)
        val onBoot = prefs.getBoolean(Prefs.BOOT, true)
        if (!wanted || !Settings.canDrawOverlays(ctx)) return
        if (intent.action == Intent.ACTION_BOOT_COMPLETED && !onBoot) return
        runCatching { ctx.startClock() }
    }
}
