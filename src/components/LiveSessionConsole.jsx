import { useState } from 'react';

export function sessionRecordingState({ recording, session, camera }) {
  if (camera?.phase === 'recording') return { label: 'RECORDING · phone camera', tone: 'text-red-500', detail: 'Local camera capture is running.' };
  if (recording?.active) return { label: recording.paused ? 'PAUSED · OBS' : 'RECORDING · OBS', tone: recording.paused ? 'text-amber-500' : 'text-red-500', detail: session?.active ? 'Sarah session and telemetry recording are active.' : 'OBS is recording. Sarah session confirmation is pending.' };
  if (session?.importing || camera?.phase === 'saving') return { label: 'SAVING · recording has stopped', tone: 'text-amber-500', detail: 'Wait for finalization before starting another session.' };
  return { label: 'NOT RECORDING', tone: 'text-muted-foreground', detail: session?.active ? 'Sarah has an open record, but OBS is not recording video.' : 'Live heart rate is monitoring only. No session is being recorded.' };
}

export default function LiveSessionConsole({ recording, session, camera, captureKind, onKindChange, title, notes, onTitleChange, onNotesChange, onSave, onStart, onCamera, busy, error, metadataStatus, hrReady, civetEnabled, onCivetChange }) {
  const [saving,setSaving]=useState(false);
  const state=sessionRecordingState({recording,session,camera});
  const active=!!(recording?.active||session?.active||camera?.phase==='recording');
  return <section className="space-y-4 rounded-2xl border border-border bg-card p-4" aria-label="Session recording">
    <div role="status" aria-live="polite"><h2 className={`text-xl font-bold ${state.tone}`}>{state.label}</h2><p className="text-sm">{state.detail}</p>
      {session?.active && <p className="text-sm">{session.captureKind==='body_exploration'?'Body exploration':'Sexual session'} · started {session.startedAt?new Date(session.startedAt).toLocaleTimeString():'now'}</p>}
      {recording?.filename && recording.active && <p className="break-all text-xs text-muted-foreground">{recording.filename}</p>}
    </div>
    <fieldset disabled={active||busy} className="space-y-2"><legend className="font-semibold">Session type</legend><div className="flex flex-wrap gap-2">
      {[['session','Sexual session','Arousal, climax, recovery and session analysis'],['body_exploration','Body exploration','Procedures, instrumentation and physiological observations']].map(([value,label,helper])=><button key={value} type="button" aria-pressed={captureKind===value} onClick={()=>onKindChange(value)} className={`flex-1 rounded-lg border p-3 text-left disabled:opacity-70 ${captureKind===value?'border-primary bg-primary/10':'border-border'}`}><b>{label}</b><span className="block text-xs text-muted-foreground">{helper}</span></button>)}
    </div></fieldset>
    <label className="block text-sm font-medium">Session title<input aria-label="Session title" className="mt-1 w-full rounded-lg border border-border bg-background p-2" value={title} onChange={e=>onTitleChange(e.target.value)} placeholder="Optional title" maxLength={200}/></label>
    <label className="block text-sm font-medium">Session notes<textarea aria-label="Session notes" className="mt-1 w-full rounded-lg border border-border bg-background p-2" value={notes} onChange={e=>onNotesChange(e.target.value)} placeholder="Plans, context, observations…" rows={3}/></label>
    <div className="flex flex-wrap gap-3 text-sm"><span>{hrReady?'H10 / heart rate: receiving':'Heart rate: waiting for fresh readings'}</span><label className="inline-flex items-center gap-2"><input type="checkbox" checked={civetEnabled} onChange={e=>onCivetChange(e.target.checked)}/>Use CIVET pelvic pressure for this session</label></div>
    <div className="flex flex-wrap gap-2">
      {!active && <button type="button" disabled={busy||session?.importing} onClick={onStart} className="rounded-lg bg-primary px-5 py-3 font-bold text-primary-foreground disabled:opacity-50">{busy?'Starting…':'Start session + OBS recording'}</button>}
      <button type="button" onClick={onCamera} className="rounded-lg border border-border px-3 py-2">Use phone / browser camera instead</button>
      {session?.active && <button type="button" disabled={saving} onClick={async()=>{setSaving(true);try{await onSave();}finally{setSaving(false);}}} className="rounded-lg border border-border px-3 py-2">{saving?'Saving…':'Save session details'}</button>}
    </div>
    <p className="text-xs text-muted-foreground">{metadataStatus||'Title and notes are saved with your Sarah record when you start. OBS records video; a connected H10 alone is live monitoring.'}</p>
    {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}
