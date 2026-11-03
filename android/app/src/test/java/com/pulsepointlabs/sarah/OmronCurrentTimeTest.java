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
    @Test public void fallDstMismatchIsCorrectedWithoutTurningStoredReadingsIntoFreshReadings() {
        TimeZone original=TimeZone.getDefault();
        try {
            TimeZone.setDefault(TimeZone.getTimeZone("America/New_York"));
            Calendar phone=Calendar.getInstance();phone.clear();phone.set(2026,Calendar.NOVEMBER,2,22,37,50);
            Calendar cuff=(Calendar)phone.clone();cuff.add(Calendar.HOUR_OF_DAY,1);
            Long offset=OmronCurrentTime.daylightSavingOffset(OmronCurrentTime.encode(cuff),phone.getTimeInMillis());
            assertEquals(Long.valueOf(3600000),offset);
            long measured=OmronMeasurementTime.parse(2026,11,2,23,37,42);
            assertEquals(phone.getTimeInMillis()-8000,measured-offset);
            assertEquals(phone.getTimeInMillis()-86408000,measured-86400000-offset);
            assertEquals(phone.getTimeInMillis()-8000,OmronCurrentTime.correctMeasurement(measured,offset,phone.getTimeInMillis()));
            long old=OmronMeasurementTime.parse(2026,10,27,2,40,8);
            assertEquals(old,OmronCurrentTime.correctMeasurement(old,offset,phone.getTimeInMillis()));
        } finally {TimeZone.setDefault(original);}
    }
    @Test public void unrelatedClockErrorsAndUnknownDatesAreNotGuessed() {
        Calendar phone=Calendar.getInstance();phone.set(Calendar.MILLISECOND,0);
        assertEquals(Long.valueOf(0),OmronCurrentTime.daylightSavingOffset(OmronCurrentTime.encode(phone),phone.getTimeInMillis()));
        Calendar cuff=(Calendar)phone.clone();cuff.add(Calendar.DAY_OF_MONTH,-1);
        assertNull(OmronCurrentTime.daylightSavingOffset(OmronCurrentTime.encode(cuff),phone.getTimeInMillis()));
        assertNull(OmronCurrentTime.daylightSavingOffset(new byte[10],phone.getTimeInMillis()));
        cuff=(Calendar)phone.clone();cuff.add(Calendar.HOUR_OF_DAY,-1);
        assertEquals(Long.valueOf(-3600000),OmronCurrentTime.daylightSavingOffset(OmronCurrentTime.encode(cuff),phone.getTimeInMillis()));
    }
}
