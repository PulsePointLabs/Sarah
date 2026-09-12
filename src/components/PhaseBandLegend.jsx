import { PHASE_COLORS } from "../lib/videoSyncPhaseEvidence.js";

export default function PhaseBandLegend({ physiologicalLoad = false }) {
  return <div aria-label="Physiology phase colors" className="flex shrink-0 flex-wrap gap-x-2 gap-y-0.5 text-[8px] text-muted-foreground">
    {(physiologicalLoad ? [["baseline", "Low load"], ["build", "Rising load"], ["plateau", "Sustained load"], ["approach", "High load"], ["recovery", "Recovering"]] : [["baseline", "Baseline"], ["build", "Build"], ["plateau", "Plateau"], ["approach", "Climax candidate"], ["recovery", "Release / recovery"]]).map(([key, label]) =>
      <span key={key} className="inline-flex items-center gap-1"><span className="inline-block h-1.5 w-1.5 rounded-sm" style={{ backgroundColor: PHASE_COLORS[key] }} />{label}</span>)}
  </div>;
}
