// Pressure morphology, not muscle force or a diagnostic orgasm classifier.
export const CIVET_VERSION = 'civet-morphology-2.0.0';
export const CIVET_PARAMETERS = Object.freeze({gap_s:0.18, refractory_s:0.4, prominence_kpa:0.05, noise_multiplier:4, reference_fraction:0.04, train_gap_s:3, tonic_tau_s:3});
export const average = a => a.length ? a.reduce((s,v)=>s+v,0)/a.length : null;
export const quantile = (a,q=.5) => {if(!a.length)return null;const b=[...a].sort((x,y)=>x-y);return b[Math.min(b.length-1,Math.floor((b.length-1)*q))];};
const sd = a => a.length ? Math.sqrt(average(a.map(v=>(v-average(a))**2))) : null;
const unique = a => [...new Set(a)];
export const prominenceThreshold = c => Math.max(.05,(c?.noise||0)*4,(c?.reference||0)*.04);

// Direction-change detector. A falling shoulder confirms a peak; a subsequent rise
// or settled trough closes it. observed peak time and confirmation time are separate.
export function createMorphologyDetector(mode='live') {
  let trough=null,peak=null,fall=null,previous=null,lastPeak=-Infinity,index=0,segment=0,flags=[],flatSince=null;
  const reset=()=>{trough=peak=fall=previous=null;flags=[];flatSince=null;lastPeak=-Infinity;segment++;};
  function finish(at, extra=[]) {
    if(!peak||!fall||!trough)return null;
    const amplitude=peak.filtered_kpa-trough.filtered_kpa;
    const prominence=Math.min(amplitude,peak.filtered_kpa-fall.filtered_kpa);
    const quality=unique([...flags,...extra,...(peak.t-lastPeak<CIVET_PARAMETERS.refractory_s-1e-6?['below_resolvable_separation']:[]),...(peak.calibration_valid?[]:['uncalibrated'])]);
    const rise=peak.t-trough.t,decay=fall.t-peak.t;
    if(rise<.15 || decay<.15)quality.push('under_resolved_or_impulsive');
    const event={event_index:++index,id:`${mode}-${index}`,segment,mode,algorithm:CIVET_VERSION,
      onset:trough.t,peak:peak.t,end:fall.t,trough:fall.t,confirmed_at:at,
      amplitude_kpa:amplitude,prominence_kpa:prominence,raw_amplitude_kpa:peak.pressure_kpa-trough.pressure_kpa,raw_prominence_kpa:peak.pressure_kpa-Math.max(trough.pressure_kpa,fall.pressure_kpa),peak_pressure_kpa:peak.filtered_kpa,raw_peak_pressure_kpa:peak.pressure_kpa,
      duration_s:fall.t-trough.t,rise_s:rise,fall_s:decay,
      tonic_kpa:peak.tonic_kpa,calibration:peak.calibration||null,calibration_valid:!!peak.calibration_valid,
      flags:unique(quality),quality:quality.length?'review':'usable',timing:'observed samples; no interpolation',
      nominal_resolution_s:.1,preceding_interval_s:Number.isFinite(lastPeak)?peak.t-lastPeak:null};
    lastPeak=peak.t;return event;
  }
  return {reset, ingest(row) {
    const out=[];
    if(row.gap || (previous && row.calibration?.id!==previous.calibration?.id)) {
      if(peak&&fall){const e=finish(row.t,['truncated_by_gap_or_calibration']);if(e)out.push(e);}
      reset();lastPeak=-Infinity;
    }
    const value=row.filtered_kpa,h=prominenceThreshold(row.calibration);
    if(!trough)trough=row;
    flags=unique([...flags,...(row.quality_flags||[])]);
    if(!peak) {
      if(value<=trough.filtered_kpa) {trough=row;flags=[...(row.quality_flags||[])];}
      else if(value-trough.filtered_kpa>=h) {peak=row;fall=null;}
    } else if(!fall) {
      if(value>peak.filtered_kpa) {
        if(flatSince!=null&&row.t-flatSince>=.3&&value-peak.filtered_kpa>h*.25){trough=previous;flags=[...(previous.quality_flags||[])];flatSince=null;}
        peak=row;
      }
      if(previous&&Math.abs(value-previous.filtered_kpa)<h*.25)flatSince??=previous.t;
      else if(value<peak.filtered_kpa-h*.25)flatSince=null;
      if(peak.filtered_kpa-value>=h)fall=row;
    } else {
      if(value<fall.filtered_kpa-1e-9)fall=row;
      const turning=value-fall.filtered_kpa>=h;
      const settled=row.t-fall.t>=.3-1e-6 && Math.abs(value-fall.filtered_kpa)<h*.5;
      if(turning || settled) {
        const e=finish(row.t);if(e)out.push(e);
        trough=fall;peak=turning?row:null;fall=null;flags=[...(row.quality_flags||[])];
      }
    }
    previous=row;return out;
  }, finish(t) {const e=finish(t,['incomplete_at_segment_end']);reset();return e?[e]:[];} };
}

