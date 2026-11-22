import TelemetryPickerMenu from './TelemetryPickerMenu.jsx';
import { Children, isValidElement, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ResizableVideoTelemetry from './ResizableVideoTelemetry.jsx';
import './videoTelemetryOverlays.css';
import { place, reflowOverlay,fitOverlayBounds } from '../lib/videoOverlayLayout.js';

const STORAGE = 'sarah.videoSync.overlays.v1';
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
function clean(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([id, box]) => /^[a-zA-Z0-9_-]+$/.test(id) && box && ['x', 'y', 'w', 'h', 'opacity'].every(key => Number.isFinite(box[key])))
    .map(([id, box]) => {
      const w = clamp(box.w, .15, 1), h = clamp(box.h, .12, 1);
      return [id, { w, h, x: clamp(box.x, 0, 1-w), y: clamp(box.y, 0, 1-h), opacity: clamp(box.opacity, .15, 1) }];
    }));
}
export function useVideoTelemetryOverlays() {
  const [boxes, setBoxes] = useState(() => { try { return clean(JSON.parse(localStorage.getItem(STORAGE))); } catch { return {}; } });
  const [draft,setDraft]=useState(null),[activeId,setActiveId]=useState('');
  const [notice, setNotice] = useState(null);
  const [target, setTarget] = useState(null);
  const [pickerTarget, setPickerTarget] = useState(null);
  const constrain=(id,box)=>{const r=target?.getBoundingClientRect();return fitOverlayBounds(id,box,r?.width,r?.height);};
  useEffect(()=>{
    if(!target)return undefined;
    const observer=new ResizeObserver(()=>setBoxes(previous=>{
      const next=Object.fromEntries(Object.entries(previous).map(([id,b])=>[id,constrain(id,b)]));
      return JSON.stringify(previous)===JSON.stringify(next)?previous:next;
    }));observer.observe(target);return()=>observer.disconnect();
  },[target]);
  useEffect(() => { try { localStorage.setItem(STORAGE, JSON.stringify(boxes)); } catch { /* Storage may be unavailable. */ } }, [boxes]);
  const update = (id, patch) => {setDraft(null);setBoxes(previous=>reflowOverlay(previous,id,constrain(id,{...previous[id],...patch})));};
  const preview = (id,patch) => setDraft(reflowOverlay(boxes,id,constrain(id,{...boxes[id],...patch})));
  const toggle = id => { setNotice(null);
    const next = { ...boxes };
    if (next[id]) delete next[id];
    else {
      const offset = (Object.keys(next).length % 6) * .045;
      const rect=target?.getBoundingClientRect();
      const candidate = { x:.03+offset,y:.03+offset,w:Math.min(.95,Math.max(id.startsWith('metric-')?.24:.48,(id.startsWith('metric-')?200:280)/(rect?.width||1200))),h:Math.min(.95,Math.max(id.startsWith('metric-')?.25:.4,(id.startsWith('metric-')?140:240)/(rect?.height||800))),opacity:.9 };
      const available = place(constrain(id,candidate), next);
      if (available) next[id] = constrain(id,available);
      else {next[id]=constrain(id,candidate);setActiveId(id);}
    }
    setBoxes(next);
  };
  return { boxes:draft||boxes, notice, target, setTarget, pickerTarget, setPickerTarget, update, preview, cancelPreview:()=>setDraft(null),activeId,setActiveId,toggle };
}

function OverlayBreakout({label,children,onClose,target}) {
  const ref=useRef(null);
  useEffect(()=>{ref.current.showModal();},[]);
  return createPortal(<dialog ref={ref} className="video-overlay-breakout" aria-label={`${label} breakout`} onCancel={onClose}>
    <header><b>{label}</b><button onClick={onClose}>Close expanded card</button></header>
    <div className="video-overlay-content">{children}</div>
  </dialog>,target.ownerDocument.fullscreenElement||target.ownerDocument.body);
}

