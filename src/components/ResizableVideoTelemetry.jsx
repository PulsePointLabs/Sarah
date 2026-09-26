import { Children, cloneElement, isValidElement, useLayoutEffect, useRef, useState } from 'react';
import './resizableVideoTelemetry.css';

const STORAGE = 'sarah.videoSync.sectionHeights.v1';
function Section({ id, label, children }) {
  const ref = useRef(null), drag = useRef(null);
  const [width, setWidth] = useState(440);
  const [height, setHeight] = useState(() => { try { return Number(JSON.parse(localStorage.getItem(STORAGE) || '{}')[id]) || 0; } catch { return 0; } });
  const [actualHeight, setActualHeight] = useState(0);
  const count = id === 'metrics' ? Children.toArray(children.props.children).length : 0;
  const minimum = id === 'metrics' ? Math.ceil(count / Math.max(1, Math.floor((width - 16) / 180))) * 146 + 28 : id === 'phase' ? 360 : 280;
  const size = Math.max(minimum, Math.min(1200, height || minimum));
  useLayoutEffect(() => {
    const observer = new ResizeObserver(([entry]) => { setWidth(entry.contentRect.width); setActualHeight(entry.contentRect.height); });
    observer.observe(ref.current); return () => observer.disconnect();
  }, []);
  const resize = value => {
    const next = Math.max(minimum, Math.min(Math.max(1200, minimum), value)); setHeight(next);
    try { const all = JSON.parse(localStorage.getItem(STORAGE) || '{}'); localStorage.setItem(STORAGE, JSON.stringify({ ...all, [id]: next })); } catch {}
  };
  return <div ref={ref} data-video-section={id} className="video-resizable-section" style={{ height: size, minHeight: minimum,
    '--section-font': `${Math.min(18, 12 + Math.max(0, actualHeight - minimum) / 65)}px`,
    '--section-value': `${Math.min(52, 26 + Math.max(0, actualHeight - minimum) / 16)}px` }}>
    <div className="video-resizable-content">{children}</div>
    <div role="separator" tabIndex={0} aria-label={`Resize ${label} height`} aria-orientation="horizontal" aria-valuemin={minimum} aria-valuemax={Math.max(1200, minimum)} aria-valuenow={Math.round(actualHeight || size)}
      title="Drag to resize; Up/Down adjust height; Home resets to readable minimum"
      className="video-section-handle"
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); drag.current = { y: event.clientY, height: ref.current.getBoundingClientRect().height }; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { if (drag.current) resize(drag.current.height + event.clientY - drag.current.y); }}
      onPointerUp={event => { drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
      onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
      onKeyDown={event => { if (!['ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return; event.preventDefault(); event.stopPropagation(); resize(event.key === 'Home' ? minimum : size + (event.key === 'ArrowUp' ? -24 : 24)); }}>
      <span aria-hidden="true">•••</span><span className="sr-only">{label}</span>
    </div>
  </div>;
}

export default function ResizableVideoTelemetry({ enabled, children }) {
  if (!enabled) return children;
  return cloneElement(children, { className: `${children.props.className} video-resizable-sidebar` }, Children.map(children.props.children, child => {
    if (!isValidElement(child) || !child.props['data-sidebar-section']) return child;
    const [id, label] = child.props['data-sidebar-section'];
    return <Section key={id} id={id} label={label}>{child}</Section>;
  }));
}
