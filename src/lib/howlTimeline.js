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

const numeric = value => value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
export const HOWL_GRAPH_GROUPS = [
  { key:'power', label:'Power', unit:'level', lines:[['powerA','Channel A','#14b8a6'],['powerB','Channel B','#a855f7']] },
  { key:'frequency', label:'Frequency', unit:'Hz', lines:[['frequencyA','Channel A','#14b8a6'],['frequencyB','Channel B','#a855f7'],['frequency','Frequency','#f59e0b']] },
  { key:'pulseWidth', label:'Pulse width', unit:'µs', lines:[['pulseWidth','Pulse width','#38bdf8']] },
];
export function howlGraphData(points) {
  const observations = points.filter(p=>p.connection_state!=='command');
  const data=[];
  for(let i=0;i<observations.length;i++) {
    const p=observations[i], f=p.fields;
    const known=p.connection_state!=='disconnected';
    const pick=(...values)=>known ? values.map(numeric).find(v=>v!=null) ?? null : null;
    const row={t:p.t,
      powerA:pick(p.powerA),powerB:pick(p.powerB),
      frequencyA:pick(p.channel_state?.a?.frequency_hz,f['channels.a.frequency_hz'],f['channels.a.frequencyHz']),
      frequencyB:pick(p.channel_state?.b?.frequency_hz,f['channels.b.frequency_hz'],f['channels.b.frequencyHz']),
      frequency:pick(p.frequency_hz,f.frequency_hz,f['options.frequency_hz'],f['options.frequencyHz']),
      pulseWidth:pick(p.pulse_width_us,f.pulse_width_us,f['options.pulse_width_us'])};
    data.push(row);
    const next=observations[i+1];
    if(known && (!next || next.t>p.t+6)) {
      data.push({...row,t:p.t+6});
      data.push({t:p.t+6.001,powerA:null,powerB:null,frequencyA:null,frequencyB:null,frequency:null,pulseWidth:null});
    }
  }
  return data;
}
export function howlFieldLabel(key) {
  return key.replace(/^(command|options|player)\./,'').replace(/channels\.([ab])\./i,(_,side)=>`Channel ${side.toUpperCase()} `)
    .replace(/_/g,' ').replace(/\b(a|b)\b/g,side=>side.toUpperCase())
    .replace(/\bhz\b/gi,'Hz').replace(/\bus\b/g,'µs').replace(/^./,c=>c.toUpperCase());
}
export function howlChangeSummary(point) {
  if(point.connection_state==='disconnected') return 'Connection lost';
  const c=point.raw?.command;
  if(c) {
    const action=String(c.action||'').replace(/_/g,' ');
    const parts=[];
    if(c.activity_display_name || c.activity_name) parts.push(c.activity_display_name || c.activity_name);
    if(numeric(c.intensity_a)!=null) parts.push(`A ${c.intensity_a}`);
    if(numeric(c.intensity_b)!=null) parts.push(`B ${c.intensity_b}`);
    if(!parts.length && numeric(c.intensity)!=null) parts.push(`${String(c.channel||'').toUpperCase()} ${c.intensity}`.trim());
    return [action,...parts].filter(Boolean).join(' · ') || 'Saved control';
  }
  return [point.title,point.powerA!=null?`A ${point.powerA}`:null,point.powerB!=null?`B ${point.powerB}`:null,
    point.mute?'Muted':null,point.player?.playing===false?'Stopped':null].filter(Boolean).join(' · ');
}
