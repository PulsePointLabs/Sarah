export const howlClock = value => {
  const seconds = Math.max(0, Number(value) || 0);
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
};
export function flattenHowl(value, prefix = '', out = {}) {
  if (!value || typeof value !== 'object') return out;
  for (const [key, item] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (item && typeof item === 'object') flattenHowl(item, name, out);
    else if (item != null && !/key|token|password|authorization|secret/i.test(name)) out[name] = item;
  }
  return out;
}
export function howlTimeline(rows, offset = 0) {
  return rows.filter(r => r.time_offset_s != null && Number.isFinite(Number(r.time_offset_s)))
    .map(r => {
      const fields = flattenHowl(r.raw || { options:r.options, player:r.player, channels:r.channel_state, frequency_hz:r.frequency_hz });
      const options = r.options || r.raw?.options || {};
      const channels = r.channel_state || {};
      return { ...r, t: Number(r.time_offset_s) - offset, fields,
        powerA: options.power_a ?? channels.a?.intensity ?? null,
        powerB: options.power_b ?? channels.b?.intensity ?? null,
        title: r.script_title || r.player?.title || r.raw?.player?.title || r.activity_name || 'Source not reported' };
    }).sort((a,b)=>a.t-b.t);
}
export function howlAt(rows, t) {
  rows = rows.filter(p => p.connection_state !== "command");
  let lo=0, hi=rows.length;
  while(lo<hi) { const mid=(lo+hi)>>>1; if(rows[mid].t<=t) lo=mid+1; else hi=mid; }
  const p=rows[lo-1];
  return p && !['disconnected','command'].includes(p.connection_state) && t-p.t<=6 ? p : null;
}
// Step paths stop at missing observations. A later reconnect cannot bridge a gap.
export function howlStepPath(rows, key, start, end, max = 200) {
  rows = rows.filter(p => p.connection_state !== 'command');
  const x=t=>30+(t-start)/(end-start)*360, y=v=>78-Number(v)/Math.max(1,max)*65;
  let path='';
  for(let i=0;i<rows.length;i++) {
    const p=rows[i], value=key==='powerA'||key==='powerB'?p[key]:p.fields[key];
    if(['disconnected','command'].includes(p.connection_state)||value==null||typeof value!=='number'||!Number.isFinite(value)) continue;
    const a=Math.max(start,p.t), b=Math.min(end,p.t+6,rows[i+1]?.t ?? p.t+6);
    if(b<=a) continue;
    path+=`M${x(a)},${y(value)}H${x(b)} `;
    const next=rows[i+1], nv=next && (key==='powerA'||key==='powerB'?next[key]:next.fields[key]);
    if(next && next.t===b && !['disconnected','command'].includes(next.connection_state) && typeof nv==='number') path+=`V${y(nv)} `;
  }
  return path;
}
