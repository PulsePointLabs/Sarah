import { useMemo, useState } from 'react';
import { nearestPressureBurst, pressureOverview } from '../lib/videoPressureView.js';
const fmt = (value, digits = 1) => value == null ? '—' : Number(value).toFixed(digits);
const time = value => { const total = Math.max(0, Number(value) || 0); return `${Math.floor(total / 60)}:${String(Math.floor(total % 60)).padStart(2, '0')}`; };

export default function CivetPressureReview({ rows, events, trains, train, playhead, start: requestedStart, end: requestedEnd, onSelect, onSeek, onPlay, markers, Plot }) {
  const [navigator, setNavigator] = useState(false);
  const [windowSeconds, setWindowSeconds] = useState('interval');
  const envelope = useMemo(() => pressureOverview(rows), [rows]);
  const first = rows[0]?.t ?? 0, last = rows.at(-1)?.t ?? first + 1;
  const width = Number(windowSeconds);
  const start = Number.isFinite(width) ? Math.max(first, Math.min(last - width, playhead - width / 2)) : requestedStart;
  const end = Number.isFinite(width) ? Math.min(last, start + width) : requestedEnd;
  const x = value => Math.max(0, Math.min(1000, (value - first) / Math.max(.1, last - first) * 1000));
  const bounds = envelope.reduce((bounds, bin) => [Math.min(bounds[0], bin.min), Math.max(bounds[1], bin.max)], [Infinity, -Infinity]);
  const y = value => 62 - (value - bounds[0]) / Math.max(.1, bounds[1] - bounds[0]) * 52;
  const index = train ? trains.indexOf(train) : nearestPressureBurst(trains, playhead);
  const select = next => { const item = trains[Math.max(0, Math.min(trains.length - 1, next))]; if (item) { onSelect(item.train_index); onSeek(item.first_contraction_s); } };
  const selectedEvents = events.filter(event => event.peak >= start && event.peak <= end && (!train || train.event_ids.includes(event.id)));
  const resolved = selectedEvents.filter(event => event.quality === 'usable').length;
  const uncertain = selectedEvents.length - resolved;
  const values = rows.filter(row => row.t >= start && row.t <= end && !row.gap && Number.isFinite(row.phasic_kpa)).map(row => row.phasic_kpa);
  const peak = values.length ? values.reduce((max, value) => Math.max(max, value), -Infinity) : null;
  return <div className={`pressure-review ${navigator ? 'pressure-review-navigator' : ''}`}>
    <div className="pressure-review-toolbar"><span>Choose an interval · video and pressure stay synchronized</span><button onClick={() => setNavigator(value => !value)}>{navigator ? 'Wide charts' : 'Show burst navigator'}</button></div>
    <section className="pressure-overview" aria-label="Whole session pressure overview"><div><b>Whole session</b><span>Playhead {time(playhead)}</span></div><svg viewBox="0 0 1000 72" preserveAspectRatio="none" role="img" aria-label="Session pressure envelope; click to seek" onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); onSelect(null); onSeek(first + Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * (last - first)); }}>
      {envelope.map((bin, i) => <line key={i} x1={x(bin.t)} x2={x(bin.t)} y1={y(bin.min)} y2={y(bin.max) - 1} stroke="#8cb4bc" strokeWidth="1.3" />)}
      <rect x={x(start)} width={Math.max(2, x(end) - x(start))} y="0" height="72" fill="#2dd4bf" opacity=".16" stroke="#5eead4" />
      <line x1={x(playhead)} x2={x(playhead)} y1="0" y2="72" stroke="#f8fafc" strokeWidth="2" />
    </svg><div><span>{time(first)}</span><span>{time(last)}</span></div></section>
    <div className="pressure-review-workspace"><div className="pressure-review-lanes">
      <div className="pressure-review-navigation"><b>{time(start)}–{time(end)}</b><div><label>Review zoom <select aria-label="Pressure review zoom" value={windowSeconds} onChange={event => setWindowSeconds(event.target.value)}><option value="interval">Full interval</option>{[8,15,30,60].map(seconds=><option key={seconds} value={seconds}>{seconds}s</option>)}</select></label><button disabled={!trains.length || index <= 0} onClick={() => select(index - 1)}>← Previous burst</button><button aria-pressed={!train} onClick={() => onSelect(null)}>Follow video</button><button disabled={!trains.length || index >= trains.length - 1} onClick={() => select(index + 1)}>Next burst →</button></div></div>
      <div className="pressure-lane-title"><b>Pressure · kPa</b><span>Measured · smoothed · slow baseline · local scale</span></div>
      <div className="pressure-review-wave"><Plot rows={rows} events={events} start={start} end={Math.max(end, start + .1)} layers={{ raw: true, filtered: true, tonic: true, events: true }} localScale onSeek={onSeek} markers={markers} playheadS={playhead} /></div>
      <div className="pressure-lane-title"><b>Changes above slow baseline · kPa</b><span>Same interval · separate labeled scale</span></div>
      <div className="pressure-review-change"><Plot rows={rows} events={events} start={start} end={Math.max(end, start + .1)} layers={{ phasic: true, events: true }} onSeek={onSeek} markers={markers} playheadS={playhead} /></div>
      <div className="pressure-peak-row"><b>Detected peaks</b><span>Teal: resolved · amber: needs review</span></div>
      <div className="pressure-peak-strip">{selectedEvents.map((event, i) => <button key={event.id} style={{left:`${Math.max(1,Math.min(99,(event.peak-start)/Math.max(.1,end-start)*100))}%`}} aria-label={`Pressure peak ${i+1} at ${time(event.peak)}`} title={`${time(event.peak)} · ${fmt(event.duration_s, 2)}s · ${(event.flags || []).join(', ') || 'resolved'}`} className={event.quality === 'usable' ? '' : 'needs-review'} onClick={() => onSeek(event.peak)} />)}{!selectedEvents.length && <span>No resolved peaks in this interval.</span>}<div><span>{time(start)}</span><span>{time(end)}</span></div></div>
    </div>{navigator && <aside className="pressure-burst-navigator"><b>Pressure bursts</b>{trains.map(item => <button key={item.train_index} aria-pressed={train === item} onClick={() => { onSelect(item.train_index); onSeek(item.first_contraction_s); }}><b>{time(item.start)}–{time(item.end)}</b><span>{item.count} peaks · {fmt(item.duration_s)}s</span>{item.flags.length > 0 && <small>Needs review</small>}</button>)}{!trains.length && <p>No group of at least three resolved peaks.</p>}</aside>}</div>
    <section className="pressure-review-summary" aria-label="Selected pressure interval"><div><b>{selectedEvents.length} pressure peaks</b><span>{resolved} resolved · {uncertain} need review</span></div><div><b>{fmt(train && !Number.isFinite(width) ? train.duration_s : end - start)}s</b><span>{train && !Number.isFinite(width) ? 'Burst duration' : 'Viewed interval'}</span></div><div><b>{fmt(train?.median_interval_s, 2)}s</b><span>Burst typical spacing</span></div><div><b>{fmt(peak)} kPa</b><span>Peak above slow baseline</span></div><button onClick={() => { onSeek(start); onPlay?.(); }}>{onPlay ? 'Play from here' : 'Go to interval'}</button></section>
    <p className="pressure-review-note">Pressure peaks describe a mechanical pressure pattern. Amber features need review; pressure alone does not identify orgasm.</p>
  </div>;
}
