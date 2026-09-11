import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { transformSync } from "esbuild";

function harness(update, pending) {
  const cells = [], effects = []; let cursor = 0;
  const storage = new Map(pending ? [["sarah.subjectiveEpisodes.s", JSON.stringify(pending)]] : []);
  const react = {
    useState(initial) { const i = cursor++; if (!(i in cells)) cells[i] = initial; return [cells[i], (v) => { cells[i] = typeof v === "function" ? v(cells[i]) : v; }]; },
    useRef(initial) { const i = cursor++; if (!(i in cells)) cells[i] = { current: initial }; return cells[i]; },
    useEffect(fn) { const i = cursor++; if (!(i in cells)) { cells[i] = true; effects.push(fn); } },
  };
  const module = { exports: {} };
  vm.runInNewContext(transformSync(fs.readFileSync(new URL("./useSubjectiveEpisodes.js", import.meta.url), "utf8"), { format: "cjs" }).code, {
    module, exports: module.exports,
    require: (name) => name === "react" ? react : { base44: { entities: { Session: { update }, BodyExploration: { update } } } },
    localStorage: { getItem: (k) => storage.get(k), setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) },
  });
  return { storage, render() { cursor = 0; const value = module.exports.useSubjectiveEpisodes({ id: "s" }, false); effects.splice(0).forEach((fn) => fn()); return value; } };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
test("rapid start/stop saves serialize and the final state is complete, not the earlier draft", async () => {
  const writes = []; let release;
  const h = harness(async (id, data) => { writes.push(data.subjective_near_climax_episodes); if (writes.length === 1) await new Promise((r) => { release = r; }); });
  const state = h.render();
  state.save([{ id: "n", start_s: 1, end_s: null }]);
  state.save([{ id: "n", start_s: 1, end_s: 4 }]);
  await tick(); assert.equal(writes.length, 1);
  release(); await tick(); await tick();
  assert.equal(writes.length, 2); assert.equal(writes[1][0].end_s, 4);
  assert.equal(h.render().saving, false); assert.equal(h.storage.size, 0);
});
test("failed saves retain the draft; reload and retry preserve the original episode ID", async () => {
  const h = harness(async () => { throw new Error("Offline"); });
  h.render().save([{ id: "n", start_s: 2, end_s: null }]); await tick();
  assert.equal(h.render().error, "Offline");
  const pending = JSON.parse(h.storage.get("sarah.subjectiveEpisodes.s"));
  let saved;
  const reload = harness(async (id, data) => { saved = data.subjective_near_climax_episodes; }, pending);
  reload.render(); const state = reload.render(); assert.equal(state.episodes[0].id, "n");
  state.retry(); await tick();
  assert.equal(saved[0].id, "n"); assert.equal(reload.storage.size, 0);
});
