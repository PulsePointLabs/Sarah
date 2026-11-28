import TelemetryPickerMenu from './TelemetryPickerMenu.jsx';
import { Children, isValidElement, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ResizableVideoTelemetry from './ResizableVideoTelemetry.jsx';
import './videoTelemetryOverlays.css';
import {VideoOverlayPreferenceScope} from './VideoOverlayPreferences.jsx';
import { place, reflowOverlay,projectOverlayLayout,snapOverlayBox,OVERLAY_GRID_PX } from '../lib/videoOverlayLayout.js';

const STORAGE = 'sarah.videoSync.overlays.v1';
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
function clean(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([id, box]) => /^[a-zA-Z0-9_-]+$/.test(id) && box && ['x', 'y', 'w', 'h', 'opacity'].every(key => Number.isFinite(box[key])))
    .map(([id, box]) => {
      const w = clamp(box.w, .03, 1), h = clamp(box.h, .03, 1);
      return [id, { w, h, x: clamp(box.x, 0, 1-w), y: clamp(box.y, 0, 1-h), opacity: clamp(box.opacity, .15, 1) }];
    }));
}
const OPTIONS='sarah.videoSync.overlayOptions.v1';
const restore=()=>{try{return clean(JSON.parse(localStorage.getItem(STORAGE)));}catch{return {};}};
const readOptions=()=>{try{const value=JSON.parse(localStorage.getItem(OPTIONS));return {snap:value?.snap!==false,hidden:value?.hidden===true};}catch{return {snap:true,hidden:false};}};
export function useVideoTelemetryOverlays() {
  const [preferred,setPreferred]=useState(restore),profile=useRef(preferred);
  const [options,setOptions]=useState(readOptions),optionsRef=useRef(options);optionsRef.current=options;
  const [draft,setDraft]=useState(null),[activeId,setActiveId]=useState(''),[editing,setEditing]=useState(false);
  const [target,setTarget]=useState(null),[pickerTarget,setPickerTarget]=useState(null);
  const [size,setSize]=useState({width:0,height:0}),sizeRef=useRef(size);sizeRef.current=size;
  const display=(source=profile.current)=>projectOverlayLayout(source,sizeRef.current.width,sizeRef.current.height);
  const save=next=>{profile.current=next;try{localStorage.setItem(STORAGE,JSON.stringify(next));}catch{}setPreferred(next);};
  useLayoutEffect(()=>{
    if(!target)return;
    const measure=()=>{const rect=target.getBoundingClientRect();if(rect.width>0&&rect.height>0)setSize(previous=>previous.width===rect.width&&previous.height===rect.height?previous:{width:rect.width,height:rect.height});};
    const observer=new target.ownerDocument.defaultView.ResizeObserver(measure);observer.observe(target);measure();return()=>observer.disconnect();
  },[target]);
  useEffect(()=>{
    const sync=event=>{if(event.key===STORAGE){const next=restore();profile.current=next;setPreferred(next);setDraft(null);}if(event.key===OPTIONS)setOptions(readOptions());};
    window.addEventListener('storage',sync);return()=>window.removeEventListener('storage',sync);
  },[]);
  const constrain=(id,box,config={})=>snapOverlayBox(id,box,sizeRef.current.width,sizeRef.current.height,{enabled:optionsRef.current.snap&&config.snap!==false,mode:config.mode||'move'});
  const update=(id,patch,config={})=>{
    setDraft(null);if(!profile.current[id])return;
    if(!['x','y','w','h'].some(key=>key in patch)){save({...profile.current,[id]:{...profile.current[id],...patch}});return;}
    const before=display(),mode=config.mode||('w'in patch||'h'in patch?'resize':'move');
    const active=constrain(id,{...before[id],...patch},{...config,mode});
    const placed=reflowOverlay(before,id,active,{...sizeRef.current,gridPx:optionsRef.current.snap&&config.snap!==false?OVERLAY_GRID_PX:0}),next={...profile.current};
    for(const [key,box]of Object.entries(placed)){
      if(key===id)next[key]={...next[key],x:box.x,y:box.y,...(mode.includes('resize')?{w:box.w,h:box.h}:{})};
      else if(box.x!==before[key].x||box.y!==before[key].y)next[key]={...next[key],x:box.x,y:box.y};
    }
    save(next);
  };
  const preview=(id,patch,config={})=>{const before=display(),next=constrain(id,{...before[id],...patch},{...config,snap:false});setDraft({...before,[id]:next});return next;};
  const toggle=id=>{
    const next={...profile.current};if(next[id])delete next[id];
    else{
      const offset=Object.keys(next).length%6*.045;
      const candidate=constrain(id,{x:.03+offset,y:.03+offset,w:id.startsWith('metric-')?.16:.28,h:id.startsWith('metric-')?.16:.25,opacity:.9},{mode:'move-resize'});
      next[id]=constrain(id,place(candidate,display())||candidate,{mode:'move-resize'});setActiveId(id);
    }
    save(next);
  };
  const setSnap=value=>{const next={...optionsRef.current,snap:value};optionsRef.current=next;setOptions(next);try{localStorage.setItem(OPTIONS,JSON.stringify(next));}catch{}};
  const setVisible=value=>{const next={...optionsRef.current,hidden:!value};optionsRef.current=next;setOptions(next);try{localStorage.setItem(OPTIONS,JSON.stringify(next));}catch{}};
  const resetPositions=()=>save(Object.fromEntries(Object.entries(profile.current).map(([id,box],i)=>[id,{...box,w:id.startsWith('metric-')?.16:.27,h:id.startsWith('metric-')?.15:.22,x:.015+(i%3)*.345,y:.02+Math.floor(i/3)*.235}])));
  return {boxes:draft||display(preferred),editing,setEditing,setVisible,resetPositions,target,setTarget,pickerTarget,setPickerTarget,update,preview,cancelPreview:()=>setDraft(null),activeId,setActiveId,toggle,options,setSnap,arranging:Boolean(draft),gridSize:OVERLAY_GRID_PX};
}

