export default function VideoPhaseVoice({controller}) {
  const {settings,setSettings,audio,message,toggle,test}=controller;
  return <div className="relative z-40 flex shrink-0 items-center gap-1 text-xs">
    <button type="button" aria-pressed={settings.enabled} onClick={toggle} className="rounded border border-border px-2 py-1">Phase voice {settings.enabled?'on':'off'}</button>
    <details className="relative"><summary className="cursor-pointer rounded border border-border px-2 py-1" aria-label="Phase voice options">Voice options</summary>
      <div className="absolute left-0 top-full z-[100] mt-2 w-72 rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-xl space-y-2">
        <label className="flex gap-2">Volume<input aria-label="Playback phase voice volume" type="range" min="0" max="1" step=".05" value={settings.volume} onChange={e=>setSettings(s=>({...s,volume:Number(e.target.value)}))}/>{Math.round(settings.volume*100)}%</label>
        <button type="button" onClick={test} disabled={!settings.enabled||audio.status.phase==='preparing'} className="rounded border px-2 py-1">Test playback voice</button>
        <p>12 seconds of sustained video evidence; at least 15 real seconds between announcements. Normal speech speed, including at 6×. Seeks and pauses reset observation. Climax is a candidate, not confirmation.</p>
        <p>Separate from Live Capture encouragement. Only fixed announcement phrases go to your selected TTS provider.</p>
        <p role="status">{!settings.enabled?'Off':audio.status.phase==='error'?audio.status.message:audio.status.phase==='preparing'?'Preparing voice…':audio.audioState!=='running'?'Tap Test playback voice to enable audio.':message||'Listening during playback.'}</p>
      </div>
    </details>
  </div>;
}

