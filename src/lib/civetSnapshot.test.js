import test from 'node:test';
import assert from 'node:assert/strict';
import { contractionSnapshot } from './civetSnapshot.js';
const event = (peak, options = {}) => ({ id: String(peak), onset: peak - .4, peak, end: peak + .4, duration_s: .8,
  confirmed_at: peak + .5, mode: 'live', quality: 'usable', segment: 1, ...options });
test('causal snapshots wait for confirmation; review can show retrospective events', () => {
  assert.equal(contractionSnapshot([event(10)], 10.2).latest, null);
  assert.equal(contractionSnapshot([event(10, {mode:'review'})], 10.2).latest.peak, 10);
  assert.equal(contractionSnapshot([event(10)], 21).latest, null);
});
test('rolling train requires three resolved usable contractions without a gap or segment break', () => {
  const events = [event(6), event(7), event(8), event(9)];
  const snapshot = contractionSnapshot(events, 9.5);
  assert.equal(snapshot.train.length, 4);
  assert.equal(snapshot.spacing, 1);
  assert.equal(snapshot.latest.duration_s, .8);
  assert.equal(contractionSnapshot(events, 13).train.length, 0);
  assert.equal(contractionSnapshot([...events, event(12.1)], 12.6).train.length, 0);
  assert.equal(contractionSnapshot([...events, event(10,{segment:2})], 10.5).train.length, 0);
  assert.equal(contractionSnapshot(events.map(e=>({...e, quality:'review'})), 9.5).train.length, 0);
});
test('duration bars include contractions that overlap the left edge of the window', () => {
  assert.equal(contractionSnapshot([event(10)], 11, 10.2).visible.length, 1);
  assert.equal(contractionSnapshot([event(10)], 11, 10.5).visible.length, 0);
});
