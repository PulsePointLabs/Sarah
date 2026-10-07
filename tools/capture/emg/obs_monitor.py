"""Poll OBS independently so socket timeouts never stall serial acquisition."""
import logging
import threading
import time


class ObsMonitor:
    def __init__(self, connect, read, enabled=True, retry_seconds=5, poll_seconds=.1):
        self._connect = connect
        self._read = read
        self._retry = retry_seconds
        self._poll = poll_seconds
        self._stop = threading.Event()
        self._snapshot = (False, 'CONNECTING' if enabled else 'DISABLED', time.monotonic())
        self._thread = None
        # obsws-python logs a traceback for ordinary connection failures. Our
        # connection wrapper reports a concise status instead.
        logging.getLogger('obsws_python').setLevel(logging.CRITICAL)
        if enabled:
            self._thread = threading.Thread(target=self._run, name='emg-obs-monitor', daemon=True)
            self._thread.start()

    def snapshot(self):
        recording, state, measured = self._snapshot
        if time.monotonic() - measured > 4 and state not in ('DISABLED', 'DISCONNECTED'):
            return False, 'OBS_STATUS_STALE'
        return recording, state

    def close(self):
        self._stop.set()
        # Do not wait for a network timeout on the sampling thread.

    @staticmethod
    def _disconnect(client):
        try:
            disconnect = getattr(client, 'disconnect', None)
            if disconnect:
                disconnect()
        except Exception:
            pass

    def _run(self):
        client = None
        try:
            while not self._stop.is_set():
                if client is None:
                    try:
                        client = self._connect()
                    except Exception:
                        client = None
                    if client is None:
                        self._snapshot = (False, 'DISCONNECTED', time.monotonic())
                        self._stop.wait(self._retry)
                        continue
                try:
                    recording, state = self._read(client)
                except Exception:
                    recording, state = False, 'OBS_ERROR'
                if state.startswith('OBS_ERROR'):
                    self._snapshot = (False, 'DISCONNECTED', time.monotonic())
                    print('OBS connection failed: recorder unavailable; EMG sampling continues.', flush=True)
                    self._disconnect(client)
                    client = None
                    self._stop.wait(self._retry)
                else:
                    self._snapshot = (recording, state, time.monotonic())
                    self._stop.wait(self._poll)
        finally:
            if client is not None:
                self._disconnect(client)
