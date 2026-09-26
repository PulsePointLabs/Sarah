import test from 'node:test';
import assert from 'node:assert/strict';
import { packTelemetry } from './telemetryPacking.js';

test('all combinations of widths and heights pack without overlap or horizontal overflow', () => {
  for (let count = 1; count <= 30; count++) {
    const items = Array.from({ length: count }, (_, i) => ({ id: String(i), cols: 3 + (i * 7) % 10, rows: 1 + (i * 3) % 8 }));
    const { placements, rows } = packTelemetry(items);
    const occupied = new Set();
    for (const p of placements) {
      assert.ok(p.x >= 0 && p.x + p.cols <= 12 && p.y + p.rows <= rows);
      for (let x = p.x; x < p.x + p.cols; x++) for (let y = p.y; y < p.y + p.rows; y++) {
        const key = `${x},${y}`; assert.ok(!occupied.has(key)); occupied.add(key);
      }
    }
  }
});
