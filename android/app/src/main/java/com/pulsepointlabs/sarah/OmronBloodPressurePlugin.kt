package com.pulsepointlabs.sarah

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "OmronBloodPressure")
class OmronBloodPressurePlugin : Plugin() {
    private val events: (String, JSObject) -> Unit = { name, value -> notifyListeners(name, value) }
    override fun load() {
        OmronCollector.init(context.applicationContext)
        OmronCollector.emit = events
    }
    override fun handleOnResume() {
        super.handleOnResume()
        // A process restart or in-place update can leave the saved listener armed
        // in preferences but no acquisition service running. Resume the user's
        // existing choice when the app is visible, without waiting for a page.
        OmronCollector.restore(context.applicationContext)
        if (OmronCollector.armed) {
            runCatching { SarahCaptureService.start(context.applicationContext) }
                .onFailure { notifyListeners("error", JSObject().put("message", "Could not keep cuff capture active in the background. Reopen Live Capture to retry.")) }
        }
    }
    @PluginMethod fun arm(call: PluginCall) {
        activity.runOnUiThread {
            try { call.resolve(OmronCollector.arm(call.getString("deviceId"), call.getString("name"), call.getString("endpoint").orEmpty())) }
            catch (error: Exception) { call.reject(error.message, error) }
        }
    }
    @PluginMethod fun disarm(call: PluginCall) { activity.runOnUiThread { call.resolve(OmronCollector.disarm()) } }
    @PluginMethod fun getState(call: PluginCall) { call.resolve(OmronCollector.state()) }
    @PluginMethod fun updateDeliveryEndpoint(call: PluginCall) {
        try {
            OmronCollector.updateDeliveryEndpoint(call.getString("endpoint").orEmpty())
            call.resolve(JSObject().put("ok", true))
        } catch (error: Exception) { call.reject(error.message, error) }
    }
    @PluginMethod fun acknowledgeReading(call: PluginCall) {
        OmronCollector.acknowledge(call.getString("externalId").orEmpty())
        call.resolve(JSObject().put("ok", true))
    }
    override fun handleOnDestroy() {
        if (OmronCollector.emit === events) OmronCollector.emit = null
        super.handleOnDestroy()
    }
}
