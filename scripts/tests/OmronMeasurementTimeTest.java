import com.pulsepointlabs.sarah.OmronMeasurementTime;
import java.time.Instant;
import java.util.TimeZone;
public class OmronMeasurementTimeTest {
    static void check(boolean ok) { if (!ok) throw new AssertionError(); }
    public static void main(String[] args) {
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"));
        check(OmronMeasurementTime.parse(0,0,0,0,0,0) == null);
        check(OmronMeasurementTime.parse(2026,0,7,12,0,0) == null);
        check(OmronMeasurementTime.parse(2026,2,30,12,0,0) == null);
        check(OmronMeasurementTime.parse(2026,9,7,24,0,0) == null);
        check(OmronMeasurementTime.parse(65535,9,7,12,0,0) == null);
        check(OmronMeasurementTime.parse(2024,2,29,12,0,0) != null);
        check(Instant.ofEpochMilli(OmronMeasurementTime.parse(2026,9,6,23,42,0)).toString().equals("2026-09-06T23:42:00Z"));
        System.out.println("7 native cuff timestamp checks passed");
    }
}
