import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import process from "node:process";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildSync } from "esbuild";

const module = { exports: {} };
const bundle = buildSync({ entryPoints: [fileURLToPath(new URL("./SessionTelemetryDashboard.jsx", import.meta.url))],
  bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic", mainFields: ["module", "main"],
  alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
  define: { "import.meta.env": "{}" },
  external: ["react", "react-dom", "recharts"] }).outputFiles[0].text;
vm.runInNewContext(bundle, { module, exports: module.exports, require: createRequire(import.meta.url), console, process, setTimeout, clearTimeout, URL, URLSearchParams,
  window: { location: { origin: "http://localhost", hostname: "localhost", search: "" }, addEventListener() {}, removeEventListener() {} } });
const Dashboard = module.exports.default;
const rows = Array.from({ length: 120 }, (_, t) => ({ time_offset_s: t, hr: 80 + t / 4, baseline_hr: 80 }));

test("the Session Snapshot dashboard exposes both independent overlay toggles on its actual HR chart", () => {
  const html = renderToStaticMarkup(React.createElement(Dashboard, {
    session: { event_timeline: [], subjective_near_climax_episodes: [{ id: "n", kind: "near_climax", start_s: 30, end_s: 45 }] },
    timelineRows: rows, inspectionTime: 30,
  }));
  assert.match(html, /Heart Rate &amp; RR-Derived HRV/);
  assert.match(html, /Build \/ plateau \/ recovery/);
  assert.match(html, /My episodes \(1\)/);
  assert.match(html, /AI near climax/);
  assert.match(html, /Physiology phase colors/);
});
