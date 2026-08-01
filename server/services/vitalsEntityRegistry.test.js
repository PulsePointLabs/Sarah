import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ENTITY_NAMES } from "../db.js";

const REQUIRED_VITAL_ENTITIES = [
  "BloodPressureReading",
  "BloodGlucoseReading",
  "PulseOxReading",
  "BodyCompositionReading",
];

test("client and server expose every persisted vital-sign entity", () => {
  const clientSource = fs.readFileSync(
    new URL("../../src/api/base44Client.js", import.meta.url),
    "utf8",
  );

  for (const entity of REQUIRED_VITAL_ENTITIES) {
    assert.ok(ENTITY_NAMES.includes(entity), `${entity} is missing from the server entity registry`);
    assert.match(
      clientSource,
      new RegExp(`['"]${entity}['"]`),
      `${entity} is missing from the client entity registry`,
    );
  }
});
