package com.pulsepointlabs.sarah;

import android.app.Activity;
import android.os.Bundle;
import android.widget.TextView;

public class PermissionsRationaleActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        TextView view = new TextView(this);
        int pad = Math.round(24 * getResources().getDisplayMetrics().density);
        view.setPadding(pad, pad, pad, pad);
        view.setTextSize(16);
        view.setText(
            "Sarah uses Health Connect blood pressure permission only to read your local blood pressure readings and attach them to your private PulsePoint session timeline. Data is sent only to your configured local PulsePoint backend."
        );
        setContentView(view);
    }
}
