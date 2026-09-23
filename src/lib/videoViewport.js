export const DEFAULT_VIDEO_VIEW = { zoom: 1, x: 0, y: 0 };
export function changeVideoView(view, key) {
  const zoom = Math.max(1, Math.min(8, view.zoom + (key === '+' ? 0.25 : key === '-' ? -0.25 : 0)));
  if (zoom === 1) return DEFAULT_VIDEO_VIEW;
  const limit = (zoom - 1) * 50;
  const clamp = v => Math.max(-limit, Math.min(limit, v));
  return {zoom, x:clamp(view.x + (key === 'ArrowLeft' ? 5 : key === 'ArrowRight' ? -5 : 0)),
    y:clamp(view.y + (key === 'ArrowUp' ? 5 : key === 'ArrowDown' ? -5 : 0))};
}