const palette=id=>id==='cardiac'||id==='metric-heart-rate'?['#34e37e','52,227,126']:id==='autonomic'||id==='metric-rmssd'?['#ffd43b','255,212,59']:id==='metric-sdnn'?['#38c8ff','56,200,255']:id==='metric-blood-pressure'?['#ff6b8b','255,107,139']:id==='civet'?['#55e4ce','85,228,206']:id==='howl'?['#b794ff','183,148,255']:id==='phase'?['#8ca3b8','140,163,184']:['#8ca3b8','140,163,184'];
const cardLabel=id=>({'metric-heart-rate':'HR','cardiac':'HR trend','autonomic':'HRV trend','metric-rmssd':'RMSSD','metric-sdnn':'SDNN','metric-blood-pressure':'Blood pressure','civet':'Pelvic pressure','phase':'Phase evidence','metrics':'Vital signs','howl':'Howl'})[id]||id.replace(/^metric-/,'').replaceAll('-',' ');

function OverlayBreakout({id,label,children,onClose,target,accent,rgb}) {
  const ref=useRef(null);
  useEffect(()=>{ref.current.showModal();},[]);
  return createPortal(<dialog ref={ref} data-overlay-kind={id} className="video-overlay-breakout" style={{'--overlay-accent':accent,'--overlay-accent-rgb':rgb}} aria-label={`${label} breakout`} onCancel={onClose}>
    <header><b>{label}</b><button onClick={onClose}>Close expanded card</button></header>
    <div className="video-overlay-content monitor-tile-body">{children}</div>
  </dialog>,target.ownerDocument.fullscreenElement||target.ownerDocument.body);
}

