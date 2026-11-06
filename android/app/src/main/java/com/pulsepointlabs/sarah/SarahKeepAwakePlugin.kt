package com.pulsepointlabs.sarah

import android.view.WindowManager
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "SarahKeepAwake")
class SarahKeepAwakePlugin : Plugin() {
    @PluginMethod
    fun set(call: PluginCall) {
        val enabled = call.getBoolean("enabled") ?: false
        activity.runOnUiThread {
            try {
                if (enabled) {
                    activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    SarahCaptureService.start(context)
                } else {
                    activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    SarahCaptureService.stop(context)
                }
                call.resolve(JSObject().put("enabled", enabled).put("native", true))
            } catch (error: RuntimeException) {
                call.reject("Android could not change the background capture service state.", error)
            }
        }
    }
}
