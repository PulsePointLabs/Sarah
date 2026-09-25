export default function PhaseAnnouncementControls({ controller, compact = false }) {
  const { settings, setSettings, audio, toggle, test, message } = controller;
  return <section className="rounded-xl border border-border bg-card p-3" aria-label="Phase announcements">
    <div className="flex flex-wrap items-center gap-3">
      <strong className="text-sm">Phase announcements</strong>
      <button type="button" aria-pressed={settings.enabled} onClick={toggle} className="min-h-11 rounded-lg border px-3 text-sm">{settings.enabled ? 'On' : 'Off'}</button>
      <label className="flex items-center gap-2 text-sm">Volume <input aria-label="Phase announcement volume" type="range" min="0" max="1" step="0.05" value={settings.volume} onChange={(e) => setSettings((s) => ({ ...s, volume: Number(e.target.value) }))} className="w-24 accent-primary" />{Math.round(settings.volume * 100)}%</label>
      <button type="button" aria-label="Test phase announcement" onClick={test} disabled={!settings.enabled || audio.status.phase === 'preparing'} className="min-h-11 rounded-lg border px-3 text-sm disabled:opacity-50">{audio.status.phase === 'preparing' ? 'Preparing…' : compact ? 'Test' : 'Test announcement'}</button>
    </div>
    {!compact && <p className="mt-2 text-xs text-muted-foreground">Separate from encouragement. Requires confidence ≥70 and 12 seconds of fresh, consistent telemetry; at least 30 seconds between announcements. Climax remains a possibility, not confirmation. Uses your selected TTS provider; only these fixed phrases are sent for speech.</p>}
    {(!compact || settings.enabled) && <p role="status" className="mt-1 text-xs text-muted-foreground">{!settings.enabled ? 'Phase announcements are off on this device.' : audio.status.phase === 'error' ? audio.status.message : audio.audioState !== 'running' ? 'Tap Test announcement to enable audio.' : message || 'Listening for a sustained, high-confidence phase change.'}</p>}
  </section>;
}
