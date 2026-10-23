package com.pulsepointlabs.sarah;

import java.util.Calendar;

/** Bluetooth SIG Current Time (2A2B): local wall clock, Monday=1, 1/256 seconds. */
public final class OmronCurrentTime {
    private OmronCurrentTime() {}
    public static byte[] encode(Calendar clock) {
        int year = clock.get(Calendar.YEAR);
        int day = (clock.get(Calendar.DAY_OF_WEEK) + 5) % 7 + 1;
        return new byte[]{(byte)year, (byte)(year >> 8), (byte)(clock.get(Calendar.MONTH) + 1),
            (byte)clock.get(Calendar.DAY_OF_MONTH), (byte)clock.get(Calendar.HOUR_OF_DAY),
            (byte)clock.get(Calendar.MINUTE), (byte)clock.get(Calendar.SECOND), (byte)day,
            (byte)(clock.get(Calendar.MILLISECOND) * 256 / 1000), 1};
    }
    public static boolean matchesPhone(byte[] value, long now) {
        if (value == null || value.length < 10) return false;
        Long parsed = OmronMeasurementTime.parse((value[0] & 255) | ((value[1] & 255) << 8),
            value[2] & 255, value[3] & 255, value[4] & 255, value[5] & 255, value[6] & 255);
        return parsed != null && Math.abs(parsed - now) <= 180000;
    }
}