function FloatingTelemetry({ id, label, children, controller }) {
  const drag = useRef(null);
  const suppressClick = useRef(false);
  const [preview, setPreview] = useState(null);
  const [expanded,setExpanded]=useState(false);

  const savedBox = controller.boxes[id];
  const box = preview || savedBox;
  const start = (event, mode) => {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    suppressClick.current = true;
    controller.setActiveId(id);
    event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = controller.target.getBoundingClientRect();
    drag.current = { mode, x: event.clientX, y: event.clientY, bounds, box: savedBox, next: savedBox };
  };
  const move = event => {
    const d = drag.current;
    if (!d || !d.bounds.width || !d.bounds.height) return;
    const dx = (event.clientX - d.x) / d.bounds.width, dy = (event.clientY - d.y) / d.bounds.height;
    const minW=(id.startsWith('metric-')?180:id==='phase'?360:320)/d.bounds.width,minH=(id.startsWith('metric-')?120:id==='phase'?300:230)/d.bounds.height;
    d.next = { ...d.box, ...(d.mode === 'move'
      ? { x: clamp(d.box.x + dx, 0, 1-d.box.w), y: clamp(d.box.y + dy, 0, 1-d.box.h) }
      : { w: clamp(d.box.w + dx, Math.min(minW,1-d.box.x), 1-d.box.x), h: clamp(d.box.h + dy, Math.min(minH,1-d.box.y), 1-d.box.y) }) };
    // Preview can cross occupied space. Only the final drop is persisted.
    setPreview(d.next);
    controller.preview(id,d.next);
  };
  const stop = event => { const d=drag.current; drag.current=null; setPreview(null);
    if (d && event.type!=='pointercancel') controller.update(id,d.next);else controller.cancelPreview();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); };
  const pointerProps = { onPointerMove: move, onPointerUp: stop, onPointerCancel: stop, onLostPointerCapture: () => { drag.current = null; setPreview(null);controller.cancelPreview(); } };
  const keyboard = (event, mode) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const dx = event.key === 'ArrowLeft' ? -.01 : event.key === 'ArrowRight' ? .01 : 0;
    const dy = event.key === 'ArrowUp' ? -.01 : event.key === 'ArrowDown' ? .01 : 0;
    controller.update(id, mode === 'move' ? { x: clamp(box.x+dx, 0, 1-box.w), y: clamp(box.y+dy, 0, 1-box.h) }
      : { w: clamp(box.w+dx, .15, 1-box.x), h: clamp(box.h+dy, .12, 1-box.y) });
  };
  const keyDown = event => {
    if (event.target.closest('input,textarea,select') || event.ctrlKey || event.altKey || event.metaKey) return;
    const plus = ['+', '='].includes(event.key) || event.code === 'NumpadAdd';
    const minus = event.key === '-' || event.code === 'NumpadSubtract';
    if (plus || minus) {
      event.preventDefault(); event.stopPropagation();
      controller.update(id, { opacity: clamp(box.opacity + (plus ? -.05 : .05), .15, 1) });
    }
    if (event.key === 'Escape') { event.stopPropagation(); event.currentTarget.blur(); }
    if (event.key === 'Delete' && event.target === event.currentTarget) { event.preventDefault(); controller.toggle(id); }
  };
  return <section data-video-overlay={id} aria-label={`${label} video overlay`} tabIndex={0} className="video-telemetry-overlay"
    data-dragging={Boolean(preview)}
    onFocus={()=>controller.setActiveId(id)}
    onKeyDown={keyDown}
    onPointerDown={event => {
      if (event.target.closest('button,input,select,textarea,[role=slider]')) return;
      event.currentTarget.focus({preventScroll:true});
      controller.setActiveId(id);
      if (event.ctrlKey) start(event, 'move');
    }} {...pointerProps}
    onClickCapture={event => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; } }}
    style={{ left: `${box.x*100}%`, top: `${box.y*100}%`, width: `${box.w*100}%`, height: `${box.h*100}%`, zIndex: preview||controller.activeId===id ? 100 : 1 }}>
    <header className="video-overlay-handlebar"><button type="button" aria-label={`Move ${label} overlay`} onPointerDown={event=>start(event,'move')} onKeyDown={event=>{keyboard(event,'move');event.stopPropagation();}} {...pointerProps}>⠿ {label}</button><button type="button" aria-label={`Expand ${label} overlay`} onClick={()=>setExpanded(true)}>⤢</button></header>
    <div className="video-overlay-content" style={{ opacity: box.opacity }}>{children}</div>
    {expanded&&<OverlayBreakout label={label} target={controller.target} onClose={()=>setExpanded(false)}>{children}</OverlayBreakout>}
    <button type="button" className="video-overlay-resize" aria-label={`Resize ${label} overlay`} title="Drag to resize; arrow keys also resize"
      onPointerDown={event => start(event, 'resize')} onKeyDown={event => { keyboard(event, 'resize'); event.stopPropagation(); }} {...pointerProps}>◢</button>
  </section>;
}
// Reuse the actual React cards and their callbacks, not screenshots or DOM copies.
export default function VideoTelemetryOverlays({ children, controller, resizable, dashboard }) {
  if (!controller) return <ResizableVideoTelemetry enabled={resizable} dashboard={dashboard}>{children}</ResizableVideoTelemetry>;
  const items = Children.toArray(children.props.children);
  const sections = items.filter(child => isValidElement(child) && child.props['data-sidebar-section']);
  const entries = sections.map(child => ({ id: child.props['data-sidebar-section'][0], label: child.props['data-sidebar-section'][1], child }));
  const metrics = sections.find(child => child.props['data-sidebar-section'][0] === 'metrics');
  if (metrics) Children.toArray(metrics.props.children).filter(isValidElement).forEach(child => {
    if (child.props.label) entries.push({ id: `metric-${child.props.label.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}`, label: child.props.label, child });
  });
  const missing = Object.keys(controller.boxes).filter(id => !entries.some(entry => entry.id === id));
  const picker = <TelemetryPickerMenu key="overlay-picker" label="Add overlays to video" summary={`${Object.keys(controller.boxes).length} selected`}
    help="Drag a card header to move it; neighbors shift aside. Drag its corner to resize. Expand opens a full-size card. Ctrl-drag on the card also moves it."
    notice={controller.notice} options={[...entries.map(({id,label})=>({id,label,checked:Boolean(controller.boxes[id]),onChange:()=>controller.toggle(id)})),
      ...missing.map(id=>({id,label:`${id} · no data (remove)`,checked:true,onChange:()=>controller.toggle(id)}))]} />;
  return <><ResizableVideoTelemetry enabled={resizable} dashboard={dashboard}>{children}</ResizableVideoTelemetry>
    {controller.pickerTarget && createPortal(picker, controller.pickerTarget)}
    {controller.target && createPortal(entries.filter(entry => controller.boxes[entry.id]).map(({ id, label, child }) =>
      <FloatingTelemetry key={id} id={id} label={label} controller={controller}>{child}</FloatingTelemetry>), controller.target)}
  </>;
}
