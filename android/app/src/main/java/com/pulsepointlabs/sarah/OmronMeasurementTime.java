package com.pulsepointlabs.sarah;

import java.util.Calendar;

/** BLE date components use zero for unknown; never normalize an invalid date. */
public final class OmronMeasurementTime {
    private OmronMeasurementTime() {}
    public static Long parse(int year, int month, int day, int hour, int minute, int second) {
        if (year < 1582 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31
                || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null;
        Calendar calendar = Calendar.getInstance();
        calendar.clear();
        calendar.setLenient(false);
        calendar.set(year, month - 1, day, hour, minute, second);
        try { return calendar.getTimeInMillis(); }
        catch (IllegalArgumentException invalid) { return null; }
    }
}
