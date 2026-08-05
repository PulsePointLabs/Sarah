import assert from "node:assert/strict";
import test from "node:test";
import { formatMilliliters, parseEnemaVolumeEntry, sumEnemaInstilledVolume } from "./enemaVolume.js";

test("parses spoken enema instillation amounts in common units and word order", () => {
  assert.equal(parseEnemaVolumeEntry("60 milliliters instilled").amountMl, 60);
  assert.equal(parseEnemaVolumeEntry("Instilled another sixty cc").amountMl, 60);
  assert.equal(parseEnemaVolumeEntry("I put in one hundred and twenty milliliters").amountMl, 120);
  assert.equal(parseEnemaVolumeEntry("0.5 liters infused").amountMl, 500);
});

test("does not turn unrelated volume mentions into instillation entries", () => {
  assert.equal(parseEnemaVolumeEntry("The bag contains 500 milliliters"), null);
  assert.equal(parseEnemaVolumeEntry("Blood glucose is 90 milligrams per deciliter"), null);
});

test("sums only structured instilled-volume events", () => {
  assert.equal(sumEnemaInstilledVolume([
    { procedure_measurement: { amount_ml: 60 } },
    { instilled_volume_ml: 120 },
    { note: "Unstructured note" },
  ]), 180);
  assert.equal(formatMilliliters(180), "180 mL");
  assert.equal(formatMilliliters(60.5), "60.5 mL");
});