export function summarizeTrains(events,rows=[]) {
  const groups=[];let group=[];
  for(const e of events) {
    const p=group.at(-1);
    if(p && (e.segment!==p.segment || e.peak-p.peak>3 || e.peak-p.peak<.4-1e-6)) {groups.push(group);group=[];}
    group.push(e);
  }
  groups.push(group);
  const tonic=(a,b)=>average(rows.filter(r=>r.t>=a&&r.t<=b&&!r.gap).map(r=>r.tonic_kpa).filter(Number.isFinite));
  return groups.filter(g=>g.length>=3).map((g,i)=>{
    const peaks=g.map(e=>e.peak), intervals=peaks.slice(1).map((t,j)=>t-peaks[j]);
    const amplitudes=g.map(e=>e.amplitude_kpa),prominences=g.map(e=>e.prominence_kpa),x=peaks.map(t=>t-peaks[0]),xm=average(x),ym=average(amplitudes);
    const slope=amplitudes.reduce((s,y,j)=>s+(x[j]-xm)*(y-ym),0)/x.reduce((s,v)=>s+(v-xm)**2,0);
    const start=g[0].onset,end=g.at(-1).end,flags=unique(g.flatMap(e=>e.flags));
    return {train_index:i+1,mode:g[0].mode,algorithm:CIVET_VERSION,event_ids:g.map(e=>e.id),count:g.length,
      first_contraction_s:peaks[0],last_contraction_s:peaks.at(-1),start,end,duration_s:end-start,peak_times_s:peaks,
      intervals_s:intervals,mean_interval_s:average(intervals),median_interval_s:quantile(intervals),interval_sd_s:sd(intervals),interval_cv:sd(intervals)/average(intervals),
      amplitudes_kpa:amplitudes,prominences_kpa:prominences,mean_amplitude_kpa:ym,median_amplitude_kpa:quantile(amplitudes),max_amplitude_kpa:Math.max(...amplitudes),
      mean_prominence_kpa:average(prominences),median_prominence_kpa:quantile(prominences),max_prominence_kpa:Math.max(...prominences),amplitude_slope_kpa_s:slope,
      durations_s:g.map(e=>e.duration_s),rise_times_s:g.map(e=>e.rise_s),fall_times_s:g.map(e=>e.fall_s),
      mean_duration_s:average(g.map(e=>e.duration_s)),mean_rise_s:average(g.map(e=>e.rise_s)),mean_fall_s:average(g.map(e=>e.fall_s)),
      tonic_before_kpa:tonic(start-2,start),tonic_during_kpa:tonic(start,end),tonic_after_kpa:tonic(end,end+2),flags,quality:flags.length?'review':'usable'};
  });
}
export function linkIntervals(events) {
  return events.map((e,i)=>({...e,following_interval_s:events[i+1]?.segment===e.segment?events[i+1].peak-e.peak:null}));
}

// Offline smoothing is symmetric (zero phase), restricted to continuous calibration
// segments. It never overwrites recorded live features or fills missing samples.
export function analyzeCivetReview(rawRows) {
  const rows=[],events=[],detector=createMorphologyDetector('review');
  let segment=[];
  function flush() {
    if(!segment.length)return;
    detector.reset();
    for(let i=0;i<segment.length;i++) {
      const r=segment[i],neighbors=segment.slice(Math.max(0,i-1),i+2);
      const filtered=neighbors.reduce((s,p)=>s+p.pressure_kpa*(p===r?2:1),0)/neighbors.reduce((s,p)=>s+(p===r?2:1),0);
      const near=segment.slice(Math.max(0,i-25),i+26).filter(p=>Math.abs(p.t-r.t)<=2.5);
      const tonic=quantile(near.map(p=>p.pressure_kpa),.2);
      const flags=[...(r.quality_flags||[])];
      const c=r.calibration, before=segment[i-1], after=segment[i+1], jump=Math.max(.4,(c?.reference||1)*.6);
      if(before&&Math.abs(r.pressure_kpa-before.pressure_kpa)>jump)flags.push('abrupt_pressure_change');
      if(before&&after&&Math.abs(r.pressure_kpa-before.pressure_kpa)>jump&&Math.abs(r.pressure_kpa-after.pressure_kpa)>jump)flags.push('impulsive_pressure_change');
      // Elevated tonic pressure is not evidence that a comfortable reference failed.
      const shifted=c&&tonic < c.baseline-Math.max(.5,(c.reference||0)*.2,(c.noise||0)*8);
      if(shifted)flags.push('baseline_drift_or_tonic_shift');
      if(i===0||i===segment.length-1)flags.push('filter_edge');
      const row={...r,events:[],rhythm:null,duration_s:null,contraction_count:null,contractions_60s:null,mean_duration_s:null,filtered_kpa:filtered,tonic_kpa:tonic,phasic_kpa:filtered-tonic,
        usable:!shifted&&(r.usable??false),level_pct:shifted?null:(r.level_pct??null),evidence:shifted?'Review: tonic shift; normalized comparison withheld':(r.evidence??null),quality_flags:unique(flags),calibration_valid:!shifted&&(r.calibration_valid??r.usable??false),mode:'review',algorithm:CIVET_VERSION};
      rows.push(row);events.push(...detector.ingest(row));
    }
    events.push(...detector.finish(segment.at(-1).t));segment=[];
  }
  for(const row of rawRows) {
    const p=segment.at(-1);
    if(p&&(row.t-p.t>.18||row.t<=p.t||row.gap||(row.calibration?.id??row.calibration?.at)!==(p.calibration?.id??p.calibration?.at))){flush();segment.push({...row,gap:row.gap||row.t-p.t>.18||row.t<=p.t,gap_s:row.t-p.t});}
    else segment.push(row);
  }
  flush();const linked=linkIntervals(events);
  return {algorithm:CIVET_VERSION,mode:'review',parameters:CIVET_PARAMETERS,rows,events:linked,trains:summarizeTrains(linked,rows)};
}
