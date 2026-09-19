export function telemetryValueChange(rows, key, time, interval = 10) {
  const at = (t) => {
    let low = 0, high = rows.length;
    while (low < high) { const middle = (low + high) >>> 1; if (rows[middle].t <= t) low = middle + 1; else high = middle; }
    for (let i = low - 1; i >= 0 && t - rows[i].t <= 2; i--) {
      const row = rows[i];
      if (row.t > t || row[key] == null || !Number.isFinite(Number(row[key]))) continue;
      return t - row.t <= 2 ? Number(row[key]) : null;
    }
    return null;
  };
  const now = at(time), before = at(time - interval);
  if (now == null || before == null) return null;
  const delta = Math.round((now - before) * 10) / 10;
  return { delta, arrow: delta > 0 ? '↑' : delta < 0 ? '↓' : '→', interval };
}

export function discreteValueChange(readings, keys, time) {
  const valid = readings.map(r => ({ ...r, t: Number(r.time_offset_s ?? r.time_s ?? r.t) }))
    .filter(r => Number.isFinite(r.t) && r.t <= time && keys.every(k => r[k] != null && Number.isFinite(Number(r[k]))))
    .sort((a,b) => b.t-a.t);
  if (valid.length < 2) return null;
  const deltas = keys.map(k => Math.round((Number(valid[0][k])-Number(valid[1][k]))*10)/10);
  return { delta: deltas[0], label: 'prior reading', text: deltas.map(d => `${d > 0 ? '↑ +' : d < 0 ? '↓ ' : '→ '}${d}`).join(' / ') };
}
