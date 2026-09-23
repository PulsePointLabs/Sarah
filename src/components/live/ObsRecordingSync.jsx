import React, { useEffect, useRef, useState } from 'react';
import { apiUrl } from '@/lib/mobileApiBase';

export default function ObsRecordingSync() {
  const [snapshot, setSnapshot] = useState(null);
  const [form, setForm] = useState({ enabled: false, url: '', password: '', clearPassword: false });
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const initialized = useRef(false);
  useEffect(() => {
    let mounted = true;
    let fetching = false;
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const response = await fetch(apiUrl('/obs-recording'), { cache: 'no-store' });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error || 'OBS recording status unavailable');
        if (!mounted) return;
        setSnapshot(value);
        setConnectionError('');
        if (!initialized.current) {
          setForm((previous) => ({ ...previous, ...value.settings }));
          initialized.current = true;
        }
      } catch (failure) { if (mounted) setConnectionError(failure.message); }
      finally { fetching = false; }
    };
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => { mounted = false; clearInterval(timer); };
  }, []);
  const action = async (suffix = '', method = 'POST') => {
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch(apiUrl(`/obs-recording${suffix}`), {
        method, headers: { 'Content-Type': 'application/json' },
        ...(method === 'PUT' ? { body: JSON.stringify(form) } : {}),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || 'OBS request failed');
      setSnapshot(value);
      if (method === 'PUT') {
        setForm((previous) => ({ ...previous, ...value.settings, password: '', clearPassword: false }));
        setNotice(value.settings.enabled ? 'Saved. Sarah is connecting to secondary OBS.' : 'Secondary recording disabled.');
      } else setNotice(suffix === '/test' ? 'Secondary OBS responded. No recording was started.' : 'Secondary start requested.');
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };
  const locked = busy || snapshot?.primary?.recording || snapshot?.secondary?.recording;
  const label = (side) => !side?.connected ? 'Disconnected' : side.recording ? side.paused ? 'Paused' : 'Recording' : side.identified === false ? 'Connecting' : 'Ready';
  const enabled = snapshot?.settings?.enabled;
  const timing = snapshot?.run?.timing;
  return <section className="rounded-xl border border-border bg-card p-4" aria-label="Dual OBS recording">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-bold uppercase tracking-wide text-primary">OBS cameras</h2>
      <div className="flex flex-wrap gap-2 text-sm">
        <span className={`rounded-lg px-3 py-1 ${snapshot?.primary?.recording ? 'bg-red-500/15 text-red-400' : 'bg-muted'}`}>Primary · {label(snapshot?.primary)}</span>
        {enabled && <span className={`rounded-lg px-3 py-1 ${snapshot?.secondary?.recording ? 'bg-red-500/15 text-red-400' : 'bg-muted'}`}>Secondary · {label(snapshot?.secondary)}</span>}
      </div>
    </div>
    {enabled && <p className="mt-2 text-xs text-muted-foreground">Start from Sarah to send both recording commands together. Starting primary OBS directly also starts the secondary. One session; primary controls stop/pause/resume.</p>}
    {timing && enabled && <p className="mt-2 text-sm">Estimated start difference: <strong>{timing.estimatedStartDifferenceMs > 0 ? '+' : ''}{timing.estimatedStartDifferenceMs} ms</strong>
      <span className="ml-2 text-xs text-muted-foreground">Secondary minus primary · network uncertainty ±{timing.networkUncertaintyMs} ms · frame alignment not measured</span></p>}
    {(error || connectionError || (enabled && snapshot?.secondary?.error)) && <p role="alert" className="mt-2 text-sm text-destructive">{error || connectionError || snapshot.secondary.error}</p>}
    {enabled && snapshot?.run?.warnings?.map((warning) => <p key={warning} className="mt-2 text-sm text-amber-500">{warning}</p>)}
    {enabled && snapshot?.primary?.recording && !snapshot?.secondary?.recording && <button type="button" className="mt-2 rounded-lg border border-border px-3 py-2 text-sm" disabled={busy || !snapshot?.secondary?.connected} onClick={() => action('/start-secondary')}>Start missing secondary recording</button>}
    <details className="mt-2">
      <summary className="cursor-pointer text-sm text-primary">Secondary camera recorder setup</summary>
      <div className="mt-3 space-y-3">
        <p className="text-xs text-muted-foreground">Enable WebSocket Server in secondary OBS → Tools → WebSocket Server Settings. It records its own configured scene, without adding an overlay.</p>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.enabled} disabled={locked} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />Record with secondary OBS</label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">Secondary OBS address<input aria-label="Secondary OBS address" className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2" placeholder="ws://second-computer:4455" value={form.url} disabled={locked} onChange={(event) => setForm({ ...form, url: event.target.value })} /></label>
          <label className="text-sm">WebSocket password<input aria-label="Secondary OBS password" type="password" autoComplete="new-password" className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2" placeholder={snapshot?.settings?.passwordSaved ? 'Saved · leave blank to keep' : 'OBS WebSocket password'} value={form.password} disabled={locked} onChange={(event) => setForm({ ...form, password: event.target.value })} /></label>
        </div>
        {snapshot?.settings?.passwordSaved && <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={form.clearPassword} disabled={locked} onChange={(event) => setForm({ ...form, clearPassword: event.target.checked })} />Clear saved password</label>}
        <div className="flex gap-2"><button type="button" disabled={locked} onClick={() => action('', 'PUT')} className="rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-40">Save connection</button><button type="button" disabled={busy || !enabled} onClick={() => action('/test')} className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-40">Check connection</button></div>
        {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
      </div>
    </details>
    {enabled && (snapshot?.run?.primary?.outputPath || snapshot?.run?.secondary?.outputPath) && <details className="mt-2 text-xs"><summary className="cursor-pointer">Saved recording locations</summary><p className="mt-2 break-all">Primary: {snapshot.run.primary.outputPath || 'Waiting for file location'}</p><p className="break-all">Secondary ({snapshot.settings.url}): {snapshot.run.secondary.outputPath || 'Waiting for file location'}</p></details>}
  </section>;
}
