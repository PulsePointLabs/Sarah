// Acquisition policy: never silently move a user's measured reference.
export const CIVET_ACQUISITION_POLICY = 'pressure-acquisition-4';
export function createCivetReadiness() {
  let hard = null, settling = null, recoveringUntil = -Infinity, shiftSince = null, stableSince = null;
  let lastState = '';
  const clearWindow = () => { shiftSince = stableSince = null; };
  return {
    invalidate(reason = 'Sensor reconnected or zeroed. Repeat rest and hold.') { hard = reason; settling = null; clearWindow(); },
    baseline() { hard = null; settling = null; recoveringUntil = -Infinity; clearWindow(); },
    reference(t) { hard = null; settling = t; clearWindow(); },
    reset() { recoveringUntil = -Infinity; clearWindow(); if(settling != null) { hard = 'Calibration interrupted. Repeat rest and hold.'; settling = null; } },
    step({ t, calibration: c, rows, gap, dt, reconnected, pending, failed }) {
      if (reconnected || (gap && (dt > 2 || dt < 0))) this.invalidate('Connection interrupted. Repeat rest and hold.');
      else if (gap) { recoveringUntil = t + 2; clearWindow(); }
      let state = 'ready', message = 'Reference ready · pressure recording', remaining = 0;
      const tolerance = Math.max(.5, (c?.reference || 0) * .2, (c?.noise || 0) * 8);
      const recent = rows.filter(r => r.t >= t - 3);
      const values = recent.map(r => r.pressure_kpa);
      const enough = recent.length >= 25 && t - recent[0].t >= 2.8;
      const mean = values.reduce((a,b)=>a+b,0)/Math.max(1,values.length);
      const spread = values.length ? Math.max(...values)-Math.min(...values) : Infinity;
      if (pending) { state = 'calibrating'; message = 'Calibration in progress'; }
      else if (failed || hard) { state = 'recalibrate'; message = failed || hard; }
      else if (!c?.reference) { state = 'uncalibrated'; message = c ? 'Rest accepted. Complete the hold.' : 'Calibrate rest and hold for relative intensity.'; }
      else if (gap || t < recoveringUntil) { state = 'recovering'; message = 'Brief signal gap — checking fresh samples'; }
      else if (settling != null) {
        state = 'settling'; message = 'Release and relax — checking resting pressure';
        if (enough && Math.abs(mean-c.baseline) <= tolerance && spread <= Math.max(.25, c.noise*8)) {
          settling = null; state = 'ready'; message = 'Calibration complete · rest, hold and release checked';
        } else if (t - settling >= 30) { hard = 'Resting pressure did not settle near baseline. Repeat rest and hold.'; state = 'recalibrate'; message = hard; }
        remaining = settling == null ? 0 : Math.max(0,30-(t-settling));
      } else {
        const floorRows = rows.filter(r => r.t >= t-8);
        const sorted = floorRows.map(r=>r.pressure_kpa).sort((a,b)=>a-b);
        const floor = sorted[Math.floor((sorted.length-1)*.1)];
        // A comfortable reference hold is not an upper limit. Elevated pressure alone
        // cannot distinguish contraction from placement change and must not revoke it.
        const shifted = floorRows.length >= 65 && floor < c.baseline-tolerance;
        if (shifted) { shiftSince ??= t; stableSince = null; }
        else if (shiftSince != null) { stableSince ??= t; if(t-stableSince>=3)clearWindow(); }
        if (shiftSince != null) { state = t-shiftSince>=10 ? 'recalibrate' : 'checking'; message = state==='checking' ? 'Pressure below resting reference — checking recovery' : 'Pressure remains below resting reference. Check placement; repeat rest and hold if it does not recover.'; }
      }
      const changed = state !== lastState; lastState = state;
      return {state,message,valid:state==='ready',settling:state==='settling',remaining,
        event:changed?{type:'acquisition_status',t,state,message,policy:CIVET_ACQUISITION_POLICY}:null};
    },
  };
}
