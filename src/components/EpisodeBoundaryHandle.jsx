import { useRef } from "react";
import { episodeBoundaryTime } from "../lib/subjectiveNearClimax.js";
import { episodeClock } from "../lib/episodeReviewContext.js";

export default function EpisodeBoundaryHandle({ x1, y1, y2, stroke, episode, boundary, domain, onPreview, onCommit, onStart }) {
  const drag = useRef(null);
  const label = `${episode.kind === "climax" ? "Climax" : "Near climax"} ${boundary === "start_s" ? "start" : "end"}`;
  const move = (event) => {
    const state = drag.current;
    if (!state) return null;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(state.matrix);
    const time = episodeBoundaryTime(episode, boundary, Math.max(domain[0], Math.min(domain[1], state.time + (point.x - state.x) / state.width * (domain[1] - domain[0]))));
    onPreview({ id: episode.id, boundary, time });
    return time;
  };
  return <g role="slider" tabIndex={0} aria-label={label} aria-valuenow={episode[boundary]}
    aria-valuetext={episodeClock(episode[boundary])} style={{ cursor: "ew-resize", touchAction: "none" }}
    onClick={(event) => event.stopPropagation()}
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      const svg = event.currentTarget.ownerSVGElement;
      const matrix = svg.getScreenCTM()?.inverse();
      const width = svg.querySelector(".recharts-cartesian-grid")?.getBBox().width;
      if (!matrix || !width) return;
      drag.current = { matrix, width, x: new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix).x, time: episode[boundary] };
      event.currentTarget.setPointerCapture(event.pointerId);
      onStart?.();
    }}
    onPointerMove={(event) => { if (drag.current) { event.stopPropagation(); move(event); } }}
    onPointerUp={(event) => {
      if (!drag.current) return;
      event.stopPropagation(); const time = move(event); drag.current = null;
      onPreview(null); onCommit(episode.id, boundary, time);
      event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onPointerCancel={() => { drag.current = null; onPreview(null); }}
    onLostPointerCapture={() => { if (drag.current) { drag.current = null; onPreview(null); } }}
    onKeyDown={(event) => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation(); onStart?.();
      onCommit(episode.id, boundary, episodeBoundaryTime(episode, boundary, Math.max(domain[0], Math.min(domain[1], episode[boundary] + (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 1 : 0.1)))));
    }}>
    <title>{label}: {episodeClock(episode[boundary])} — drag to edit; arrow keys adjust 0.1s</title>
    <line x1={x1} x2={x1} y1={y1} y2={y2} stroke="transparent" strokeWidth={14} />
    <line x1={x1} x2={x1} y1={y1} y2={y2} stroke={stroke} strokeWidth={2} strokeDasharray="3 2" />
    <rect x={x1 - 4} y={Math.min(y1, y2) + (boundary === "start_s" ? 0 : 10)} width={8} height={9} rx={2} fill={stroke} />
  </g>;
}
