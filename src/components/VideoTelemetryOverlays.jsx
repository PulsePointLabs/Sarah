import { Children, isValidElement, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ResizableVideoTelemetry from './ResizableVideoTelemetry.jsx';
import './videoTelemetryOverlays.css';
import { fits, place, restoreLayout } from '../lib/videoOverlayLayout.js';

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
  const [boxes, setBoxes] = useState(() => { try { return restoreLayout(clean(JSON.parse(localStorage.getItem(STORAGE)))); } catch { return {}; } });
  const [notice, setNotice] = useState(null);
  const [target, setTarget] = useState(null);
  const [pickerTarget, setPickerTarget] = useState(null);
  useEffect(() => { try { localStorage.setItem(STORAGE, JSON.stringify(boxes)); } catch { /* Storage may be unavailable. */ } }, [boxes]);
  const update = (id, patch) => setBoxes(previous => { const next = { ...previous[id], ...patch }; return fits(next, previous, id) ? { ...previous, [id]: next } : previous; });
  const toggle = id => { setNotice(null);
    const next = { ...boxes };
    if (next[id]) delete next[id];
    else {
      const offset = (Object.keys(next).length % 6) * .045;
      const candidate = { x: .03 + offset, y: .03 + offset, w: id.startsWith('metric-') ? .24 : .48, h: id.startsWith('metric-') ? .25 : .4, opacity: .9 };
      const available = place(candidate, next);
      if (available) next[id] = available;
      else setNotice('No free space for this overlay. Shrink or remove another card first.');
    }
    setBoxes(next);
  };
  return { boxes, notice, target, setTarget, pickerTarget, setPickerTarget, update, toggle };
}

function FloatingTelemetry({ id, label, children, controller }) {
  const drag = useRef(null);
  const suppressClick = useRef(false);
  const lastDown = useRef(null);
  const box = controller.boxes[id];
  const start = (event, mode) => {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    suppressClick.current = true;
    event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = controller.target.getBoundingClientRect();
    drag.current = { mode, x: event.clientX, y: event.clientY, bounds, box };
  };
  const move = event => {
    const d = drag.current;
    if (!d || !d.bounds.width || !d.bounds.height) return;
    const dx = (event.clientX - d.x) / d.bounds.width, dy = (event.clientY - d.y) / d.bounds.height;
    controller.update(id, d.mode === 'move'
      ? { x: clamp(d.box.x + dx, 0, 1-d.box.w), y: clamp(d.box.y + dy, 0, 1-d.box.h) }
      : { w: clamp(d.box.w + dx, Math.min(.15, 1-d.box.x), 1-d.box.x), h: clamp(d.box.h + dy, Math.min(.12, 1-d.box.y), 1-d.box.y) });
  };
  const stop = event => { drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); };
  const pointerProps = { onPointerMove: move, onPointerUp: stop, onPointerCancel: stop, onLostPointerCapture: () => { drag.current = null; } };
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
    title="Click to select. + increases transparency; − decreases it. Double-click and hold the second click to drag. Delete removes."
    onKeyDown={keyDown}
    onPointerDown={event => {
      if (event.target.closest('button,input,select,textarea,[role=slider]')) return;
      event.currentTarget.focus({preventScroll:true});
      const previous = lastDown.current;
      lastDown.current = { time: event.timeStamp, x: event.clientX, y: event.clientY };
      if (previous && event.timeStamp-previous.time < 450 && Math.hypot(event.clientX-previous.x, event.clientY-previous.y) < 8) {
        lastDown.current = null;
        start(event, 'move');
      }
    }} {...pointerProps}
    onClickCapture={event => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; } }}
    style={{ left: `${box.x*100}%`, top: `${box.y*100}%`, width: `${box.w*100}%`, height: `${box.h*100}%` }}>
    <div className="video-overlay-content" style={{ opacity: box.opacity }}>{children}</div>
    <button type="button" className="video-overlay-resize" aria-label={`Resize ${label} overlay`} title="Drag to resize; arrow keys also resize"
      onPointerDown={event => start(event, 'resize')} onKeyDown={event => { keyboard(event, 'resize'); event.stopPropagation(); }} {...pointerProps}>◢</button>
  </section>;
}
// Reuse the actual React cards and their callbacks, not screenshots or DOM copies.
export default function VideoTelemetryOverlays({ children, controller, resizable }) {
  if (!controller) return <ResizableVideoTelemetry enabled={resizable}>{children}</ResizableVideoTelemetry>;
  const items = Children.toArray(children.props.children);
  const sections = items.filter(child => isValidElement(child) && child.props['data-sidebar-section']);
  const entries = sections.map(child => ({ id: child.props['data-sidebar-section'][0], label: child.props['data-sidebar-section'][1], child }));
  const metrics = sections.find(child => child.props['data-sidebar-section'][0] === 'metrics');
  if (metrics) Children.toArray(metrics.props.children).filter(isValidElement).forEach(child => {
    if (child.props.label) entries.push({ id: `metric-${child.props.label.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}`, label: child.props.label, child });
  });
  const missing = Object.keys(controller.boxes).filter(id => !entries.some(entry => entry.id === id));
  const picker = <details key="overlay-picker" className="video-overlay-picker">
    <summary><span>＋ Add overlays to video</span><span className="video-overlay-count">{Object.keys(controller.boxes).length} selected ▾</span></summary>
    <div><p className="video-overlay-picker-help">Choose a card or graph to add over the video. Originals stay here. Click a card to select it: + makes it more transparent, − less transparent. Double-click and hold the second click to drag. Drag its corner to resize. Deselect here or press Delete to remove.</p>{entries.map(({id,label}) => <button type="button" key={id} aria-pressed={Boolean(controller.boxes[id])} onClick={() => controller.toggle(id)}>{controller.boxes[id] ? '✓ ' : '＋ '}{label}</button>)}
      {controller.notice && <p role="status">{controller.notice}</p>}{missing.map(id => <button type="button" key={id} aria-pressed="true" onClick={() => controller.toggle(id)}>{id} · no data (remove)</button>)}</div>
  </details>;
  return <><ResizableVideoTelemetry enabled={resizable}>{children}</ResizableVideoTelemetry>
    {controller.pickerTarget && createPortal(picker, controller.pickerTarget)}
    {controller.target && createPortal(entries.filter(entry => controller.boxes[entry.id]).map(({ id, label, child }) =>
      <FloatingTelemetry key={id} id={id} label={label} controller={controller}>{child}</FloatingTelemetry>), controller.target)}
  </>;
}
