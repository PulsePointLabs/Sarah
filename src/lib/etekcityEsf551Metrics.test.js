import test from "node:test";
import assert from "node:assert/strict";
import { calculateEsf551BodyComposition, parseEsf551Measurement } from "./etekcityEsf551Metrics.js";

test("parses stable ESF-551 weight and impedance packet", () => {
  const bytes = new Uint8Array(22);
  bytes.set([0xa5, 0x02], 0);
  bytes.set([0x10, 0x00], 3);
  bytes.set([0x01, 0x61, 0xa1, 0x00], 6);
  const weightGrams = 82691;
  bytes[10] = weightGrams & 0xff;
  bytes[11] = (weightGrams >> 8) & 0xff;
  bytes[12] = (weightGrams >> 16) & 0xff;
  bytes[13] = 0xf4;
  bytes[14] = 0x01;
  bytes[19] = 1;
  bytes[20] = 1;
  bytes[21] = 1;

  assert.deepEqual(parseEsf551Measurement(new DataView(bytes.buffer)), {
    weight_kg: 82.69,
    impedance_ohms: 500,
    display_unit: 1,
  });
});

test("calculates complete composition from measured weight and impedance", () => {
  const result = calculateEsf551BodyComposition({
    weightKg: 82.69,
    impedanceOhms: 500,
    heightCm: 175,
    age: 44,
    biologicalSex: "male",
  });

  assert.equal(result.weight_kg, 82.69);
  assert.equal(result.impedance_ohms, 500);
  assert.ok(result.body_fat_percent > 5);
  assert.ok(result.muscle_mass_kg > 0);
  assert.ok(result.body_water_percent > 0);
  assert.ok(result.bone_mass_kg > 0);
  assert.ok(result.basal_metabolic_rate_kcal_day >= 900);
});
