// Causal pressure features. Pressure is mechanical response, not calibrated muscle force.
export const CIVET_ALGORITHM = 'civet-pressure-v1';
const mean = values => values.length ? values.reduce((a,b) => a+b,0)/values.length : 0;
const clamp = (n,a,b) => Math.max(a,Math.min(b,n));
export function createCivetProcessor() {
  let calibration = null, pending = null, window = [], events = [], active = null, last = null, count = 0, sessionMax = 0;
  return {
    reset() { window=[]; events=[]; active=null; last=null; count=0; sessionMax=0; },
    calibrate(kind) { if (!['baseline','reference'].includes(kind)) throw new Error('Unknown calibration'); if (kind==='reference' && !calibration) throw new Error('Capture relaxed baseline first.'); pending={kind, samples:[], start:null}; },
    ingest(pressure, t) {
      if (!Number.isFinite(pressure) || !Number.isFinite(t)) throw new Error('Invalid pressure sample');
      const gap = last != null && (t-last > 0.6 || t<=last);
      if (gap) { active=null; window=[]; events=[]; }
      last=t;
      let calibrationError=null;
      if (pending) {
        pending.start ??=t; pending.samples.push(pressure); pending.invalid ||= gap;
        if (t-pending.start>=5) {
          const samples=pending.samples;
          if(samples.length<35 || pending.invalid) calibrationError='Too many missing samples; repeat calibration.';
          else if(pending.kind==='baseline') {
            const baseline=mean(samples), noise=Math.sqrt(mean(samples.map(v=>(v-baseline)**2)));
            calibration={baseline,noise,reference:null,at:t}; active=null; events=[]; window=[];
          } else {
            const sorted=[...samples].sort((a,b)=>a-b), reference=sorted[Math.floor(sorted.length*.95)]-calibration.baseline;
            if(reference<Math.max(.1,calibration.noise*6)) calibrationError='Reference is too small or noisy. Repeat baseline and contraction reference.';
            else calibration={...calibration,reference,at:t};
          }
          pending=null;
        }
      }
      const delta=calibration ? pressure-calibration.baseline : null;
      const threshold=calibration ? Math.max(.05,calibration.noise*4,(calibration.reference||0)*.15) : Infinity;
      const calibrated=Boolean(calibration?.reference);
      const usable=calibrated && !pending && !gap && delta>=-Math.max(.2,calibration.noise*6);
      if(!usable) active=null;
      if(usable && delta>=threshold && !active) active={start:t,peak:delta};
      if(active) {
        active.peak=Math.max(active.peak,delta);
        if(delta<threshold*.5) {
          const duration=t-active.start;
          if(duration>=.2 && duration<=20) { events.push({t, duration,peak:active.peak}); count++; }
          active=null;
        }
      }
      window.push({t,delta,usable}); window=window.filter(p=>t-p.t<=30);
      events=events.filter(p=>t-p.t<=60);
      const valid=window.filter(p=>p.usable), values=valid.map(p=>Math.max(0,p.delta));
      if(usable) sessionMax=Math.max(sessionMax,delta);
      const recent=events.filter(p=>t-p.t<=10), intervals=recent.slice(1).map((p,i)=>p.t-recent[i].t);
      const averageInterval=mean(intervals), cv=averageInterval ? Math.sqrt(mean(intervals.map(v=>(v-averageInterval)**2)))/averageInterval : null;
      const rhythm=usable && recent.length>=3 && cv!=null && cv<.35;
      const held=active ? t-active.start : 0;
      const evidence=usable ? rhythm ? 'rhythmic contractions' : held>=3 ? 'sustained contraction' : active ? 'contraction' : 'relaxed' : pending ? `calibrating ${pending.kind}` : calibrationError ? 'calibration failed' : calibrated ? 'check placement' : 'calibration needed';
      return {t,pressure_kpa:pressure,delta_kpa:delta,level_pct:usable?clamp(delta/calibration.reference*100,0,150):null,
        avg_kpa:values.length?mean(values):null,max_kpa:values.length?Math.max(...values):null,session_max_kpa:sessionMax,
        contractions_60s:events.length,contraction_count:count,duration_s:held,mean_duration_s:events.length?mean(events.map(p=>p.duration)):null,
        rhythm, evidence, usable, gap,calibration,calibration_error:calibrationError,calibration_remaining_s:pending?Math.max(0,5-(t-pending.start)):0,algorithm:CIVET_ALGORITHM};
    },
  };
}
export function civetEvidence(sample) {
  if(!sample?.usable) return { contribution:0,label:null };
  return { contribution:sample.rhythm?8:sample.duration_s>=3?4:0, label:sample.rhythm?'CIVET rhythmic contraction pattern':sample.duration_s>=3?'CIVET sustained contraction':null };
}
export function civetAt(rows,t) {
  let lo=0,hi=rows.length-1,found=null;
  while(lo<=hi) { const mid=(lo+hi)>>1; if(rows[mid].t<=t) {found=rows[mid];lo=mid+1;} else hi=mid-1; }
  return found && t-found.t<=.6 ? found : null;
}
export function withCivetEvidence(base, sample, emgLevel=0) {
  const evidence=civetEvidence(sample);
  // Shared mechanical/muscular budget: do not stack CIVET atop the same EMG event.
  const addition=base.buildEligibleForNearClimax && base.recovery<45 ? Math.max(0,evidence.contribution-Math.min(8,Math.max(0,emgLevel)*.16)) : 0;
  return {...base,nearClimax:Math.min(100,base.nearClimax+addition),civetContribution:addition,civetEvidence:evidence.label,
    reason:[base.reason,evidence.label].filter(Boolean).join(' · ')};
}
