import { useLayoutEffect, useRef, useState } from 'react';

// Fit changing copy inside its reserved slot, without resizing adjacent values.
export default function StableTelemetryText({ children, className = '', enabled = true, center = false }) {
  const slot = useRef(null), text = useRef(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    if (!enabled) return;
    const measure = () => {
      const width = slot.current.clientWidth, height = slot.current.clientHeight;
      if (!width || !height) return;
      setScale(Math.min(1, width / Math.max(1, text.current.scrollWidth), height / Math.max(1, text.current.scrollHeight)));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(slot.current); observer.observe(text.current); measure();
    return () => observer.disconnect();
  }, [children, enabled]);
  return <div ref={slot} className={`${enabled ? 'telemetry-text-slot' : ''} ${className}`}>
    <div ref={text} style={enabled ? { transform: `${center ? 'translateY(-50%) ' : ''}scale(${scale})`, ...(center ? { top: '50%', transformOrigin: 'left center' } : {}) } : undefined}>{children}</div>
  </div>;
}
