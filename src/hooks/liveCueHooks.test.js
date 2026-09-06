import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { resumeLiveCueContext } from '../lib/liveCueAudioReadiness.js';

// Run the actual hook functions with retained hook slots, including dependency
// changes across renders. No browser audio permission or devices are required.
function mountHook(name, props, globals = {}) {
  const slots = [];
  let cursor = 0;
  let effects = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const memo = (fn, deps) => {
    const i = cursor++;
    if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { deps, value: fn() };
    return slots[i].value;
  };
  const context = vm.createContext({
    Map, Date, performance, AbortSignal, setTimeout, clearTimeout,
    useRef: (value) => { const i = cursor++; return slots[i] ||= { current: value }; },
    useState: (value) => {
      const i = cursor++;
      slots[i] ||= { value };
      return [slots[i].value, (v) => { slots[i].value = typeof v === 'function' ? v(slots[i].value) : v; }];
    },
    useMemo: memo,
    useCallback: (fn, deps) => memo(() => fn, deps),
    useEffect: (fn, deps) => memo(() => { effects.push(fn); }, deps),
    resumeLiveCueContext,
    ...globals,
  });
  const source = fs.readFileSync(new URL(`./${name}.js`, import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace('export function', 'function');
  vm.runInContext(`${source}\nglobalThis.hook = ${name};`, context);
  const render = (next = props) => {
    props = next; cursor = 0; effects = [];
    const result = context.hook(props);
    for (const effect of effects) effect();
    return result;
  };
  return { render };
}

function audioHarness(fetch) {
  let resumes = 0;
  class AudioContext {
    state = 'suspended';
    destination = {};
    createGain() { return { gain: {}, connect() {} }; }
    resume() { resumes++; return new Promise(() => {}); }
    decodeAudioData() { return Promise.resolve({ duration: 1 }); }
  }
  const harness = mountHook('useLiveCueAudio', { enabled: true, phrases: { sustained_build: ['Steady.'] }, settings: {} }, {
    window: { AudioContext }, fetch, apiUrl: (url) => url, serverUrl: (url) => url,
    loadTTSSettings: () => ({ ttsProvider: 'local' }), LIVE_CUE_PROFILE_VERSION: 'test',
  });
  return { ...harness, resumes: () => resumes };
}

test('preparation decodes while suspended, without waiting for an audio gesture, and coalesces calls', async () => {
  let prepares = 0;
  const h = audioHarness(async (url) => {
    if (url.endsWith('/prepare')) {
      prepares++;
      return { ok: true, json: async () => ({ clips: [{ text: 'Steady.', url: '/audio/test.mp3' }] }) };
    }
    return { ok: true, headers: { get: () => 'audio/mpeg' }, arrayBuffer: async () => new ArrayBuffer(1) };
  });
  const hook = h.render();
  const first = hook.prepare();
  assert.equal(first, hook.prepare());
  await first;
  assert.equal(h.resumes(), 0);
  assert.equal(prepares, 1);
  assert.equal(h.render().status.phase, 'ready');
  assert.equal(h.render().playCue({ phrase: 'Steady.' }).reason, 'audio_context_not_running');
});

test('failed preparation becomes an actionable error and can be retried', async () => {
  const h = audioHarness(async () => { throw new Error('service offline'); });
  await assert.rejects(h.render().prepare(), /service offline/);
  assert.equal(h.render().status.phase, 'error');
  await assert.rejects(h.render().prepare(), /service offline/);
  assert.equal(h.render().status.phase, 'error');
});

test('cue callbacks stay stable across UI updates and use current audio and session', () => {
  const calls = [];
  const h = mountHook('useLiveCueEngine', {}, {
    createLiveCueStateMachineState: () => ({}),
    resolveLiveCuePhraseBank: () => ({ phrases: {} }),
    stepLiveCueStateMachine: (state) => ({ state, cue: { type: 'sustained_build', phrase: 'Steady.' } }),
  });
  const first = h.render({ cueSettings: {}, audio: { stop() {} } });
  const next = h.render({ cueSettings: {}, sessionId: 'shared-session', audio: { playCue: () => ({ ok: false, reason: 'microphone_active' }) }, onTimelineEvent: (event) => calls.push(event) });
  assert.equal(first.step, next.step);
  assert.equal(first.reset, next.reset);
  next.step({}, {});
  assert.equal(calls[0].metadata.sessionId, 'shared-session');
  assert.equal(calls[0].metadata.spokenAt, null);
});

test('a blocked browser resume times out instead of stranding launch', async () => {
  await assert.rejects(resumeLiveCueContext({ state: 'suspended', resume: () => new Promise(() => {}) }, 5), /Test voice/);
});
