import {useMemo,useRef,useState} from 'react';
import {ChevronDown,Check,Search,Clock,Video,Bookmark,Heart,CalendarDays,Activity} from 'lucide-react';
import moment from 'moment';
import {Popover,PopoverContent,PopoverTrigger} from './ui/popover';
import {videoRecordSummary} from '../lib/videoRecordSummary.js';
import './videoSessionPicker.css';
import {recordFlag} from '../lib/sessionRecordFlags.js';

const formatNumber=(value,digits=0)=>value!=null&&Number.isFinite(Number(value))?Number(value).toFixed(digits):'—';
function SnapshotMetrics({label,unit,stats,digits=0}) {
  if(!stats)return null;
  return <div className="video-session-snapshot" aria-label={`${label} snapshot`}>
    <span className="video-session-snapshot-label">{label==='HR'?<Heart aria-hidden="true"/>:<Activity aria-hidden="true"/>}{label} <small>{unit}</small></span>
    {[['Min',stats.min],['Avg',stats.avg],['Max',stats.max]].map(([name,value])=><span key={name}><small>{name}</small>{' '}<b>{formatNumber(value,digits)}</b></span>)}
    {stats.quality?.includes('raw')&&<small className="video-session-raw">Raw / uncalibrated</small>}
  </div>;
}
function RecordDetails({record,type}) {
  const summary=videoRecordSummary(record,type);
  return <article className="video-session-card">
    <header className="video-session-card-heading">
      <div className="video-session-card-name"><div className="video-session-picker-title"><strong>{summary.title}</strong>{recordFlag(record.is_favorite)&&<span aria-label="Favorite">★</span>}</div>
      <span className="video-session-outcome" data-tone={summary.outcome.tone}>{summary.outcome.label}</span></div>
      <div className="video-session-date-labels"><span className="video-session-chip" aria-label={`Session date: ${record.date?moment(record.date).format('MMM D, YYYY'):'Date unknown'}`}><CalendarDays aria-hidden="true"/>{record.date?moment(record.date).format('MMM D, YYYY'):'Date unknown'}</span><span className="video-session-chip" aria-label={`Session time: ${record.start_time||'Time unknown'}`}><Clock aria-hidden="true"/>{record.start_time||'Time unknown'}</span></div>
    </header>
    <div className="video-session-devices" aria-label="Recorded devices and sensors">{summary.devices.length?summary.devices.map(device=><span className="video-session-device" key={device}>{device}</span>):<span className="video-session-no-data">{record.review_snapshot?'No sensor data recorded':'Sensor details unavailable'}</span>}</div>
    <div className="video-session-snapshots"><SnapshotMetrics label="HR" unit="bpm" stats={summary.heartRate?.avg!=null||summary.heartRate?.max!=null?summary.heartRate:null}/><SnapshotMetrics label="Pelvic pressure" unit="kPa" stats={summary.pressure} digits={2}/></div>
    {record.review_snapshot?.pressure_error&&<span className="video-session-no-data">Pelvic pressure summary unavailable</span>}
    {summary.preview&&<p className="video-session-picker-preview">{summary.preview}</p>}
    <footer className="video-session-picker-metrics">
      <span className="video-session-chip video-session-duration"><Clock aria-hidden="true"/>{summary.duration}</span>
      <span className="video-session-chip"><Video aria-hidden="true"/>{summary.videos} linked video{summary.videos===1?'':'s'}</span>
      <span className="video-session-chip"><Bookmark aria-hidden="true"/>{summary.events} event{summary.events===1?'':'s'}</span>
      <span className="video-session-chip">{summary.episodes} marked episode{summary.episodes===1?'':'s'}</span>
    </footer>
  </article>;
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
    <PopoverContent align="start" className="video-session-picker-panel p-2.5" style={{width:'min(960px, calc(100vw - 24px))'}} aria-label={`Choose ${label}`} onOpenAutoFocus={event=>{event.preventDefault();searchRef.current?.focus();}} onKeyDown={moveFocus}>
      <label className="video-session-picker-search"><Search aria-hidden="true"/><input ref={searchRef} value={query} onChange={event=>setQuery(event.target.value)} placeholder="Search title, date or tag…" aria-label="Search saved records"/></label>
      <p className="video-session-picker-count">{filtered.length} of {records.length} {type==='body_exploration'?'body exploration records':'sessions'} · newest first</p>
      <div ref={listRef} role="listbox" aria-label="Saved records" className="video-session-picker-list">
        {filtered.map(record=><button type="button" role="option" aria-selected={record.id===value} aria-label={`${videoRecordSummary(record,type).title}, ${record.date?moment(record.date).format('MMM D, YYYY'):'Date unknown'}, ${record.start_time||'Time unknown'}, ${videoRecordSummary(record,type).duration}, ${videoRecordSummary(record,type).outcome.label}`} key={record.id} className="video-session-picker-option" onClick={()=>{onValueChange(record.id);setOpen(false);}}>
          <div><RecordDetails record={record} type={type}/></div>{record.id===value&&<Check className="video-session-picker-check" aria-hidden="true"/>}
        </button>)}
        {!filtered.length&&<p className="video-session-picker-empty">{query?'No matching records. Try another title, date or tag.':`No saved ${label} records yet.`}</p>}
      </div>
    </PopoverContent>
  </Popover>;
}
