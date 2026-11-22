import {useMemo,useRef,useState} from 'react';
import {ChevronDown,Check,Search,Clock,Video,Bookmark,Heart} from 'lucide-react';
import moment from 'moment';
import {Popover,PopoverContent,PopoverTrigger} from './ui/popover';
import {videoRecordSummary} from '../lib/videoRecordSummary.js';
import './videoSessionPicker.css';

function RecordDetails({record,type}) {
  const summary=videoRecordSummary(record,type);
  return <>
    <div className="video-session-picker-title"><strong>{summary.title}</strong>{record.is_favorite&&<span aria-label="Favorite">★</span>}</div>
    <div className="video-session-picker-date">{record.date?moment(record.date).format('MMM D, YYYY'):'Date not recorded'}{record.start_time?` · ${record.start_time}`:''}</div>
    <div className="video-session-picker-metrics">
      <span><Clock aria-hidden="true"/>{summary.duration}</span>
      <span><Video aria-hidden="true"/>{summary.videos} linked video{summary.videos===1?'':'s'}</span>
      <span><Bookmark aria-hidden="true"/>{summary.events} event{summary.events===1?'':'s'} · {summary.episodes} marked episode{summary.episodes===1?'':'s'}</span>
      {Number(record.avg_hr)>0&&<span><Heart aria-hidden="true"/>Avg {Math.round(record.avg_hr)}{Number(record.max_hr)>0?` · peak ${Math.round(record.max_hr)}`:''} bpm</span>}
      {record.no_climax&&<span>No logged climax</span>}
    </div>
    {summary.preview&&<p className="video-session-picker-preview">{summary.preview}</p>}
  </>;
}

export default function VideoSessionPicker({records,type,value,onValueChange}) {
  const [open,setOpen]=useState(false),[query,setQuery]=useState('');
  const searchRef=useRef(null),listRef=useRef(null);
  const selected=records.find(record=>record.id===value);
  const filtered=useMemo(()=>records.filter(record=>`${videoRecordSummary(record,type).search} ${record.date?moment(record.date).format('MMM D, YYYY').toLowerCase():''}`.includes(query.trim().toLowerCase())),[records,type,query]);
  const label=type==='body_exploration'?'body exploration':'session';
  const moveFocus=event=>{
    if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
    const options=[...listRef.current.querySelectorAll('[role=option]')];if(!options.length)return;
    const current=options.indexOf(event.target);
    // Home/End retain normal editing behavior inside the search box.
    if(current<0&&event.key!=='ArrowDown'&&event.key!=='ArrowUp')return;
    event.preventDefault();
    const index=event.key==='Home'?0:event.key==='End'?options.length-1:current<0?(event.key==='ArrowDown'?0:options.length-1):(current+(event.key==='ArrowDown'?1:-1)+options.length)%options.length;
    options[index].focus();
  };
  return <Popover open={open} onOpenChange={next=>{setOpen(next);if(next)setQuery('');}}>
    <PopoverTrigger asChild><button type="button" role="combobox" aria-expanded={open} aria-haspopup="dialog" aria-label={`Choose ${label}`} className="video-session-picker-trigger">
      <div>{selected?<RecordDetails record={selected} type={type}/>:<><strong>Choose a {label}</strong><div className="video-session-picker-date">Browse {records.length} saved records · dates, duration and review details</div></>}</div><ChevronDown aria-hidden="true"/>
    </button></PopoverTrigger>
    <PopoverContent align="start" className="video-session-picker-panel p-2.5" style={{width:'min(780px, calc(100vw - 24px))'}} aria-label={`Choose ${label}`} onOpenAutoFocus={event=>{event.preventDefault();searchRef.current?.focus();}} onKeyDown={moveFocus}>
      <label className="video-session-picker-search"><Search aria-hidden="true"/><input ref={searchRef} value={query} onChange={event=>setQuery(event.target.value)} placeholder="Search title, date or tag…" aria-label="Search saved records"/></label>
      <p className="video-session-picker-count">{filtered.length} of {records.length} {type==='body_exploration'?'body exploration records':'sessions'} · newest first</p>
      <div ref={listRef} role="listbox" aria-label="Saved records" className="video-session-picker-list">
        {filtered.map(record=><button type="button" role="option" aria-selected={record.id===value} key={record.id} className="video-session-picker-option" onClick={()=>{onValueChange(record.id);setOpen(false);}}>
          <div><RecordDetails record={record} type={type}/></div>{record.id===value&&<Check className="video-session-picker-check" aria-hidden="true"/>}
        </button>)}
        {!filtered.length&&<p className="video-session-picker-empty">{query?'No matching records. Try another title, date or tag.':`No saved ${label} records yet.`}</p>}
      </div>
    </PopoverContent>
  </Popover>;
}
