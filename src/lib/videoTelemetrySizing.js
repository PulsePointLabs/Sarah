export const telemetryMinimum = id => ({ metrics: 180, 'civet-status': 80 })[id] ?? 210;
export const telemetryMaximum = id => id === 'metrics' ? 400 : 700;

// Borrow space from peers down to readable floors. If those floors cannot fit,
// allow scrolling instead of tiny type. Hidden cards do not donate blank space.
export function fitTelemetryHeights(ids, available, preferred = {}, locked) {
  if (!ids.length) return {};
  const budget = Math.max(0, available);
  const initial = Math.min(260, Math.max(0, (budget - (ids.includes('metrics') ? 80 : 0)) / Math.max(1, ids.filter(id => id !== 'metrics').length)));
  const sizes = Object.fromEntries(ids.map(id => {
    const value = Number(preferred[id]);
    return [id, Math.max(telemetryMinimum(id), Math.min(telemetryMaximum(id), Number.isFinite(value) ? value : id === 'metrics' ? 80 : initial))];
  }));
  let excess = ids.reduce((sum, id) => sum + sizes[id], 0) - budget;
  const donors = ids.filter(id => id !== locked);
  const capacity = donors.reduce((sum, id) => sum + sizes[id] - telemetryMinimum(id), 0);
  if (excess > 0 && capacity > 0) {
    const take = Math.min(excess, capacity);
    donors.forEach(id => { sizes[id] -= take * (sizes[id] - telemetryMinimum(id)) / capacity; });
    excess -= take;
  }
  // When there is no readable fit, retain the floors and let the sidebar scroll.
  return sizes;
}
