// Howl's native power units, shared by the UI and command server.
export const HOWL_MAX_INTENSITY = 200;

export function howlChannelCeiling(options = {}, channel = 'a', ceiling = HOWL_MAX_INTENSITY) {
  const value = options[channel === 'b' || channel === 1 ? 'power_b_limit' : 'power_a_limit'];
  const reported = value == null || value === '' ? HOWL_MAX_INTENSITY : Number(value);
  return Math.max(0, Math.min(HOWL_MAX_INTENSITY, Number(ceiling),
    Number.isFinite(reported) ? reported : HOWL_MAX_INTENSITY));
}

export function howlPowerTarget({ options = {}, channel = 'a', requested, floor = 0, ceiling = HOWL_MAX_INTENSITY, maximumUpwardStep = 2 }) {
  const limit = howlChannelCeiling(options, channel, ceiling);
  const current = Number(options[channel === 'b' || channel === 1 ? 'power_b' : 'power_a']) || 0;
  return Math.max(0, Math.min(limit, current + maximumUpwardStep,
    Math.max(Math.min(floor, limit), requested)));
}
