import { useEffect, useState } from 'react';
import { apiUrl } from '@/lib/mobileApiBase';

async function request(path, body) {
  const response = await fetch(apiUrl(`/live-capture/emg/${path}`), body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Desktop returned ${response.status}`);
  return data;
}
export default function EmgSetup({ onClose, onConnected }) {
  const [ports, setPorts] = useState([]), [port, setPort] = useState('');
  const [channels, setChannels] = useState(2), [helper, setHelper] = useState({});
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [pending, setPending] = useState(null);
  const [labels, setLabels] = useState(() => { try { return JSON.parse(localStorage.getItem('pulsepoint.emgNames')) || ['Sensor 1', 'Sensor 2']; } catch { return ['Sensor 1', 'Sensor 2']; } });
  const [step, setStep] = useState(0);
  const refresh = async () => {
    try {
      const data = await request('ports'); setPorts(data.ports || []); setError(data.error || '');
      if (data.port) setPort(data.port); else if (data.ports?.length === 1) setPort(data.ports[0].port);
      if (data.running) setChannels(data.channels);
    } catch (e) { setError(`Cannot reach desktop: ${e.message}`); }
  };
  useEffect(() => { refresh(); }, []);
  useEffect(() => { localStorage.setItem('pulsepoint.emgNames', JSON.stringify(labels)); }, [labels]);
  useEffect(() => {
    let active = true;
    const poll = async () => { try { const data = await request('helper'); if (active) setHelper(data); } catch (e) { if (active) setError(`Desktop unavailable: ${e.message}`); } };
    poll(); const timer = setInterval(poll, 1000); return () => { active = false; clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (!pending) return;
    const status = helper.telemetry?.calibrationCommandStatus;
    if (status?.id === pending.id && status.status !== 'queued') {
      if (status.status === 'applied') setStep(value => value + 1); else setError(status.message || 'Calibration was not applied.');
      setPending(null);
    } else if (Date.now() - pending.at > 12000) { setError('Calibration was not acknowledged. Check that live samples are arriving, then retry.'); setPending(null); }
  }, [helper, pending]);
  const action = async (name) => {
    setBusy(true); setError('');
    try { setHelper(await request(`helper/${name}`, { port, channels })); if (name === 'start') onConnected?.(); if (name === 'install') await refresh(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const steps = [
    { label: 'Relax both muscles', action: 'set_both_rest' },
    { label: `Contract ${labels[0]}`, action: channels === 2 ? 'set_left_max' : 'set_both_max' },
    ...(channels === 2 ? [{ label: `Contract ${labels[1]}`, action: 'set_right_max' }] : []),
    { label: 'Save calibration', action: 'save_calibration' },
  ];
  const calibrate = async () => {
    setBusy(true); setError('');
    try { const result = await request('calibration-command', { action: steps[step].action, save: false }); setPending({ id: result.id, at: Date.now() }); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const telemetry = helper.telemetry;
  const live = Date.now() - new Date(telemetry?.lastSourceAt || 0).getTime() < 6000;
  const values = telemetry?.latestTelemetry || {};
  const button = 'min-h-11 rounded-lg border border-border bg-muted px-3 text-sm font-semibold disabled:opacity-40';
  return <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-3" onKeyDown={e => { if (e.key === 'Escape') onClose(); }}>
    <section role="dialog" aria-modal="true" aria-label="EMG setup" className="max-h-[94dvh] w-full max-w-xl space-y-4 overflow-auto rounded-xl border border-border bg-card p-5 text-foreground">
      <div className="flex items-center justify-between"><h2 className="text-xl font-bold">Connect EMG</h2><button autoFocus className={button} onClick={onClose}>Done</button></div>
      <p className="text-sm text-muted-foreground">Arduino → desktop → Sarah. Keep the Arduino connected to the desktop, even when using your phone.</p>
      <div className="flex flex-wrap gap-2">
        <select aria-label="Sensor count" value={channels} disabled={helper.running} onChange={e => { setChannels(Number(e.target.value)); setStep(0); }} className={button}><option value={1}>One sensor · A0</option><option value={2}>Two sensors · A0 + A1</option></select>
        <select aria-label="Arduino port" value={port} disabled={helper.running} onChange={e => setPort(e.target.value)} className={button}><option value="">Select Arduino port</option>{ports.map(item => <option key={item.port} value={item.port}>{item.port} · {item.label}</option>)}</select>
        <button className={button} onClick={refresh}>Refresh ports</button>
        <button className={button} disabled={busy || (!helper.running && !port)} onClick={() => action(helper.running ? 'stop' : 'start')}>{helper.running ? 'Disconnect' : 'Connect'}</button>
      </div>
      <p role="status" className="text-sm">{live ? 'Receiving live EMG' : helper.message || 'Plug in Arduino and refresh ports.'}</p>
      {(error || helper.error) && <div role="alert" className="rounded-lg border border-amber-500 p-3 text-sm"><p>{error || helper.error}</p><button className={button} onClick={() => navigator.clipboard?.writeText(error || helper.error)}>Copy diagnostics</button></div>}
      <div className="grid gap-3 sm:grid-cols-2">{labels.slice(0, channels).map((label, index) => <label key={index} className="rounded-lg border border-border p-3">
        <span className="text-xs text-muted-foreground">A{index} · Sensor location</span>
        <input aria-label={`Sensor ${index + 1} name`} value={label} maxLength={60} onChange={e => setLabels(old => old.map((item, i) => i === index ? e.target.value : item))} className="my-2 w-full rounded border border-border bg-muted p-2" />
        <meter aria-label={`${label} signal`} min={0} max={150} value={live ? Number(channels === 1 ? values.level_pct : index ? values.right_pct : values.left_pct) || 0 : 0} className="w-full" />
      </label>)}</div>
      <div className="space-y-2 rounded-lg border border-primary/40 p-3">
        <h3 className="font-semibold">Calibration · {step >= steps.length ? 'Saved' : `Step ${step + 1} of ${steps.length}`}</h3>
        <p className="text-sm">{step >= steps.length ? 'Calibration acknowledged and saved by the desktop helper.' : `${steps[step].label}, hold steady, then tap Capture.`}</p>
        <div className="flex flex-wrap gap-2">{step < steps.length && <button className={button} disabled={!live || busy || Boolean(pending)} onClick={calibrate}>{pending ? 'Waiting for helper…' : step === steps.length - 1 ? 'Save' : 'Capture'}</button>}
          <button className={button} disabled={Boolean(pending)} onClick={() => setStep(0)}>Recalibrate</button>
          {step > 0 && <button className={button} disabled={Boolean(pending)} onClick={() => setStep(value => value - 1)}>Redo previous</button>}</div>
      </div>
      <details className="text-sm"><summary className="cursor-pointer">One-time Arduino / helper setup</summary><p className="my-2">Upload the dual A0,A1 sketch once at 115200 baud. One-sensor mode also accepts its A0 column. Close Serial Monitor before connecting. Python must be installed on the desktop.</p><button disabled={busy || helper.running} className={button} onClick={() => action('install')}>{busy ? 'Working…' : 'Install helper dependencies'}</button><p className="mt-2 text-muted-foreground">Downloads Python packages into Sarah’s EMG folder. Sensor readings stay local. CSV recording follows primary OBS.</p></details>
    </section>
  </div>;
}
