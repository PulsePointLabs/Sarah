import { useState } from 'react';
import { base44 } from '../api/base44Client.js';

export default function ServerVideoBrowser({ onSelect }) {
  const [listing,setListing]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [folder,setFolder]=useState(''),[query,setQuery]=useState(''),[page,setPage]=useState(0);
  const open=async path=>{
    setBusy(true);setError('');
    try {const data=await base44.integrations.Core.ListServerVideos({path});setListing(data);setFolder(data.path);setQuery('');setPage(0);}
    catch(err){setError(err?.data?.error||err.message);}finally{setBusy(false);}
  };
  const choose=async entry=>{
    if(entry.directory)return open(entry.path);
    setBusy(true);setError('');
    try { const meta=await base44.integrations.Core.GetLocalVideoMetadata({path:entry.path});onSelect(meta);setListing(null); }
    catch(err){setError(err?.data?.error||err.message);}finally{setBusy(false);}
  };
  const entries=(listing?.entries||[]).filter(e=>e.name.toLowerCase().includes(query.toLowerCase()));
  return <div className="space-y-2">
    <button type="button" disabled={busy} onClick={()=>listing?setListing(null):open('')} className="rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-primary">{busy?'Reading Windows recordings…':listing?'Close Windows browser':'Browse Windows recordings'}</button>
    <span className="ml-2 text-[11px] text-muted-foreground">Works from Chrome on another device; the original stays on Windows.</span>
    {error&&<p role="alert" className="text-xs text-destructive">{error}</p>}
    {listing&&<div className="rounded-lg border border-border p-3">
      <form className="flex gap-2" onSubmit={e=>{e.preventDefault();open(folder);}}>
        <button type="button" disabled={busy} onClick={()=>open(listing.parent||'')} className="rounded border px-2 text-xs">Up</button>
        <input aria-label="Windows recording folder" value={folder} onChange={e=>setFolder(e.target.value)} placeholder="E:\\Recordings" className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs"/>
        <button disabled={busy} className="rounded border px-2 text-xs">Open</button>
      </form>
      <input aria-label="Filter Windows recordings" value={query} onChange={e=>{setQuery(e.target.value);setPage(0);}} placeholder="Filter filenames…" className="my-2 w-full rounded border border-border bg-background px-2 py-1 text-xs"/>
      <div className="max-h-64 overflow-y-auto">{entries.slice(page*100,(page+1)*100).map(e=><button type="button" disabled={busy} key={e.path} onClick={()=>choose(e)} className="block w-full truncate rounded px-2 py-1.5 text-left text-xs hover:bg-primary/10" title={e.path}>{e.directory?'📁':'▶'} {e.name}</button>)}{!entries.length&&<p className="text-xs text-muted-foreground">No matching videos or folders.</p>}</div>
      {entries.length>100&&<div className="flex justify-between text-xs"><button disabled={!page} onClick={()=>setPage(p=>p-1)}>Previous</button><span>{page*100+1}–{Math.min((page+1)*100,entries.length)} of {entries.length}</span><button disabled={(page+1)*100>=entries.length} onClick={()=>setPage(p=>p+1)}>Next</button></div>}
      <p className="mt-2 text-[10px] text-muted-foreground">Select a recording, choose its camera label, then Link Video.</p>
    </div>}
  </div>;
}
