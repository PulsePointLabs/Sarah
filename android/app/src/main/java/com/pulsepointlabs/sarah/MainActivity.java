package com.pulsepointlabs.sarah;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BloodPressureHealthPlugin.class);
        registerPlugin(OmronBloodPressurePlugin.class);
        registerPlugin(SarahFileSaverPlugin.class);
        registerPlugin(SarahBackgroundJobsPlugin.class);
        registerPlugin(SarahMediaPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
