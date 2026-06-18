import { db } from '../db.js';
import { TelemetryEngine } from './telemetryEngine.js';

export const telemetryEngine = new TelemetryEngine({ db });

export function startTelemetryEngine() {
  telemetryEngine.start();
  return telemetryEngine;
}
