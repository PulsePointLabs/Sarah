import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildSync } from "esbuild";

const require = createRequire(import.meta.url);
function loadComponent(file) {
  const bundle = buildSync({ entryPoints: [fileURLToPath(new URL(file, import.meta.url))],
    bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic",
    mainFields: ["module", "main"], external: ["react", "react-dom", "recharts"] }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(bundle, { module, exports: module.exports, require, console });
  return module.exports.default;
}
const Card = loadComponent("./VideoSyncPhaseCard.jsx");
const Sidebar = loadComponent("./VideoSyncPhysiologySidebar.jsx");
const timelineRows = Array.from({ length: 150 }, (_, t) => ({ time_offset_s: t,
  hr: t < 25 ? 80 : t < 105 ? 105 : Math.max(80, 105 - (t - 105)), baseline_hr: 80 }));
const props = { timelineRows, session: { climax_offset_s: 100 }, playheadS: 80, xDomain: [0, 150], onSeek() {} };
const render = (Component, p) => renderToStaticMarkup(React.createElement(Component, p));

test("playhead renders different evidence on baseline, plateau, and recovery", () => {
  assert.match(render(Card, { ...props, playheadS: 20 }), /Baseline \/ low build/);
  assert.match(render(Card, props), /Elevated plateau/);
  assert.match(render(Card, { ...props, playheadS: 120 }), /Release \/ recovery candidate/);
  assert.match(render(Card, { ...props, playheadS: 300 }), /Insufficient evidence/);
});
test("card exposes accessible seek, color toggle, evidence, and separate logged markers", () => {
  const html = render(Card, props);
  assert.match(html, /aria-label="Seek phase evidence timeline"/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /not a calibrated climax probability/);
  assert.match(html, /Logged climax/);
  assert.match(html, /All key moments observed/);
});
test("full telemetry inserts the card above cardiac trend, normal sidebar retains its layout", () => {
  const html = render(Sidebar, { ...props, phaseSession: props.session, compact: true });
  assert.ok(html.indexOf("Phase evidence at playhead") < html.indexOf("Cardiac Trend"));
  assert.match(html, /overflow-y-auto/);
  assert.doesNotMatch(render(Sidebar, props), /Phase evidence at playhead/);
});

test("sidebar exposes exact prior sample time, windowed metrics, and missing intervals", () => {
  const timed = { ...props, timelineRows: [
    { time_offset_s: 10, hr: 90, hrv_rmssd_ms: 25, hrv_quality: "high" },
    { time_offset_s: 10.5, hr: 140, hrv_rmssd_ms: 5, hrv_quality: "high" },
  ], playheadS: 10.4, videoTiming: { label: "Main", time: 8.4, offset: 2 } };
  const html = render(Sidebar, timed);
  assert.match(html, /sample 0:10.000 · 0.400s earlier/);
  assert.match(html, /rolling RR window, not instantaneous/);
  assert.match(html, /0:08.400/);
  assert.match(render(Sidebar, { ...timed, playheadS: 30 }), /telemetry gap: last sample 19.500s earlier/);
});
