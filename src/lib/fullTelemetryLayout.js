export function sidebarLimits(viewportWidth) {
  const available = Math.max(280, Number(viewportWidth) - 32);
  const min = Math.min(400, Math.max(240, available * 0.45));
  const max = Math.max(min, Math.min(760, available * 0.55, available - 320));
  return { min: Math.round(min), max: Math.round(max) };
}
export function sidebarWidth(preferred, viewportWidth) {
  const { min, max } = sidebarLimits(viewportWidth);
  const width = Number(preferred) || viewportWidth * 0.34;
  return Math.round(Math.max(min, Math.min(max, width)));
}
export function isFocusShortcut(event, active) {
  return event.code === "KeyF" && !event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey
    && !active?.isContentEditable && !["INPUT", "TEXTAREA", "SELECT"].includes(active?.tagName);
}
