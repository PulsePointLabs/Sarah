import test from 'node:test';
import assert from 'node:assert/strict';
import { civetLiveColor } from './civetLiveColor.js';
test('pressure intensity, sustained holds and rhythm have distinct bounded presentation', () => {
  const sample = { calibration: { reference: 2 }, duration_s: 4 };
  const rest = civetLiveColor({ current: .1, sample });
  const hold = civetLiveColor({ current: 1.8, sample, held: true });
  const rhythm = civetLiveColor({ current: .1, sample, rhythmic: true });
  assert.equal(rest.mode, 'rest'); assert.equal(hold.mode, 'sustained'); assert.equal(rhythm.mode, 'rhythmic');
  assert.notEqual(rest.background, hold.background); assert.notEqual(rest.accent, rhythm.accent);
  assert.equal(civetLiveColor({ current: null }).mode, 'uncertain');
  assert.ok(!civetLiveColor({ current: 100, sample, held: true }).background.includes('NaN'));
});
