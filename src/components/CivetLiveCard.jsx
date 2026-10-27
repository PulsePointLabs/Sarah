import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { civetLiveSnapshot, updateCivetMonitorZoom } from '../lib/civetLiveMonitor.js';
import { civetTraceBreak } from '../lib/civetTiming.js';
import { civetLiveColor } from '../lib/civetLiveColor.js';
import './civetLive.css';
const preferenceKey = 'sarah.civet.live-card.v1';
const layouts = { balanced: 'Balanced', focus: 'Live + timer', session: 'Recent + session', waveform: 'Waveform first', rhythm: 'Rhythm' };
const fmt = (value, digits = 1) => value == null ? '—' : Number(value).toFixed(digits);
function readPreferences() {
  try { const saved = JSON.parse(localStorage.getItem(preferenceKey)); return { layout: layouts[saved?.layout] ? saved.layout : 'balanced', auto: saved?.auto !== false }; }
  catch { return { layout: 'balanced', auto: true }; }
}
function Reading({ value, unit = 'kPa', label, primary = false }) {
  return <div className={`civet-reading ${primary ? 'civet-reading-primary' : ''}`}><strong>{fmt(value)}<small>{unit}</small></strong><span>{label}</span></div>;
}
function LivePlot({ snapshot, zoom }) {
  const ref = useRef(null), [size, setSize] = useState({ width: 600, height: 160 });
  useLayoutEffect(() => { const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height })); observer.observe(ref.current); return () => observer.disconnect(); }, []);
  const { width, height } = size, left = 28, right = Math.max(left + 10, width - 8), top = 8, bottom = Math.max(top + 15, height - 28);
  const start = snapshot.end - zoom.seconds, x = t => left + (t - start) / zoom.seconds * (right - left);
  const y = value => bottom - (value - zoom.min) / Math.max(1, zoom.max - zoom.min) * (bottom - top);
  let previous = null;
  const trace = snapshot.history.filter(row => row.t >= start).map(row => {
    if (row.delta_kpa == null || !Number.isFinite(row.delta_kpa)) { previous = null; return ''; }
    const move = civetTraceBreak(previous, row); previous = row;
    return `${move ? 'M' : 'L'}${x(row.t)},${y(row.delta_kpa)}`;
  }).join(' ');
  return <svg ref={ref} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Live pressure above recorded rest" data-window-seconds={zoom.seconds}>
    {[0, .5, 1].map(f => { const value = zoom.min + f * (zoom.max - zoom.min); return <g key={f}><line x1={left} x2={right} y1={y(value)} y2={y(value)} stroke="#35545d" /><text x="0" y={y(value) + 4} fill="#b9cdd4" fontSize="12">{fmt(value)}</text></g>; })}
    <path d={trace} stroke="var(--pressure-accent, #55e4ce)" strokeWidth="2.5" fill="none" vectorEffect="non-scaling-stroke" />
    {snapshot.events.filter(e => e.end >= start && e.end <= snapshot.end).map(e => <rect key={e.id} x={x(Math.max(start, e.onset))} y={bottom + 5} width={Math.max(2, x(e.end) - x(Math.max(start, e.onset)))} height="5" rx="2" fill="var(--pressure-accent, #55e4ce)"><title>{`Resolved pulse ${fmt(e.duration_s, 2)}s`}</title></rect>)}
    {[0, .5, 1].map(f => <text key={f} x={left + f * (right - left)} y={height - 2} textAnchor={f === 0 ? 'start' : f === 1 ? 'end' : 'middle'} fill="#b9cdd4" fontSize="12">{f === 1 ? 'NOW' : `−${zoom.seconds * (1 - f)}s`}</text>)}
  </svg>;
}
export default function CivetLiveCard({ live, onSetup, expanded = false, compact = false, preferences, onPreferences }) {
  const box = useRef(null), zoomRef = useRef({});
  const pulseRef = useRef(null), eventRef = useRef(null), animationRef = useRef(null);
  const [saved, setSaved] = useState(readPreferences), [open, setOpen] = useState(false), [details, setDetails] = useState(false), [small, setSmall] = useState(false);
  const prefs = preferences || saved;
  const snapshot = useMemo(() => civetLiveSnapshot(live), [live]);
  const visual = civetLiveColor(snapshot);
  useEffect(() => {
    const context = `${snapshot.anchor?.capture_id}:${snapshot.anchor?.calibration?.id}`;
    const event = snapshot.snapshot.latest;
    const identity = event ? `${event.id}:${event.confirmed_at}` : null;
    const previous = eventRef.current;
    eventRef.current = { context, identity };
    const reduced = box.current?.ownerDocument.defaultView.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || snapshot.current == null || previous?.context !== context) { animationRef.current?.cancel(); return; }
    if (!event || identity === previous.identity || snapshot.end - event.confirmed_at > 1.5) return;
    animationRef.current?.cancel();
    animationRef.current = pulseRef.current.animate([{ opacity: 0 }, { opacity: .24, offset: .22 }, { opacity: 0 }], { duration: 650, easing: 'ease-out' });
  }, [snapshot]);
  useEffect(() => () => animationRef.current?.cancel(), []);
  const zoom = updateCivetMonitorZoom(zoomRef.current, snapshot, prefs.auto);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  useLayoutEffect(() => { const observer = new ResizeObserver(([entry]) => setSmall(entry.contentRect.height < 350 || entry.contentRect.width < 420)); observer.observe(box.current); return () => observer.disconnect(); }, []);
  useEffect(() => { if (!open && !details) return; const close = e => { if (e.key === 'Escape') { setOpen(false); setDetails(false); } }; const doc = box.current.ownerDocument; doc.addEventListener('keydown', close); return () => doc.removeEventListener('keydown', close); }, [open, details]);
  function change(patch) { const next = { ...prefs, ...patch }; if (onPreferences) onPreferences(next); else setSaved(next); try { localStorage.setItem(preferenceKey, JSON.stringify(next)); } catch { /* Optional persistence. */ } }
  const { sample, current, held, rhythmic, duration } = snapshot;
  const timerLabel = held ? 'Current hold' : 'Last completed pulse', sessionLabel = live.recordingId ? 'session' : 'monitor', blank = current == null;
  const state = !sample ? 'Signal lost' : blank ? sample.acquisition_message || 'Reference uncertain' : held ? 'Holding pressure' : rhythmic ? 'Between repeated pulses' : 'Resting range';
  const now = <Reading value={current} label="Live · above rest" primary />;
  const timer = <Reading value={duration} unit="s" label={timerLabel} />;
  const average = <Reading value={blank ? null : snapshot.average} label="Average · last 30s" />;
  const max = <Reading value={snapshot.sessionMax} label={`Max · ${sessionLabel}`} />;
  const portalRoot = () => box.current?.ownerDocument.body || document.body;
  return <section ref={box} data-pressure-mode={visual.mode} style={{ '--pressure-accent': visual.accent, backgroundColor: visual.background }} className={`civet-live-card civet-monitor civet-monitor-${prefs.layout} ${compact ? 'civet-monitor-compact' : ''} ${small ? 'civet-monitor-small' : ''} ${blank ? 'civet-live-unready' : ''}`} aria-label="CIVET live pressure">
    <span ref={pulseRef} className="civet-pressure-pulse" aria-hidden="true" />
    <header><b>Pelvic pressure</b><div className="civet-monitor-controls"><select aria-label="Pressure card view" value={prefs.layout} onChange={e => change({ layout: e.target.value })}>{Object.entries(layouts).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><button aria-pressed={prefs.auto} onClick={() => change({ auto: !prefs.auto })}>Auto zoom: {prefs.auto ? 'on' : 'off'}</button></div></header>
    <div className="civet-monitor-state"><span>{state}</span>{sample?.usable && <small title="Relative to the comfortable reference hold, not maximum strength or orgasm progress">{fmt(sample.level_pct, 0)}% of reference</small>}</div>
    <div className="civet-monitor-readings">{now}{prefs.layout === 'session' ? <><div className="civet-monitor-summary"><b>Recent · 30s</b>{average}<Reading value={blank ? null : snapshot.recentMax} label="Max · last 30s" />{timer}</div><div className="civet-monitor-summary"><b>{live.recordingId ? 'Session' : 'Monitor'}</b><Reading value={snapshot.sessionAverage} label="Average" />{max}<Reading value={snapshot.longest} unit="s" label="Longest hold" /></div></> : prefs.layout === 'rhythm' ? <><Reading value={blank ? null : snapshot.snapshot.train.length || 0} unit="peaks" label="Repeated · last 10s" /><Reading value={blank ? null : snapshot.snapshot.spacing} unit="s" label="Typical spacing" /></> : prefs.layout === 'focus' ? <>{timer}<div className="civet-monitor-summary">{average}{max}</div></> : <>{average}{max}{timer}</>}</div>
    <div className="civet-monitor-plot-heading"><span>kPa above rest</span><span>{blank ? 'Reference / signal unavailable' : prefs.auto ? `Auto · ${zoom.seconds}s` : `Wide · ${zoom.seconds}s`} · scale {fmt(zoom.min, 0)}–{fmt(zoom.max, 0)}</span></div>
    <div className="civet-live-plot"><LivePlot snapshot={snapshot} zoom={zoom} /></div>
    <div className="civet-monitor-progression">{blank ? 'Current readings withheld' : snapshot.trend != null ? `Recent average ${snapshot.trend > .1 ? '↑' : snapshot.trend < -.1 ? '↓' : 'steady'} · ${fmt(snapshot.priorAverage)} → ${fmt(snapshot.average)} kPa` : rhythmic ? `${snapshot.snapshot.train.length} repeated peaks · ${fmt(snapshot.snapshot.spacing, 2)}s typical spacing` : held ? `Holding for ${fmt(duration)}s` : snapshot.snapshot.latest ? `Last resolved pulse · ${fmt(duration, 2)}s` : 'Collecting pressure response'}{sample?.uncertain_pulses_60s > 0 && <small> · {sample.uncertain_pulses_60s} uncertain features / 60s</small>}</div>
    <footer><button onClick={() => setDetails(true)}>Details</button><button onClick={expanded ? onSetup : () => setOpen(true)}>{expanded ? 'Calibrate' : 'Expand'}</button></footer>
    {open && createPortal(<div className="civet-live-expanded"><button className="civet-live-close" onClick={() => setOpen(false)}>Close monitor</button><CivetLiveCard live={live} onSetup={onSetup} expanded preferences={prefs} onPreferences={next => change(next)} /></div>, portalRoot())}
    {details && createPortal(<div className="civet-monitor-backdrop"><section role="dialog" aria-modal="true" aria-label="Pressure signal details" className="civet-monitor-details"><h2>Pressure signal & reference</h2><p>Mechanical pressure above recorded rest, not calibrated muscle force. 100% matches your comfortable reference hold; values above 100% can occur.</p><p>Average: valid samples in the last 30 seconds, independent of graph zoom. Trend compares complete adjacent 30-second windows. Session / monitor statistics start with the current capture and restart when the session or calibration changes; they exclude invalid samples.</p><p>Current hold runs while the recorded pressure detector is active. Last completed pulse is a resolved usable event, not an ongoing contraction. Uncertain features are retained separately.</p><p>Auto zoom uses usable strong pressure or confirmed repeated activity, holds an 8-second view for eight seconds after activity settles, then returns to 20 seconds. Zoom does not change the pressure scale. Original samples and gaps are preserved.</p><p>{sample?.acquisition_message || live.error || 'Signal available'} · {sample?.quality_flags?.join(', ') || 'No current quality flags'}</p><button onClick={onSetup}>Calibrate</button><button autoFocus onClick={() => setDetails(false)}>Close</button></section></div>, portalRoot())}
  </section>;
}
