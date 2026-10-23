package com.pulsepointlabs.sarah;

import org.junit.Test;
import static org.junit.Assert.*;
import java.util.Calendar;
import java.util.TimeZone;

public class OmronCurrentTimeTest {
    @Test public void currentTimeUsesLittleEndianYearAndMondayBasedWeekday() {
        Calendar clock=Calendar.getInstance(TimeZone.getTimeZone("UTC"));
        clock.clear();clock.set(2026,Calendar.OCTOBER,26,18,42,59);clock.set(Calendar.MILLISECOND,500);
        assertArrayEquals(new byte[]{(byte)0xEA,7,10,26,18,42,59,1,(byte)128,1},OmronCurrentTime.encode(clock));
        clock.add(Calendar.DAY_OF_MONTH,6);
        assertEquals(7,OmronCurrentTime.encode(clock)[7]);
    }
    @Test public void unknownClockAndInvalidCalendarDatesAreNeverVerified() {
        assertFalse(OmronCurrentTime.matchesPhone(new byte[10],System.currentTimeMillis()));
        assertFalse(OmronCurrentTime.matchesPhone(new byte[7],System.currentTimeMillis()));
        assertFalse(OmronCurrentTime.matchesPhone(null,System.currentTimeMillis()));
        assertFalse(OmronCurrentTime.matchesPhone(new byte[]{(byte)0xEA,7,2,30,12,0,0,1,0,0},System.currentTimeMillis()));
    }
    @Test public void localClockIsComparedToPhoneWithoutAcceptingStaleTime() {
        Calendar clock=Calendar.getInstance();clock.set(Calendar.MILLISECOND,0);
        byte[] packet=OmronCurrentTime.encode(clock);
        assertTrue(OmronCurrentTime.matchesPhone(packet,clock.getTimeInMillis()+60000));
        assertFalse(OmronCurrentTime.matchesPhone(packet,clock.getTimeInMillis()+240000));
    }
}
