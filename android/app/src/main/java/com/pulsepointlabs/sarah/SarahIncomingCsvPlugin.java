package com.pulsepointlabs.sarah;

import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.lang.ref.WeakReference;
import java.util.Locale;

@CapacitorPlugin(name = "SarahIncomingCsv")
public class SarahIncomingCsvPlugin extends Plugin {
    private static final int MAX_CSV_BYTES = 25 * 1024 * 1024;
    private static final Object PENDING_LOCK = new Object();
    private static JSObject pendingImport;
    private static WeakReference<SarahIncomingCsvPlugin> activePlugin = new WeakReference<>(null);

    @Override
    public void load() {
        activePlugin = new WeakReference<>(this);
    }

    @PluginMethod
    public void consumePending(PluginCall call) {
        JSObject result;
        synchronized (PENDING_LOCK) {
            result = pendingImport;
            pendingImport = null;
        }
        if (result == null) {
            call.resolve(new JSObject().put("pending", false));
            return;
        }
        call.resolve(result);
    }

    public static boolean captureIntent(Context context, Intent intent) {
        if (context == null || intent == null) return false;
        String action = intent.getAction();
        if (!Intent.ACTION_VIEW.equals(action) && !Intent.ACTION_SEND.equals(action)) return false;

        Uri uri = extractUri(intent);
        if (uri == null) return false;

        String filename = displayName(context, uri);
        String mimeType = intent.getType();
        if (mimeType == null || mimeType.trim().isEmpty()) {
            mimeType = context.getContentResolver().getType(uri);
        }
        if (!looksLikeCsv(filename, mimeType)) return false;

        JSObject payload = new JSObject()
            .put("pending", true)
            .put("filename", filename == null || filename.isEmpty() ? "health-export.csv" : filename)
            .put("mimeType", mimeType == null ? "" : mimeType)
            .put("receivedAt", System.currentTimeMillis());

        try {
            byte[] bytes = readBytes(context, uri);
            payload.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP));
            payload.put("size", bytes.length);
        } catch (Exception error) {
            payload.put("error", error.getMessage() == null ? error.toString() : error.getMessage());
        }

        synchronized (PENDING_LOCK) {
            pendingImport = payload;
        }
        SarahIncomingCsvPlugin plugin = activePlugin.get();
        if (plugin != null) {
            plugin.notifyListeners(
                "incomingCsvAvailable",
                new JSObject().put("available", true).put("filename", payload.optString("filename"))
            );
        }
        return true;
    }

    private static Uri extractUri(Intent intent) {
        if (Intent.ACTION_VIEW.equals(intent.getAction())) return intent.getData();

        Uri stream = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        if (stream != null) return stream;
        ClipData clipData = intent.getClipData();
        if (clipData != null && clipData.getItemCount() > 0) {
            return clipData.getItemAt(0).getUri();
        }
        return null;
    }

    private static boolean looksLikeCsv(String filename, String mimeType) {
        String name = filename == null ? "" : filename.toLowerCase(Locale.US);
        String type = mimeType == null ? "" : mimeType.toLowerCase(Locale.US);
        return name.endsWith(".csv")
            || type.contains("csv")
            || type.contains("comma-separated-values")
            || type.contains("vnd.ms-excel")
            || type.equals("text/plain")
            || type.equals("application/octet-stream");
    }

    private static String displayName(Context context, Uri uri) {
        if ("content".equalsIgnoreCase(uri.getScheme())) {
            try (Cursor cursor = context.getContentResolver().query(
                uri,
                new String[]{OpenableColumns.DISPLAY_NAME},
                null,
                null,
                null
            )) {
                if (cursor != null && cursor.moveToFirst()) {
                    int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    if (index >= 0) return cursor.getString(index);
                }
            } catch (Exception ignored) {
                // Fall back to the URI's final path segment.
            }
        }
        return uri.getLastPathSegment();
    }

    private static byte[] readBytes(Context context, Uri uri) throws Exception {
        try (
            InputStream input = context.getContentResolver().openInputStream(uri);
            ByteArrayOutputStream output = new ByteArrayOutputStream()
        ) {
            if (input == null) throw new IllegalArgumentException("Android could not open the shared CSV.");
            byte[] buffer = new byte[16 * 1024];
            int total = 0;
            int count;
            while ((count = input.read(buffer)) >= 0) {
                total += count;
                if (total > MAX_CSV_BYTES) {
                    throw new IllegalArgumentException("The shared CSV is larger than Sarah's 25 MB import limit.");
                }
                output.write(buffer, 0, count);
            }
            return output.toByteArray();
        }
    }
}
