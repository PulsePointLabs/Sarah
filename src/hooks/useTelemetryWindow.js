import { useCallback, useEffect, useState } from 'react';

export function useTelemetryWindow() {
  const [target, setTarget] = useState(null);
  const open = useCallback(() => {
    if (target && !target.closed) { target.focus(); return true; }
    const popup = window.open('about:blank', 'SarahTelemetry', 'popup=yes,width=1280,height=900');
    if (!popup) return false;
    popup.document.title = 'Sarah — Telemetry monitor';
    popup.document.documentElement.className = document.documentElement.className;
    popup.document.body.className = 'dark';
    popup.document.body.style.margin = '0';
    for (const node of document.querySelectorAll('link[rel="stylesheet"], style')) {
      const copy = node.cloneNode(true);
      if (node.tagName === 'LINK') copy.href = node.href;
      popup.document.head.appendChild(copy);
    }
    setTarget(popup);
    return true;
  }, [target]);
  const close = useCallback(() => { target?.close(); setTarget(null); }, [target]);
  useEffect(() => {
    if (!target) return;
    const timer = window.setInterval(() => { if (target.closed) setTarget(null); }, 400);
    const parentClosing = () => target.close();
    window.addEventListener('beforeunload', parentClosing);
    return () => { clearInterval(timer); window.removeEventListener('beforeunload', parentClosing); target.close(); };
  }, [target]);
  return { target, open, close };
}
