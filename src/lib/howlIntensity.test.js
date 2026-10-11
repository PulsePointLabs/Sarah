import test from 'node:test';
import assert from 'node:assert/strict';
import { HOWL_MAX_INTENSITY, howlChannelCeiling, howlPowerTarget } from './howlIntensity.js';

test('Howl uses native 0–200 units and independent channel limits', () => {
  assert.equal(HOWL_MAX_INTENSITY, 200);
  assert.equal(howlChannelCeiling({ power_a_limit: 199, power_b_limit: 200 }, 'a'), 199);
  assert.equal(howlChannelCeiling({ power_a_limit: 199, power_b_limit: 200 }, 'b'), 200);
  assert.equal(howlChannelCeiling({}, 'a'), 200);
  assert.equal(howlChannelCeiling({ power_a_limit: 199 }, 'a', 70), 70);
});

test('levels above 15 retain native units and the two-point upward step', () => {
  const options = { power_a: 80, power_b: 120, power_a_limit: 199, power_b_limit: 200 };
  assert.equal(howlPowerTarget({ options, requested: 200 }), 82);
  assert.equal(howlPowerTarget({ options, channel: 'b', requested: 121 }), 121);
  assert.equal(howlPowerTarget({ options, requested: 79 }), 79);
});

test('device limits win over the requested ceiling and floor', () => {
  assert.equal(howlPowerTarget({ options: { power_a: 198, power_a_limit: 199 }, requested: 200 }), 199);
  assert.equal(howlPowerTarget({ options: { power_a: 20, power_a_limit: 0 }, requested: 30, floor: 25 }), 0);
  assert.equal(howlPowerTarget({ options: { power_b: 199, power_b_limit: 200 }, channel: 'b', requested: 200 }), 200);
});
