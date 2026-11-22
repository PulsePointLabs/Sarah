export function videoEventContext(rows, time) {
  const at=Number(time);
  if(!Number.isFinite(at))return [];
  const row=rows.filter(r=>Number.isFinite(Number(r.time_offset_s))&&Number(r.time_offset_s)<=at)
    .reduce((best,r)=>!best||Number(r.time_offset_s)>Number(best.time_offset_s)?r:best,null);
  if(!row||at-Number(row.time_offset_s)>5)return [];
  const number=value=>value!=null&&value!==''&&Number.isFinite(Number(value))?Number(value):null;
  const hr=number(row.hr),baseline=number(row.baseline_hr),rmssd=number(row.hrv_rmssd_ms),sdnn=number(row.hrv_sdnn_ms);
  return [hr!=null&&['HR',`${Math.round(hr)} bpm`],hr!=null&&baseline!=null&&['Δ baseline',`${hr-baseline>=0?'+':''}${Math.round(hr-baseline)} bpm`],rmssd!=null&&['RMSSD',`${rmssd.toFixed(1)} ms`],sdnn!=null&&['SDNN',`${sdnn.toFixed(1)} ms`]].filter(Boolean);
}
