export const telemetryMinimum = id => ({ metrics: 64, 'civet-status': 64 })[id] ?? 96;
export const telemetryMaximum = id => id === 'metrics' ? 240 : 360;

// Resize within the viewport, stopping at content floors rather than creating
// a taller scroll canvas. Hidden cards never donate blank space automatically.
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
  if (excess > .01) {
    const total = ids.reduce((sum, id) => sum + sizes[id], 0);
    ids.forEach(id => { sizes[id] *= budget / total; });
  }
  return sizes;
}
