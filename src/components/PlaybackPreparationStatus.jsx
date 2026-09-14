import React from 'react';
const time=v=>{const s=Math.max(0,Math.round(v||0));return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;};
export default function PlaybackPreparationStatus({progress,filename}) {
  const p=progress||{};
  return <div role="status" className="rounded-lg border border-primary/20 bg-primary/[0.06] p-3 text-xs">
    <p className="font-semibold text-primary">{p.stage||'Starting MP4 preparation…'}{p.status==='queued'&&p.queuePosition?` · queue ${p.queuePosition}`:''}</p>
    {filename&&<p className="truncate text-[10px] text-muted-foreground">{filename}</p>}
    {p.percent!=null&&<><progress aria-label="MP4 conversion progress" value={p.percent} max="100" className="my-1 h-2 w-full accent-teal-500"/><p>{Math.floor(p.percent)}% · {time(p.encodedSeconds)} / {time(p.durationSeconds)} converted{p.speed?` · ${p.speed.toFixed(1)}× speed`:''}</p></>}
    {p.elapsedSeconds!=null&&<p className="text-[10px] text-muted-foreground">Elapsed {time(p.elapsedSeconds)}{p.etaSeconds!=null?` · about ${time(p.etaSeconds)} remaining`:''}{p.fallback?' · GPU unavailable; using CPU':''}</p>}
    {p.secondsSinceProgress>30&&<p className="mt-1 text-amber-400">No new encoder progress for {time(p.secondsSinceProgress)}. {p.stage==='Finalizing MP4'?'Finishing the MP4 file.':'The conversion may be stalled.'}</p>}
  </div>;
}
