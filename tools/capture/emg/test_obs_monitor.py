import threading
import time
import unittest
from obs_monitor import ObsMonitor


class MonitorTest(unittest.TestCase):
    def test_slow_connect_and_status_do_not_block_sampling(self):
        entered = threading.Event()
        release = threading.Event()
        def connect():
            entered.set()
            release.wait(2)
            return object()
        monitor = ObsMonitor(connect, lambda c: (True, 'RECORDING'), retry_seconds=.01)
        try:
            self.assertTrue(entered.wait(1))
            start = time.monotonic()
            for _ in range(1000):
                self.assertEqual(monitor.snapshot()[0], False)
            self.assertLess(time.monotonic()-start, .1)
            release.set()
            until = time.monotonic()+1
            while not monitor.snapshot()[0] and time.monotonic()<until:
                time.sleep(.01)
            self.assertEqual(monitor.snapshot(), (True, 'RECORDING'))
        finally:
            release.set()
            monitor.close()

    def test_reconnect_after_lost_connection(self):
        calls = []
        def connect():
            calls.append(1)
            return len(calls)
        monitor = ObsMonitor(connect, lambda c: (False, 'OBS_ERROR: lost') if c==1 else (True, 'RECORDING'), retry_seconds=.01)
        try:
            until = time.monotonic()+1
            while not monitor.snapshot()[0] and time.monotonic()<until:
                time.sleep(.01)
            self.assertEqual(monitor.snapshot(), (True, 'RECORDING'))
            self.assertEqual(len(calls), 2)
        finally:
            monitor.close()
