import { Children, cloneElement, isValidElement, useLayoutEffect, useRef, useState } from 'react';
import { fitTelemetryHeights, telemetryMinimum, telemetryMaximum } from '../lib/videoTelemetrySizing.js';
import './resizableVideoTelemetry.css';

const STORAGE = 'sarah.videoSync.sectionHeights.v5';
const VISIBILITY = 'sarah.videoSync.sectionVisibility.v1';
function saved(key) {
  try { const value = JSON.parse(localStorage.getItem(key) || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
}
function persist(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }

function FittedSidebar({ children }) {
  const ref = useRef(null), drag = useRef(null), defaultCardCount = useRef(0);
  const [available, setAvailable] = useState(0);
  const [heights, setHeights] = useState(() => saved(STORAGE));
  const [hidden, setHidden] = useState(() => saved(VISIBILITY));
  const items = Children.toArray(children.props.children);
  const sections = items.filter(child => isValidElement(child) && child.props['data-sidebar-section']);
  const allIds = sections.map(child => child.props['data-sidebar-section'][0]);
  defaultCardCount.current = Math.max(defaultCardCount.current, allIds.length);
  const ids = allIds.filter(id => !hidden[id]);
  useLayoutEffect(() => {
    const element = ref.current;
    const measure = () => {
      const style = getComputedStyle(element);
      const fixed = [...element.children].filter(node => !node.dataset.videoSection);
      const fixedHeight = fixed.reduce((sum, node) => sum + node.getBoundingClientRect().height, 0);
      const gap = parseFloat(style.rowGap) || 0;
      setAvailable(Math.max(0, element.clientHeight - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0) - fixedHeight - gap * Math.max(0, fixed.length + ids.length - 1)));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    [...element.children].filter(node => !node.dataset.videoSection).forEach(node => observer.observe(node));
    measure(); return () => observer.disconnect();
  }, [ids.join('|')]);
  // Use all cards for defaults: hiding a card leaves space below, not inflation.
  // Ignore old scrolling/weight preferences, while retaining card visibility.
  const defaultIds = [...allIds, ...Array.from({length:defaultCardCount.current-allIds.length}, (_, index) => `reserved-${index}`)];
  const defaults = fitTelemetryHeights(defaultIds, available);
  const sizes = fitTelemetryHeights(ids, available, Object.fromEntries(ids.map(id => [id, heights[id] ?? defaults[id]])));
  const resize = (id, value) => {
    const maximum = Math.min(telemetryMaximum(id), available - ids.filter(key => key !== id).reduce((sum, key) => sum + telemetryMinimum(key), 0));
    const target = Math.max(telemetryMinimum(id), Math.min(maximum, value));
    const next = fitTelemetryHeights(ids, available, { ...sizes, [id]: target }, id);
    setHeights(previous => { const result = { ...previous, ...next }; persist(STORAGE, result); return result; });
  };
  return cloneElement(children, { ref, className: `${children.props.className} video-resizable-sidebar` },
    <details key="card-toggles" className="video-card-picker">
      <summary aria-label="Sidebar cards">Cards <span>{ids.length} / {allIds.length}</span></summary>
      <div className="video-card-menu" role="group" aria-label="Visible sidebar cards">
        {sections.map(child => { const [id, label] = child.props['data-sidebar-section']; return <label key={id}>
          <input type="checkbox" checked={!hidden[id]} onChange={() => { const next = { ...hidden, [id]: !hidden[id] }; setHidden(next); persist(VISIBILITY, next); }} />{label}
        </label>; })}
      </div>
    </details>,
    items.map(child => {
      if (!isValidElement(child) || !child.props['data-sidebar-section']) return child;
      const [id, label] = child.props['data-sidebar-section'];
      if (hidden[id]) return null;
      const size = sizes[id];
      const maximum = Math.max(telemetryMinimum(id), Math.min(telemetryMaximum(id), available - ids.filter(key => key !== id).reduce((sum, key) => sum + telemetryMinimum(key), 0)));
      return <div key={id} data-video-section={id} className="video-resizable-section" style={{ height: size,
        '--section-font': `${Math.min(14, 10 + Math.max(0, size - 140) / 65)}px`,
        '--section-value': `${Math.min(72, 24 + Math.max(0, size - 76) * .38)}px` }}>
        <div className="video-resizable-content">{child}</div>
        <div role="separator" tabIndex={0} aria-label={`Resize ${label} height`} aria-orientation="horizontal" aria-valuemin={telemetryMinimum(id)} aria-valuemax={Math.round(maximum)} aria-valuenow={Math.round(size)}
          title="Drag to resize; Up/Down adjust height; Home resets the card" className="video-section-handle"
          onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); drag.current = { y: event.clientY, height: size }; event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={event => { if (drag.current) resize(id, drag.current.height + event.clientY - drag.current.y); }}
          onPointerUp={event => { drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
          onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
          onKeyDown={event => { if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); event.stopPropagation(); resize(id, event.key === 'Home' ? defaults[id] : event.key === 'End' ? maximum : size + (event.key === 'ArrowUp' ? -12 : 12)); }}><span aria-hidden="true">•••</span></div>
      </div>;
    }));
}
function DashboardTelemetry({ children }) {
  const items = Children.toArray(children.props.children);
  return cloneElement(children, { className: `${children.props.className} monitor-card-grid` }, items.map(child => {
    if (!isValidElement(child) || !child.props['data-sidebar-section']) return child;
    const [id] = child.props['data-sidebar-section'];
    return <div key={id} className="monitor-section" data-monitor-section={id}><div className="monitor-section-content">{child}</div></div>;
  }));
}
export default function ResizableVideoTelemetry({ enabled, dashboard = false, children }) {
  if (dashboard) return <DashboardTelemetry>{children}</DashboardTelemetry>;
  return enabled ? <FittedSidebar>{children}</FittedSidebar> : children;
}
