import {useEffect,useMemo,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {videoEventContext} from '../lib/videoEventContext.js';
import {VisualEventSummary} from './VisualEventMarkup.jsx';
const clock=t=>`${Math.floor(t/60)}:${String(Math.floor(t%60)).padStart(2,'0')}`;
export default function VideoEventContextCard({label,entry,rows,onSeek,onVisualOpen}) {
  const root=useRef(null),dialog=useRef(null),[open,setOpen]=useState(false);
  const event=entry?.ev,metrics=useMemo(()=>event?videoEventContext(rows,event.time_s):[],[rows,event]);
  const note=event?.note||'No event',long=note.length>150;
  useEffect(()=>{if(open)dialog.current?.showModal();},[open]);
  return <article ref={root} className="video-event-context" aria-label={label}>
    <button type="button" disabled={!event} onClick={()=>onSeek(entry)} className="video-event-context-main">
      <header><b>{label}</b><time>{event?clock(event.time_s):'—'}</time></header>
      <p>{long?`${note.slice(0,147)}…`:note}</p>
    </button>
    {event?.visual_annotation&&<VisualEventSummary compact annotation={event.visual_annotation} onOpen={onVisualOpen?()=>onVisualOpen(event,entry.i):undefined}/>}
    <footer>{metrics.map(([key,value])=><span key={key}><span>{key}</span> <b>{value}</b></span>)}{event&&!metrics.length&&<span>No aligned HR sample</span>}
      {long&&<button type="button" onClick={()=>setOpen(true)}>Read full note</button>}
    </footer>
    {open&&createPortal(<dialog ref={dialog} className="video-note-dialog" aria-label={`${label} full note`} onCancel={()=>setOpen(false)}>
      <header><b>{label} · {clock(event.time_s)}</b><button onClick={()=>setOpen(false)}>Close note</button></header><p>{note}</p>
      <footer>{metrics.map(([key,value])=><span key={key}>{key} {value}</span>)}</footer>
    </dialog>,root.current.ownerDocument.fullscreenElement||root.current.ownerDocument.body)}
  </article>;
}
