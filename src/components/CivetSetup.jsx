import { useState } from 'react';
import { CivetPlot } from './CivetCard.jsx';
import { civetRequest } from '../hooks/useCivet.js';
import './civet.css';

export default function CivetSetup({ live, onClose }) {
  const [devices, setDevices] = useState([]), [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const sample = live.latest;
  const connected = live.state === 'connected' && !!sample;
  const status = sample?.calibration_status;
  const preparing = status?.phase === 'preparing';
  const collecting = !preparing && (status?.phase === 'collecting' || sample?.calibration_remaining_s > 0);
  const active = !!preparing || collecting;
  const baselineReady = sample?.baseline_ready ?? (!!sample?.calibration && !sample?.quality_flags?.includes('calibration_invalidated'));
  const action = async (name, body = {}) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const data = await civetRequest(name, body);
      if (data.devices) {
        setDevices(data.devices); setAddress(data.devices[0]?.address || '');
        if (!data.devices.length) setError('No CIVET found. Power it on; press its power button five times until its Bluetooth icon is yellow, then scan again.');
      }
      if (name === 'zero') setNotice('Zero command completed. Next: set up in your recording position and collect rest.');
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const begin = kind => action('calibrate', { kind, prepare_s: 3 });
  const kind = status?.kind;
  const remaining = Math.ceil((preparing ? sample?.calibration_preparing_s : sample?.calibration_remaining_s) || 0);
  const ready = sample?.calibration_valid;
  const needsRest = connected && !baselineReady && !active;
  const title = !connected ? 'Waiting for live pressure' : preparing ? (kind === 'baseline' ? 'Get ready to relax' : 'Get ready to hold') : collecting ? (kind === 'baseline' ? 'REST — stay relaxed' : 'HOLD — keep it steady') : needsRest ? 'Collect a relaxed baseline' : ready ? 'Calibration ready' : status?.phase === 'failed' ? 'Redo suggested' : 'Rest accepted — ready to hold';
  const feedback = !connected ? 'Connect the sensor before calibration. Old readings are not used.' : preparing ? (kind === 'baseline' ? 'Relax now. Measurement begins after this countdown.' : 'Build a comfortable squeeze now. Hold through the next five seconds.') : collecting ? status?.message || 'Collecting pressure…' : sample?.calibration_error || (needsRest ? 'Start with five seconds of quiet, steady pressure.' : status?.message) || 'Collect rest, then a comfortable five-second hold.';
  const tone = !connected || preparing ? 'waiting' : collecting ? status?.tone || 'waiting' : needsRest || status?.phase === 'failed' ? 'warning' : 'good';
  const end = sample?.t ?? 0;
  const rows = connected ? (live.history || []).filter(r => r.t >= end - 10 && r.t <= end) : [];
  return <div className="civet-setup-backdrop"><section role="dialog" aria-modal="true" aria-label="Connect CIVET" className="civet-setup">
    <header><h2>CIVET pressure setup</h2><button onClick={onClose}>Close</button></header>
    <div className="civet-connection"><strong>{connected ? 'Connected · live pressure' : live.state}{live.battery != null ? ` · ${live.battery}% battery` : ''}</strong><span>{live.recordingId ? 'Recording to session' : 'Start a Sarah session to record'}</span></div>
    <details open={!connected}><summary>Bluetooth connection</summary><div className="civet-connection-controls">
      <button disabled={busy || active} onClick={() => action('install')}>Install helper (once)</button>
      <button disabled={busy || active} onClick={() => action('scan')}>Scan for CIVET</button>
      <select aria-label="CIVET device" value={address} onChange={e => setAddress(e.target.value)}><option value="">Choose sensor</option>{devices.map(d => <option key={d.address} value={d.address}>{d.name} · {d.address}</option>)}</select>
      <button disabled={busy || active || !address} onClick={() => action('connect', { address })}>Connect</button>
      <button disabled={busy} onClick={() => action('disconnect')}>Disconnect</button>
    </div></details>
    {(error || live.error) && <p role="alert" className="civet-setup-error">{error || live.error}</p>}
    {notice && <p role="status">{notice}</p>}
    <div className="civet-calibration-feedback" data-tone={tone}>
      <div className="civet-calibration-heading"><div><h3>{title}</h3><p aria-live="polite">{feedback}</p></div>
        <div className="civet-calibration-clock" aria-label={active ? `${preparing ? 'Preparation' : 'Measurement'}: ${remaining} seconds remaining` : 'No countdown running'}>{active ? <>{remaining}<small>seconds · {preparing ? 'get ready' : 'measuring'}</small></> : <>{ready ? '✓' : '—'}<small>{ready ? 'ready' : 'not measuring'}</small></>}</div>
      </div>
      <div className="civet-calibration-pressure"><strong>{connected ? sample.pressure_kpa.toFixed(2) : '—'} <small>kPa</small></strong><span>Live pressure · last 10 seconds<br/>Aim for a flat trace during rest and hold</span></div>
      <div className="civet-calibration-plot"><CivetPlot rows={rows} start={end - 10} end={end} layers={{ raw: true }} /></div>
      <p className="civet-calibration-note">Pressure stability is a check for changes, not proof of muscle relaxation. Movement and handling can also change pressure.</p>
    </div>
    <div className="civet-calibration-actions">
      <button disabled={!connected || busy || active} onClick={() => begin('baseline')}><b>{baselineReady ? 'Redo rest' : '1 · Start rest'}</b><span>3 seconds to prepare · 5 seconds relaxed</span></button>
      <button disabled={!connected || !baselineReady || busy || active} onClick={() => begin('reference')}><b>{status?.kind === 'reference' ? 'Redo hold' : '2 · Start hold'}</b><span>{baselineReady ? '3 seconds to prepare · 5 seconds steady' : 'Complete rest first to enable hold'}</span></button>
    </div>
    <div className="civet-zero-row"><button disabled={!connected || busy || active} onClick={() => action('zero', { deflated: true })}>Zero — deflated & outside body</button><p>Optional before insertion. Clicking confirms both conditions. Clears calibration; repeat rest and hold afterward.</p></div>
    <p className="civet-calibration-note">{busy ? 'Working…' : 'You can repeat either step. Repositioned or reconnected? Repeat rest and hold. Reference is comfortable pressure, not maximum strength.'}</p>
  </section></div>;
}
