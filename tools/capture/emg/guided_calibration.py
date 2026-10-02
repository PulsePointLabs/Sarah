"""Sample-driven ENV calibration. No browser timing or inferred muscle identity."""
import json
import math
import os
import statistics
import time
from pathlib import Path

VERSION = 'emg-guided-1'


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value), encoding='utf-8')
    # Windows readers can briefly hold the destination without delete sharing.
    # Keep the last complete status and retry later rather than crashing capture.
    for attempt in range(5):
        try:
            os.replace(temporary, path)
            return True
        except PermissionError:
            time.sleep(.002 * (attempt+1))
    return False


class GuidedCalibration:
    def __init__(self, channels):
        self.channels = channels
        self.rest = None
        self.noise = None
        self.reference = [None] * channels
        self.pending = None
        self.last_sample = None
        self.last_values = None
        self.valid = False
        self.saved = False
        self.state = dict(phase='idle', message='Collect rest, then a comfortable hold for each sensor.', remaining_s=0)

    def fail(self, message):
        self.state.update(phase='failed', message=message, remaining_s=0)
        self.pending = None
        self.valid = False

    def start(self, action, now):
        if action == 'guided_cancel':
            self.fail('Calibration cancelled. Repeat the unfinished step.')
            return
        if self.pending:
            raise ValueError('A calibration measurement is already running.')
        if action == 'guided_save':
            if not self.valid or self.last_sample is None or now-self.last_sample > .5:
                raise ValueError('Complete rest, every hold and release with fresh samples before saving.')
            self.saved = True
            self.state = dict(phase='saved', message='Calibration complete and saved.', remaining_s=0)
            return
        if action not in ['guided_rest'] + [f'guided_hold_{i}' for i in range(self.channels)]:
            raise ValueError('Unknown calibration step.')
        if self.last_sample is None or now-self.last_sample > .5:
            raise ValueError('No fresh samples. Connect the Arduino first.')
        index = None if action == 'guided_rest' else int(action[-1])
        if index is not None and self.rest is None:
            raise ValueError('Collect relaxed rest first.')
        if index is None:
            self.rest = self.noise = None
            self.reference = [None] * self.channels
        else:
            self.reference[index] = None
        self.valid = self.saved = False
        self.pending = dict(index=index, start=now+3, samples=[], release=None, stable=None)
        self.state = dict(phase='preparing', channel=index, message='Get ready to relax.' if index is None else 'Build a comfortable, steady squeeze.', remaining_s=3)

    def tick(self, now, values=None, raw=None):
        if self.pending and self.last_sample is not None and now-self.last_sample > .5:
            self.fail('Signal interrupted. Reconnect and repeat this step.')
        if values is not None:
            if len(values) != self.channels or any(not math.isfinite(v) for v in values):
                self.fail('Invalid sensor values. Check the sketch and wiring.')
                return
            self.last_sample = now
            self.last_values = values
        if not self.pending:
            return
        p = self.pending
        if self.last_sample is None or now-self.last_sample > .5:
            self.fail('Signal interrupted. Reconnect and repeat this step.')
            return
        if now < p['start']:
            self.state['remaining_s'] = p['start']-now
            return
        index = p['index']
        selected = list(range(self.channels)) if index is None else [index]
        if values is not None and raw is not None and any(raw[i] <= 0 or raw[i] >= 1023 for i in selected):
            self.fail('Signal is at the ADC limit. Check sensor wiring, gain and contact; repeat this step.')
            return
        if p['release'] is not None:
            self.state.update(phase='settling', message='Release and relax — checking return to rest.', remaining_s=max(0,30-(now-p['release'])))
            if values is not None:
                tolerance = max(10, self.noise[index]*6, p['rise']*.2)
                if abs(values[index]-self.rest[index]) <= tolerance:
                    p['stable'] = now if p['stable'] is None else p['stable']
                    if now-p['stable'] >= 2:
                        self.reference[index] = p['hold']
                        self.valid = all(v is not None for v in self.reference)
                        self.state.update(phase='accepted', message='Hold and release accepted.' if not self.valid else 'All measurements checked. Save calibration.', remaining_s=0)
                        self.pending = None
                else:
                    p['stable'] = None
            if self.pending and now-p['release'] >= 30:
                self.fail('Signal did not return near rest. Relax, check placement and redo rest if it has changed.')
            return
        self.state.update(phase='collecting', message='REST — stay relaxed.' if index is None else 'HOLD — keep it steady.', remaining_s=max(0,5-(now-p['start'])))
        if values is not None:
            p['samples'].append((now, values[:]))
        if now-p['start'] < 5:
            return
        samples = p['samples']
        if len(samples) < 50 or samples[-1][0]-samples[0][0] < 4.8 or any(b[0]-a[0] > .5 for a,b in zip(samples,samples[1:])):
            self.fail('Not enough continuous samples in five seconds. Repeat this step.')
            return
        means = [statistics.mean(s[1][i] for s in samples) for i in range(self.channels)]
        noise = [statistics.pstdev(s[1][i] for s in samples) for i in range(self.channels)]
        if index is None:
            for i in selected:
                v = sorted(s[1][i] for s in samples)
                if noise[i] > max(5, abs(means[i])*.2) or v[int(len(v)*.9)]-v[int(len(v)*.1)] > max(20,abs(means[i])*.5):
                    self.fail('Rest is unstable. Relax, check contact and cable movement, then redo rest.')
                    return
            self.rest, self.noise = means, noise
            self.state.update(phase='accepted', message='Rest accepted. Ready for the first hold.', remaining_s=0)
            self.pending = None
        else:
            v = sorted(s[1][index] for s in samples)
            hold = statistics.median(v)
            rise = hold-self.rest[index]
            drift = abs(statistics.mean(s[1][index] for s in samples[-10:])-statistics.mean(s[1][index] for s in samples[:10]))
            if rise < max(10,self.noise[index]*6):
                self.fail('Hold is too close to rest/noise. Check the selected sensor, then repeat a clear comfortable hold.')
            elif noise[index] > max(8,rise*.3) or drift > max(10,rise*.4) or v[len(v)//4]-self.rest[index] < rise*.3:
                self.fail('Hold varied or was released early. Rest, then repeat the five-second hold.')
            else:
                p.update(release=now, hold=hold, rise=rise)
                self.state.update(phase='settling', message='Release and relax — checking return to rest.', remaining_s=30)

    def snapshot(self):
        return dict(version=VERSION, **self.state, rest=self.rest, noise=self.noise,
                    reference=self.reference, valid=self.valid, saved=self.saved)


class GuidedBridge:
    def __init__(self, channels, directory, channel_map=None):
        self.cal = GuidedCalibration(channels)
        self.directory = Path(directory)
        self.command = None
        self.last_publish = -100
        self.history = []
        self.raw = None
        self.channel_map = channel_map or [f'A{i}' for i in range(channels)]

    def start(self, command):
        self.cal.start(command['action'], time.monotonic())
        self.command = command

    def update(self, values=None, raw=None):
        now = time.monotonic()
        self.cal.tick(now, values, raw)
        if values is not None:
            self.raw = raw
            self.history.append(dict(t=time.time(), values=values))
        raw = self.raw
        if now-self.last_publish < .1:
            return
        self.last_publish = now
        snapshot = self.cal.snapshot()
        fresh = self.cal.last_sample is not None and now-self.cal.last_sample <= .5
        self.history = [r for r in self.history if time.time()-r['t'] <= 10]
        atomic_json(self.directory/'emg_setup_status.json', dict(calibration=snapshot,
            channel_map=self.channel_map,
            signal_valid=fresh and raw is not None and all(0 < v < 1023 for v in raw),
            measured_at=time.time()-(now-self.cal.last_sample) if self.cal.last_sample is not None else None,
            fresh=fresh, values=self.cal.last_values, raw=raw, history=self.history,
            quality='No fresh samples' if not fresh else 'ADC limit / check wiring' if raw and any(v <= 0 or v >= 1023 for v in raw) else 'Receiving ENV samples'))
        if self.command:
            phase = snapshot['phase']
            status = 'rejected' if phase == 'failed' else 'applied' if phase in ('accepted','saved') else phase
            atomic_json(self.directory/'emg_command_status.json', dict(id=self.command['id'], action=self.command['action'], status=status, message=snapshot['message'], calibration=snapshot))

    def record_metadata(self, csv_path, channel_map=None):
        try:
            profile = json.loads((self.directory/'emg_profile.json').read_text(encoding='utf-8'))
        except (OSError, ValueError):
            profile = {}
        atomic_json(Path(csv_path).with_suffix('.metadata.json'), dict(profile=profile,
            channel_map=channel_map, calibration=self.cal.snapshot(), recorded_at=time.time(),
            signal='sensor ENV envelope / ADC units; not raw broadband EMG'))
