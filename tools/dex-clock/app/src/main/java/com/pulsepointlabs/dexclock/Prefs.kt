package com.pulsepointlabs.dexclock

import android.content.Context
import android.content.SharedPreferences

/** Every user setting lives here so the service and the settings screen stay in sync. */
object Prefs {
    const val OPACITY = "opacity"      // 20..100, whole clock
    const val BG = "bg"                // 0..100, dark glass only
    const val SIZE = "size"            // 50..300 (% of base size)
    const val BOOT = "boot"            // restart after reboot
    const val WANTED = "wanted"        // user last chose "show" (vs "hide")
    const val RESET = "reset"          // bump to snap back to default spot
    const val TINT = "tint"            // 0..100, how much the card takes the hour colour

    const val WEATHER = "weather"      // show weather on the date line
    const val CELSIUS = "celsius"
    const val LAT = "lat"              // saved location (float); absent = none yet
    const val LON = "lon"
    const val PLACE = "place"          // human-readable name for the settings screen
    const val W_CACHE = "w_cache"      // "temp,code,day,epochMillis" so it shows instantly

    const val BED_ON = "bed_on"        // show the bedtime countdown card
    const val BED_TIME = "bed_time"    // minutes after midnight, e.g. 22*60+30
    const val BED_DEFAULT = 22 * 60 + 30

    fun get(ctx: Context): SharedPreferences =
        ctx.getSharedPreferences("clock", Context.MODE_PRIVATE)

    // Positions are kept separately for the phone screen and the DeX screen,
    // since they're very different sizes.
    // Each card (clock = "", bedtime = "bed") keeps its own spot and size.
    fun xKey(external: Boolean, card: String = "") = card.prefix() + if (external) "x_ext" else "x_phone"
    fun yKey(external: Boolean, card: String = "") = card.prefix() + if (external) "y_ext" else "y_phone"
    fun sizeKey(card: String = "") = card.prefix() + SIZE
    private fun String.prefix() = if (isEmpty()) "" else "${this}_"
}
