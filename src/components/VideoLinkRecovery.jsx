import { useState } from 'react';
import { base44 } from '../api/base44Client.js';
import ServerVideoBrowser from './ServerVideoBrowser.jsx';
import { relocateLinkedVideo, sameLinkedVideo } from '../lib/linkedVideoLocation.js';

export default function VideoLinkRecovery({ video, videos, onChange, cameraCard = false }) {
  const [editing,setEditing]=useState(false),[location,setLocation]=useState(video?.path||'');
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  if(!video)return null;
  const save=async()=>{
    setBusy(true);setError('');
    try {
      const meta=await base44.integrations.Core.GetLocalVideoMetadata({path:location.trim()});
      await onChange(relocateLinkedVideo(videos,video,meta));setEditing(false);
    }catch(err){setError(err?.data?.error||err.message);}finally{setBusy(false);}
  };
  const clear=async()=>{
    setBusy(true);setError('');
    try{await onChange(videos.filter(v=>!sameLinkedVideo(v,video)));}catch(err){setError(err?.data?.error||err.message);}finally{setBusy(false);}
  };
  return <div className="min-w-0 text-xs">
    <div className="mt-2 flex flex-wrap gap-2">
      <button type="button" disabled={busy} onClick={()=>{setLocation(video.path);setEditing(!editing);setError('');}} className="rounded border border-primary/30 px-2 py-1 text-primary">{cameraCard ? "Change video" : "Change location"}</button>
      <button type="button" disabled={busy} onClick={clear} className="rounded border border-border px-2 py-1 text-muted-foreground" title="Remove the saved video link; keep the recording and annotations">{cameraCard ? "Clear video" : "Clear link"}</button>
    </div>
    {editing&&<div className="mt-2 space-y-2 rounded border border-border bg-background p-2">
      <p className="break-all text-[10px] text-muted-foreground">Current: {video.path}</p>
      <input aria-label="New video location" value={location} onChange={e=>setLocation(e.target.value)} className="w-full min-w-0 rounded border border-border bg-background p-2"/>
      <ServerVideoBrowser onSelect={meta=>setLocation(meta.path)}/>
      <p className="text-[10px] text-muted-foreground">Choose the same recording in its new location. Camera, timing offset and saved reviews are kept.</p>
      <button type="button" disabled={busy||!location.trim()} onClick={save} className="rounded bg-primary px-2 py-1 text-primary-foreground">{busy?'Checking and saving…':'Save location'}</button>
    </div>}
    {error&&<p role="alert" className="mt-1 text-destructive">{error}</p>}
  </div>;
}
