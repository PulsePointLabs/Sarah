package com.pulsepointlabs.sarah

import android.content.Intent
import android.database.Cursor
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "SharedVitalImport")
class SharedVitalImportPlugin : Plugin() {
    private var pendingIntent: Intent? = null

    override fun load() {
        pendingIntent = activity.intent?.takeIf(::isVitalFileIntent)
    }

    override fun handleOnNewIntent(intent: Intent) {
        super.handleOnNewIntent(intent)
        if (!isVitalFileIntent(intent)) return
        pendingIntent = intent
        notifyListeners("sharedVitalImportReceived", JSObject().put("pending", true), true)
    }

    @PluginMethod
    fun consumePendingImport(call: PluginCall) {
        val intent = pendingIntent ?: activity.intent?.takeIf(::isVitalFileIntent)
        if (intent == null) {
            call.resolve(JSObject().put("pending", false))
            return
        }

        val uri = sharedUri(intent)
        val sharedText = intent.getStringExtra(Intent.EXTRA_TEXT)?.takeIf { it.isNotBlank() }
        if (uri == null && sharedText == null) {
            clearPending(intent)
            call.reject("The shared export did not include a readable file.")
            return
        }

        try {
            val bytes = if (uri != null) context.contentResolver.openInputStream(uri)?.use { input ->
                val output = java.io.ByteArrayOutputStream()
                val buffer = ByteArray(32 * 1024)
                var total = 0
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    total += count
                    if (total > MAX_IMPORT_BYTES) throw IllegalArgumentException("The shared CSV is larger than 16 MB.")
                    output.write(buffer, 0, count)
                }
                output.toByteArray()
            } ?: throw IllegalArgumentException("Android could not open the shared export.") else sharedText!!.toByteArray(Charsets.UTF_8)

            val result = JSObject()
                .put("pending", true)
                .put("name", uri?.let(::displayName) ?: uri?.lastPathSegment ?: "shared-vitals.csv")
                .put("mimeType", intent.type ?: uri?.let { context.contentResolver.getType(it) } ?: "text/plain")
                .put("size", bytes.size)
                .put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
            clearPending(intent)
            call.resolve(result)
        } catch (error: Exception) {
            clearPending(intent)
            call.reject(error.message ?: "Could not read the shared vital-sign export.", error)
        }
    }

    private fun isVitalFileIntent(intent: Intent): Boolean =
        intent.action == Intent.ACTION_SEND || intent.action == Intent.ACTION_VIEW

    @Suppress("DEPRECATION")
    private fun sharedUri(intent: Intent): Uri? = when (intent.action) {
        Intent.ACTION_SEND -> intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM) ?: intent.clipData?.getItemAt(0)?.uri
        Intent.ACTION_VIEW -> intent.data
        else -> null
    }

    private fun displayName(uri: Uri): String? {
        var cursor: Cursor? = null
        return try {
            cursor = context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
            if (cursor != null && cursor.moveToFirst()) cursor.getString(0) else null
        } catch (_: Exception) {
            null
        } finally {
            cursor?.close()
        }
    }

    private fun clearPending(intent: Intent) {
        pendingIntent = null
        if (activity.intent === intent) {
            activity.intent = Intent(intent).apply {
                action = null
                data = null
                removeExtra(Intent.EXTRA_STREAM)
            }
        }
    }

    companion object {
        private const val MAX_IMPORT_BYTES = 16 * 1024 * 1024
    }
}
