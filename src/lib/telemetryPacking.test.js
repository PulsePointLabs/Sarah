import test from 'node:test';
import assert from 'node:assert/strict';
import { packTelemetry, telemetryPositionFree } from './telemetryPacking.js';

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

test('free positions remain pinned and do not pull neighboring cards into the vacated space',()=>{
 const packed=packTelemetry([{id:'a',cols:3,rows:2,x:6,y:0},{id:'b',cols:3,rows:2,x:3,y:0}]);
 assert.equal(packed.placements[0].x,6);assert.equal(packed.placements[1].x,3);
 assert.equal(telemetryPositionFree({...packed.placements[0],x:0},packed.placements,packed.rows),true);
 assert.equal(telemetryPositionFree({...packed.placements[0],x:3},packed.placements,packed.rows),false);
 assert.equal(telemetryPositionFree({...packed.placements[0],x:11},packed.placements,packed.rows),false);
});
