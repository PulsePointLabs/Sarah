package com.pulsepointlabs.sarah;

import java.time.Instant;

/** Queue replay must apply the same date bounds as the BLE date parser. */
public final class OmronDeliveryTime {
    private OmronDeliveryTime() {}
    public static boolean isUsable(String value) {
        try {
            Instant time = Instant.parse(value);
            return !time.isBefore(Instant.parse("1582-01-01T00:00:00Z"))
                && time.isBefore(Instant.parse("+10000-01-01T00:00:00Z"));
        } catch (RuntimeException invalid) { return false; }
    }
}
