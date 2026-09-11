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
const Episodes = loadComponent("./SubjectiveNearClimaxEpisodes.jsx");
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
  assert.match(html, /flex h-full min-h-0 flex-col gap-1 overflow-hidden/);
  assert.match(html, /flex min-h-0 flex-1 flex-col p-1.5/);
  assert.match(html, /absolute inset-x-0 top-full/);
  assert.match(html, /Phase bands/);
  assert.match(html, /Physiology phase colors/);
  assert.doesNotMatch(render(Sidebar, props), /Phase evidence at playhead/);
});

test("episode tab exposes both shortcuts, retained thumbnail, totals and candidate durations", () => {
  const html = render(Episodes, { episodes: [{ id: "n", kind: "near_climax", start_s: 20, end_s: 30, duration_s: 10,
    thumbnail_url: "data:image/jpeg;base64,test", source: { label: "Feet" } }], timelineRows, onSeek() {}, onSeekTime() {}, onToggle() {}, onDelete() {}, onRetry() {} });
  assert.match(html, /Near climax \(N\)/);
  assert.match(html, /Climax \(C\)/);
  assert.match(html, /Marked near climax/);
  assert.match(html, /10.0/);
  assert.match(html, /data:image\/jpeg;base64,test/);
  assert.match(html, /near-threshold candidate durations/);
});
