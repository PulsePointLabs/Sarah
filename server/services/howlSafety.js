import { HOWL_CONTROL_DEFAULT_LIMITS } from './howlTelemetry.js';

export const ABSOLUTE_HOWL_INTENSITY_CEILING = HOWL_CONTROL_DEFAULT_LIMITS.absoluteIntensityCeiling;
export const MAXIMUM_HOWL_UPWARD_STEP = HOWL_CONTROL_DEFAULT_LIMITS.maximumUpwardStep;

function boundedNumber(value, min, max, fallback = null) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

export function validateAutomaticHowlIncrease(body = {}, settings = {}) {
  const controller = body.controller || {};
  const previous = boundedNumber(controller.previousIntensity ?? body.previousIntensity, 0, ABSOLUTE_HOWL_INTENSITY_CEILING, null);
  const target = boundedNumber(body.intensity, 0, ABSOLUTE_HOWL_INTENSITY_CEILING, null);
  if (previous == null || target == null || target <= previous) return { ok: true, increasing: false };
  const slope = boundedNumber(controller.recentSlope ?? controller.slopeBpm30s, -100, 100, null);
  const confidence = boundedNumber(controller.controllerConfidence, 0, 100, 0);
  const recovery = boundedNumber(controller.recovery, 0, 100, 100);
  const nearClimax = boundedNumber(controller.nearClimax, 0, 100, 100);
  const reliable = controller.multimodalTrusted !== false && confidence >= 60;
  const rising = slope != null && slope >= 1;
  const protectedState = recovery >= Number(settings.recoveryThreshold ?? 55)
    || nearClimax >= Number(settings.nearClimaxThreshold ?? 72);
  if (!reliable || !rising || protectedState) {
    return { ok: false, increasing: true, error: 'Automatic Howl increase rejected: reliable rising-HR evidence is required and recovery/near-climax protection must be clear.' };
  }
  if (target - previous > MAXIMUM_HOWL_UPWARD_STEP) {
    return { ok: false, increasing: true, error: `Automatic Howl increase rejected: maximum upward change is ${MAXIMUM_HOWL_UPWARD_STEP}.` };
  }
  return { ok: true, increasing: true };
}
