import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import CivetLiveCard from '/src/components/CivetLiveCard.jsx';
const calibration = { id: 'fixture-reference', reference: 2 };
function sample(t, delta = .2, patch = {}) { return { t, pressure_kpa: 2 + delta, delta_kpa: delta, usable: true, calibration_valid: true, calibration, capture_id: 'fixture-capture', duration_s: 0, level_pct: delta / 2 * 100, events: [], session_max_kpa: 2.4, ...patch }; }
function makeLive(kind) {
  const history = Array.from({ length: 601 }, (_, i) => sample(i / 10, i < 300 ? .5 : 1));
  let latest;
  if (kind === 'strong') latest = sample(60, 1.8, { duration_s: 6 });
  else if (kind === 'pulses') {
    for (let n = 0; n < 5; n++) { const peak = 54 + n * .9; history.find(row => row.t >= peak + .5).events = [{ id: `pulse-${n}`, onset: peak - .2, peak, end: peak + .3, confirmed_at: peak + .5, duration_s: .5, quality: 'usable', calibration, segment: 0 }]; }
    latest = sample(59, .2, { rhythm: true });
  } else if (kind === 'uncertain') latest = sample(61, 4, { usable: false, acquisition_message: 'Reference uncertain' });
  else latest = sample(70);
  history.push(latest);
  return { latest: kind === 'missing' ? null : latest, history, age_ms: kind === 'missing' ? 2000 : 0, recordingId: 'fixture-session', monitorSummary: { average: .75, max: 2.4, longest: 9, calibrationId: calibration.id } };
}
function Fixture() {
  const [live, setLive] = useState(() => makeLive('strong'));
  return <main style={{ background: '#090f14', color: 'white', padding: 12 }}><div>{['strong', 'quiet', 'pulses', 'uncertain', 'missing'].map(kind => <button key={kind} onClick={() => setLive(makeLive(kind))}>{kind}</button>)}</div><div id="wide" style={{ width: 940, height: 520, margin: 12 }}><CivetLiveCard live={live} onSetup={() => {}} /></div><div id="compact" style={{ width: 370, height: 420, margin: 12 }}><CivetLiveCard live={live} onSetup={() => {}} /></div></main>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
