import unittest
from guided_calibration import GuidedCalibration
from serial_envelope import latest_line


class Rig:
    def __init__(self, channels=2):
        self.now = 0
        self.cal = GuidedCalibration(channels)
        self.values = [100] * channels
        self.feed(self.values, .1)

    def feed(self, values, seconds):
        for _ in range(round(seconds*50)):
            self.now = round(self.now+.02, 6)
            v = values(self.now) if callable(values) else values
            self.cal.tick(self.now, v, v)

    def rest(self):
        self.cal.start('guided_rest', self.now)
        self.feed(self.values, 8.1)

    def hold(self, channel):
        self.cal.start(f'guided_hold_{channel}', self.now)
        v = self.values[:]
        v[channel] = 300
        self.feed(v, 8.1)
        assert self.cal.state['phase'] == 'settling'
        assert not self.cal.valid
        self.feed(self.values, 2.1)


class CalibrationTests(unittest.TestCase):
    def test_partial_serial_frames_and_nonfinite_values(self):
        class Serial:
            in_waiting = 100
            data = b'100,2'
            def read(self, n):return self.data
        ser=Serial()
        self.assertIsNone(latest_line(ser,True))
        ser.data=b'00\n101,201\nNaN,123\n'
        self.assertEqual(latest_line(ser,True),'101,201')
        ser.data=b'1024,5\n100,300\n'
        self.assertEqual(latest_line(ser,True),'100,300')
    def test_full_dual_sequence_requires_every_release_then_save(self):
        r=Rig(); r.rest()
        self.assertEqual(r.cal.rest,[100,100]); self.assertFalse(r.cal.valid)
        r.hold(0); self.assertFalse(r.cal.valid)
        r.hold(1); self.assertTrue(r.cal.valid);self.assertFalse(r.cal.saved)
        r.cal.start('guided_save',r.now)
        self.assertTrue(r.cal.saved);self.assertEqual(r.cal.reference,[300,300])

    def test_single_channel(self):
        r=Rig(1);r.rest();r.hold(0);r.cal.start('guided_save',r.now)
        self.assertTrue(r.cal.saved)

    def test_no_samples_cannot_calibrate_or_save(self):
        r=Rig()
        with self.assertRaises(ValueError):r.cal.start('guided_save',r.now)
        r.cal.start('guided_rest',r.now);r.cal.tick(r.now+1)
        self.assertEqual(r.cal.state['phase'],'failed')

    def test_gap_between_delivered_samples_fails(self):
        r=Rig();r.cal.start('guided_rest',r.now);r.feed([100,100],4)
        r.cal.tick(r.now+1,[100,100],[100,100])
        self.assertEqual(r.cal.state['phase'],'failed')

    def test_unstable_rest_rejected(self):
        r=Rig();r.cal.start('guided_rest',r.now)
        r.feed(lambda t:[100 if round(t*50)%2 else 300,100],8.1)
        self.assertIsNone(r.cal.rest)
        self.assertEqual(r.cal.state['phase'],'failed')

    def test_early_release_rejected(self):
        r=Rig();r.rest();r.cal.start('guided_hold_0',r.now)
        r.feed([300,100],5);r.feed([100,100],3.1)
        self.assertEqual(r.cal.state['phase'],'failed');self.assertIsNone(r.cal.reference[0])

    def test_clipping_rejected(self):
        r=Rig();r.rest();r.cal.start('guided_hold_0',r.now);r.feed([1023,100],4)
        self.assertEqual(r.cal.state['phase'],'failed')

    def test_no_release_times_out(self):
        r=Rig();r.rest();r.cal.start('guided_hold_0',r.now);r.feed([300,100],39)
        self.assertEqual(r.cal.state['phase'],'failed');self.assertFalse(r.cal.valid)

    def test_redo_rest_invalidates_previous_holds(self):
        r=Rig();r.rest();r.hold(0);r.hold(1);r.cal.start('guided_save',r.now)
        r.rest();self.assertFalse(r.cal.saved);self.assertEqual(r.cal.reference,[None,None])

    def test_preparation_is_excluded_and_weak_hold_fails(self):
        r=Rig();r.cal.start('guided_rest',r.now);r.feed([400,400],2.9);r.feed([100,100],5.2)
        self.assertEqual(r.cal.rest,[100,100]);r.cal.start('guided_hold_0',r.now);r.feed([103,100],8.1)
        self.assertEqual(r.cal.state['phase'],'failed')

if __name__ == '__main__':unittest.main()
