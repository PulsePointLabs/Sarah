import { Children, cloneElement, isValidElement, useLayoutEffect, useRef, useState } from 'react';
import './resizableVideoTelemetry.css';

const STORAGE = 'sarah.videoSync.sectionWeights.v4';
const VISIBILITY = 'sarah.videoSync.sectionVisibility.v1';
const minimumFor = () => 260;
const initialHeight = 300;

function FittedSidebar({ children }) {
  const ref = useRef(null), drag = useRef(null);
  const [available, setAvailable] = useState(900);
  const [weights, setWeights] = useState(() => { try { return JSON.parse(localStorage.getItem(STORAGE) || '{}'); } catch { return {}; } });
  const [hidden, setHidden] = useState(() => { try { return JSON.parse(localStorage.getItem(VISIBILITY) || '{}'); } catch { return {}; } });
  const items = Children.toArray(children.props.children);
  const sections = items.filter(child => isValidElement(child) && child.props['data-sidebar-section']);
  const ids = sections.map(child => child.props['data-sidebar-section'][0]).filter(id => !hidden[id]);
  const minimumTotal = ids.reduce((sum, id) => sum + minimumFor(id), 0);
  const floorFor = minimumFor;
  useLayoutEffect(() => {
    const element = ref.current;
    const measure = () => {
      const style = getComputedStyle(element);
      const fixed = [...element.children].filter(node => !node.dataset.videoSection);
      const fixedHeight = fixed.reduce((sum, node) => sum + node.getBoundingClientRect().height, 0);
      const gap = parseFloat(style.rowGap) || 0;
      setAvailable(Math.max(0, element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - fixedHeight - gap * (fixed.length + ids.length - 1)));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    [...element.children].filter(node => !node.dataset.videoSection).forEach(node => observer.observe(node));
    measure(); return () => observer.disconnect();
  }, [ids.join('|')]);
  // Scroll instead of shrinking graphs below a readable height.
  // Hidden cards donate space, with a cap on expansion in a scrolling sidebar.
  const canvasHeight = Math.max(available, Math.min(sections.length * initialHeight, ids.length * 480));
  const extra = Math.max(0, canvasHeight - minimumTotal);
  const totalWeight = ids.reduce((sum, id) => sum + Math.max(0.001, Number.isFinite(Number(weights[id])) ? Number(weights[id]) : 1), 0);
  const sizes = Object.fromEntries(ids.map(id => [id, floorFor(id) + extra * Math.max(0.001, Number.isFinite(Number(weights[id])) ? Number(weights[id]) : 1) / totalWeight]));
  const resize = (id, value) => {
    if (extra < 1) return;
    const targetExtra = Math.max(0, Math.min(extra, value - floorFor(id)));
    const others = ids.filter(key => key !== id);
    const previousExtra = others.reduce((sum, key) => sum + sizes[key] - floorFor(key), 0);
    const next = Object.fromEntries(ids.map(key => [key, key === id ? targetExtra : (extra - targetExtra) * (previousExtra > 0 ? (sizes[key] - floorFor(key)) / previousExtra : 1 / others.length)]));
    setWeights(next);
    try { localStorage.setItem(STORAGE, JSON.stringify(next)); } catch {}
  };
  return cloneElement(children, { ref, className: `${children.props.className} video-resizable-sidebar` },
    <div key="card-toggles" className="video-card-toggles" aria-label="Sidebar cards">
      <span>Cards</span>{sections.map(child => { const [id, label] = child.props['data-sidebar-section']; return <button key={id} type="button" aria-pressed={!hidden[id]} onClick={() => {
        const next = { ...hidden, [id]: !hidden[id] }; setHidden(next);
        try { localStorage.setItem(VISIBILITY, JSON.stringify(next)); } catch {}
      }}>{label}</button>; })}
    </div>,
    items.map(child => {
      if (!isValidElement(child) || !child.props['data-sidebar-section']) return child;
      const [id, label] = child.props['data-sidebar-section'];
      if (hidden[id]) return null;
      const size = sizes[id];
      return <div key={id} data-video-section={id} className="video-resizable-section" style={{ height: size,
        '--section-font': `${Math.min(15, 11 + Math.max(0, size - minimumFor(id)) / 90)}px`,
        '--section-value': `${Math.min(40, 22 + Math.max(0, size - minimumFor(id)) / 12)}px` }}>
        <div className="video-resizable-content">{child}</div>
        <div role="separator" tabIndex={0} aria-label={`Resize ${label} height`} aria-orientation="horizontal" aria-valuemin={Math.round(floorFor(id))} aria-valuemax={Math.round(floorFor(id) + extra)} aria-valuenow={Math.round(size)}
          title="Drag to redistribute space; Up/Down adjust height; Home resets to minimum" className="video-section-handle"
          onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); drag.current = { y: event.clientY, height: size }; event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={event => { if (drag.current) resize(id, drag.current.height + event.clientY - drag.current.y); }}
          onPointerUp={event => { drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
          onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
          onKeyDown={event => { if (!['ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return; event.preventDefault(); event.stopPropagation(); resize(id, event.key === 'Home' ? floorFor(id) : size + (event.key === 'ArrowUp' ? -12 : 12)); }}><span aria-hidden="true">•••</span></div>
      </div>;
    }));
}
export default function ResizableVideoTelemetry({ enabled, children }) {
  return enabled ? <FittedSidebar>{children}</FittedSidebar> : children;
}