function FloatingTelemetry({ id, label, children, controller }) {
  const drag = useRef(null),pointers=useRef(new Map());
  const root=useRef(null),latest=useRef(null),wheelGesture=useRef(null),wheelTimer=useRef(null);
  const suppressClick = useRef(false);
  const [preview, setPreview] = useState(null);
  const [expanded,setExpanded]=useState(false);

  const savedBox = controller.boxes[id];
  const box = preview || savedBox;
  latest.current={controller,savedBox};
  useEffect(()=>{
    const element=root.current;
    const wheel=event=>{
      if(event.target.closest('input,select,textarea,[role=slider]'))return;
      event.preventDefault();event.stopPropagation();
      const {controller,savedBox}=latest.current;
      if(!controller.editing)return;
      if(!wheelGesture.current)wheelGesture.current={box:savedBox,dx:0,dy:0,mode:event.ctrlKey?'resize':'move'};
      const g=wheelGesture.current,bounds=controller.target.getBoundingClientRect(),scale=event.deltaMode===1?16:1;
      g.dx+=event.deltaX*scale;g.dy+=event.deltaY*scale;
      const patch=g.mode==='resize'?{w:g.box.w+g.dx/bounds.width,h:g.box.h+g.dy/bounds.height}:{x:g.box.x+g.dx/bounds.width,y:g.box.y+g.dy/bounds.height};
      g.next=controller.preview(id,patch,{mode:g.mode,snap:false});setPreview(g.next);
      clearTimeout(wheelTimer.current);wheelTimer.current=setTimeout(()=>{latest.current.controller.update(id,g.next,{mode:g.mode});wheelGesture.current=null;setPreview(null);},220);
    };
    element.addEventListener('wheel',wheel,{passive:false});
    return()=>{element.removeEventListener('wheel',wheel);clearTimeout(wheelTimer.current);};
  },[id]);
  const start = (event, mode) => {
    if (event.button !== 0) return;
    controller.setEditing(true);
    event.preventDefault(); event.stopPropagation();
    suppressClick.current = true;
    controller.setActiveId(id);
    event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = controller.target.getBoundingClientRect();
    const points=[...pointers.current.values()],dual=points.length===2;
    drag.current = { mode, x:dual?points.reduce((s,p)=>s+p.x,0)/2:event.clientX,y:dual?points.reduce((s,p)=>s+p.y,0)/2:event.clientY,dual,bounds, box: savedBox, next: savedBox, moved:false };
  };
  const move = event => {
    const d = drag.current;
    if (!d || !d.bounds.width || !d.bounds.height) return;
    if(pointers.current.has(event.pointerId))pointers.current.set(event.pointerId,{x:event.clientX,y:event.clientY});
    const points=[...pointers.current.values()],x=d.dual&&points.length?points.reduce((s,p)=>s+p.x,0)/points.length:event.clientX,y=d.dual&&points.length?points.reduce((s,p)=>s+p.y,0)/points.length:event.clientY;
    if(!d.moved&&Math.hypot(x-d.x,y-d.y)<4)return;
    d.moved=true;
    const dx = (x - d.x) / d.bounds.width, dy = (y - d.y) / d.bounds.height;
    const minW=.01,minH=.01;
    const candidate = { ...d.box, ...(d.mode === 'move'
      ? { x: clamp(d.box.x + dx, 0, 1-d.box.w), y: clamp(d.box.y + dy, 0, 1-d.box.h) }
      : { w: clamp(d.box.w + dx, Math.min(minW,1-d.box.x), 1-d.box.x), h: clamp(d.box.h + dy, Math.min(minH,1-d.box.y), 1-d.box.y) }) };
    d.next=controller.preview(id,candidate,{mode:d.mode,snap:!event.altKey});
    setPreview(d.next);
  };
  const stop = event => { const d=drag.current; drag.current=null;pointers.current.clear(); setPreview(null);
    if(event.type==='pointercancel'||!d?.moved)suppressClick.current=false;
    if (d?.moved && event.type!=='pointercancel') controller.update(id,d.next,{mode:d.mode,snap:!event.altKey});else controller.cancelPreview();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); };
  const pointerProps = { onPointerMove: move, onPointerUp: stop, onPointerCancel: stop, onLostPointerCapture: () => { drag.current = null; setPreview(null);controller.cancelPreview(); } };
  const keyboard = (event, mode) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();event.stopPropagation();
    const bounds=controller.target.getBoundingClientRect(),step=controller.options.snap&&!event.altKey?controller.gridSize:1;
    const dx=(event.key==='ArrowLeft'?-step:event.key==='ArrowRight'?step:0)/bounds.width;
    const dy=(event.key==='ArrowUp'?-step:event.key==='ArrowDown'?step:0)/bounds.height;
    controller.update(id, mode === 'move' ? { x: clamp(box.x+dx, 0, 1-box.w), y: clamp(box.y+dy, 0, 1-box.h) }
      : { w: clamp(box.w+dx, .01, 1-box.x), h: clamp(box.h+dy, .01, 1-box.y) },{mode,snap:!event.altKey});
  };
  const keyDown = event => {
    if (event.target.closest('input,textarea,select') || event.ctrlKey || event.altKey || event.metaKey) return;
    const plus = ['+', '='].includes(event.key) || event.code === 'NumpadAdd';
    const minus = event.key === '-' || event.code === 'NumpadSubtract';
    if (plus || minus) {
      event.preventDefault(); event.stopPropagation();
      controller.update(id, { opacity: clamp(box.opacity + (plus ? -.05 : .05), .15, 1) });
    }
    if (event.key === 'Escape') { event.stopPropagation();event.target.blur?.();event.currentTarget.blur(); }
    if (event.key === 'Delete' && event.target === event.currentTarget) { event.preventDefault(); controller.toggle(id); }
  };
  const [accent,rgb]=palette(id);
  return <section ref={root} data-video-overlay={id} aria-label={`${label} video overlay`} tabIndex={0} className="video-telemetry-overlay"
    data-dragging={Boolean(preview)}
    onFocus={()=>controller.setActiveId(id)}
    onKeyDown={keyDown}
    onPointerDown={event => {
      if (event.target.closest('button,input,select,textarea,[role=slider]')) return;
      event.currentTarget.focus({preventScroll:true});
      controller.setActiveId(id);
      if(event.pointerType==='touch'){pointers.current.set(event.pointerId,{x:event.clientX,y:event.clientY});if(pointers.current.size===2)start(event,'move');}
      else if (event.ctrlKey) start(event, 'move');
    }} {...pointerProps}
    onClickCapture={event => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; } }}
    style={{ left: `${box.x*100}%`, top: `${box.y*100}%`, width: `${box.w*100}%`, height: `${box.h*100}%`, '--overlay-accent':accent,'--overlay-accent-rgb':rgb,zIndex: preview||controller.activeId===id ? 100 : 1 }}>
    <header className="video-overlay-handlebar"><button type="button" aria-label={`Move ${label} overlay`} onClick={()=>{controller.setEditing(true);controller.setActiveId(id);}} onPointerDown={event=>start(event,'move')} onKeyDown={event=>keyboard(event,'move')} {...pointerProps}>⠿ {cardLabel(id)}</button><button type="button" aria-label={`Expand ${label} overlay`} onClick={()=>setExpanded(true)}>⤢</button></header>
    <VideoOverlayPreferenceScope.Provider value={id}><div className="video-overlay-content monitor-tile-body" style={{ opacity: box.opacity }}>{children}</div>
    {expanded&&<OverlayBreakout id={id} label={label} target={controller.target} accent={accent} rgb={rgb} onClose={()=>setExpanded(false)}>{children}</OverlayBreakout>}</VideoOverlayPreferenceScope.Provider>
    <button type="button" className="video-overlay-resize" aria-label={`Resize ${label} overlay`}
      onPointerDown={event => start(event, 'resize')} onKeyDown={event => keyboard(event,'resize')} {...pointerProps}>◢</button>
  </section>;
}
function OverlayArrangeTools({controller,entries}){
  const [placing,setPlacing]=useState(false);
  const id=controller.boxes[controller.activeId]?controller.activeId:Object.keys(controller.boxes)[0],box=controller.boxes[id];
  if(!box)return null;
  const resize=(w,h)=>controller.update(id,{w:box.w*w,h:box.h*h},{mode:'resize',snap:false});
  const move=(x,y)=>{const r=controller.target.getBoundingClientRect();controller.update(id,{x:box.x+x/r.width,y:box.y+y/r.height},{mode:'move'});};
  return <>
    {placing&&<div className="overlay-place-surface" onPointerDown={event=>{event.preventDefault();event.stopPropagation();const r=controller.target.getBoundingClientRect();controller.update(id,{x:(event.clientX-r.left)/r.width-box.w/2,y:(event.clientY-r.top)/r.height-box.h/2},{mode:'move'});setPlacing(false);}}><span>Click where this card should go</span></div>}
    <div className="overlay-arrange-tools" role="toolbar" aria-label="Arrange video overlays" onKeyDown={event=>event.stopPropagation()}>
      <select aria-label="Overlay to arrange" value={id} onChange={event=>controller.setActiveId(event.target.value)}>{Object.keys(controller.boxes).map(key=><option key={key} value={key}>{entries.find(entry=>entry.id===key)?.label||cardLabel(key)}</option>)}</select>
      <button aria-pressed={placing} onClick={()=>setPlacing(!placing)}>Place</button>
      <button aria-label="Move overlay left" onClick={()=>move(-24,0)}>←</button><button aria-label="Move overlay up" onClick={()=>move(0,-24)}>↑</button><button aria-label="Move overlay down" onClick={()=>move(0,24)}>↓</button><button aria-label="Move overlay right" onClick={()=>move(24,0)}>→</button>
      <button onClick={()=>resize(.8,.8)}>Smaller</button><button onClick={()=>resize(1.2,1.2)}>Bigger</button><button onClick={()=>resize(.8,1)}>Narrower</button><button onClick={()=>resize(1,.8)}>Shorter</button>
      <button onClick={()=>controller.setEditing(false)}>Done</button>
    </div>
  </>;
}
// Reuse the actual React cards and their callbacks, not screenshots or DOM copies.
export default function VideoTelemetryOverlays({ children, controller, resizable, dashboard, overlayEntries=[] }) {
  if (!controller) return <ResizableVideoTelemetry enabled={resizable} dashboard={dashboard}>{children}</ResizableVideoTelemetry>;
  const items = Children.toArray(children.props.children);
  const sections = items.filter(child => isValidElement(child) && child.props['data-sidebar-section']);
  const entries = sections.map(child => ({ id: child.props['data-sidebar-section'][0], label: child.props['data-sidebar-section'][1], child }));
  const metrics = sections.find(child => child.props['data-sidebar-section'][0] === 'metrics');
  if (metrics) Children.toArray(metrics.props.children).filter(isValidElement).forEach(child => {
    if (child.props.label) entries.push({ id: `metric-${child.props.label.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}`, label: child.props.label, child });
  });
  for(const entry of overlayEntries){const index=entries.findIndex(item=>item.id===entry.id);if(index>=0)entries[index]=entry;else entries.push(entry);}
  const missing = Object.keys(controller.boxes).filter(id => !entries.some(entry => entry.id === id));
  const picker = <TelemetryPickerMenu key="overlay-picker" label="Add overlays to video" summary={`${Object.keys(controller.boxes).length} selected`}
    help="Drag a header to move, or a corner to resize. Snap uses a 24 px grid; hold Alt for fine placement. Neighbors stay still while dragging and move on a deliberate overlapping drop. Layout and card options are shared across sessions."
    notice={controller.notice} options={[{id:'snap-grid',label:'Snap to grid',checked:controller.options.snap,onChange:()=>controller.setSnap(!controller.options.snap)},...entries.map(({id,label})=>({id,label,checked:Boolean(controller.boxes[id]),onChange:()=>controller.toggle(id)})),
      ...missing.map(id=>({id,label:`${id} · no data (remove)`,checked:true,onChange:()=>controller.toggle(id)}))]} />;
  return <><ResizableVideoTelemetry enabled={resizable} dashboard={dashboard}>{children}</ResizableVideoTelemetry>
    {controller.pickerTarget && createPortal(picker, controller.pickerTarget)}
    {controller.target && !controller.options.hidden && createPortal(<>
      {controller.arranging&&controller.options.snap&&<div className="video-overlay-snap-grid" aria-hidden="true" style={{backgroundSize:`${controller.gridSize}px ${controller.gridSize}px`}}/>}
      {entries.filter(entry=>controller.boxes[entry.id]).map(({id,label,child})=><FloatingTelemetry key={id} id={id} label={label} controller={controller}>{child}</FloatingTelemetry>)}
      {missing.map(id=><FloatingTelemetry key={id} id={id} label={cardLabel(id)} controller={controller}><div className="video-overlay-empty"><strong>{cardLabel(id)}</strong><p>No data in this view.</p><p>Your saved layout is kept.</p></div></FloatingTelemetry>)}
      {controller.editing&&<OverlayArrangeTools controller={controller} entries={entries}/>}
    </>,controller.target)}
  </>;
}
