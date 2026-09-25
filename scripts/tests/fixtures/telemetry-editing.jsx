import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import EditableTelemetryPanel from '/src/components/EditableTelemetryPanel.jsx';
import EditableVitalCards from '/src/components/EditableVitalCards.jsx';
import PhaseAnnouncementControls from '/src/components/PhaseAnnouncementControls.jsx';
import { usePhaseAnnouncements } from '/src/hooks/usePhaseAnnouncements.js';
import '/src/index.css';

window.playedAnnouncements = 0;
class FakeAudioContext {
  state = 'running'; currentTime = 0; destination = {};
  createGain() { return { gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
  createBuffer() { return {}; }
  createBufferSource() { return { connect() {}, disconnect() {}, stop() {}, start() { if (this.buffer?.cue) window.playedAnnouncements++; setTimeout(() => this.onended?.(), 100); } }; }
  decodeAudioData() { return Promise.resolve({ duration: 0.1, cue: true }); }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
}
window.AudioContext = FakeAudioContext;
function Metric({ label, children }) { return <div className="h-full rounded-xl border border-slate-600 bg-slate-900 p-4"><h2>{label}</h2><strong className="text-4xl">{children}</strong></div>; }
function Fixture() {
  const [selected, setSelected] = useState('');
  const [panels, setPanels] = useState([{ id: 'Vitals', cols: 12, rows: 5 }, { id: 'Trend', cols: 8, rows: 3 }, { id: 'Phase', cols: 4, rows: 3 }]);
  const announcements = usePhaseAnnouncements({ prediction: { controllerConfidence: 80, buildDurationSec: 60, confirmationCount: 2 }, sample: { active: true, get measuredAt() { return Date.now(); }, hr: 100, baselineHr: 75, buildConfidence: 80 }, voiceSettings: { ttsProvider: 'local' }, sessionId: 'fixture' });
  const reorder = (id, target) => setPanels((old) => { const next = [...old], from = next.findIndex((p) => p.id === id), to = next.findIndex((p) => p.id === target); if (from < 0 || to < 0) return old; next.splice(to, 0, next.splice(from, 1)[0]); return next; });
  return <main className="p-3">
    <PhaseAnnouncementControls controller={announcements} />
    <p>Encouragement stays off.</p>
    <div className="mt-3 grid grid-cols-12 gap-2 pb-44" style={{ gridAutoRows: '70px' }}>
      {panels.map((panel, i) => <EditableTelemetryPanel key={panel.id} id={panel.id} label={panel.id} order={i} layout={panel}
        selected={selected === panel.id} onSelect={setSelected}
        onResize={(size) => setPanels((old) => old.map((p) => p.id === panel.id ? { ...p, ...size } : p))}
        onReset={() => {}} onMove={(dir) => reorder(panel.id, panels[i + dir]?.id)} onReorder={(target) => reorder(panel.id, target)}>
        {panel.id === 'Vitals' ? <EditableVitalCards selected={selected} onSelect={setSelected}>
          <Metric label="Current HR">100</Metric><><Metric label="RMSSD">42</Metric><Metric label="Blood Pressure">120/80</Metric></>
        </EditableVitalCards> : <Metric label={panel.id}>{panel.id === 'Phase' ? 'Elevated' : 'Live trend'}</Metric>}
      </EditableTelemetryPanel>)}
    </div>
  </main>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
