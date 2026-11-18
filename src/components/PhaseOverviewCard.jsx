import './phaseOverviewCard.css';
export default function PhaseOverviewCard({prediction,approach,plateau,recovery,encouragement}){
  const values=[['Approach',approach],['Plateau',plateau],['Trust',prediction?.controllerConfidence],['Recovery',recovery]];
  return <section className="phase-overview-card" aria-label="Physiological response overview">
    <header><b>Physiological response</b><span>{prediction?.label||'Waiting for readings'}</span><small>Sarah {encouragement?'on':'off'}</small></header>
    <div className="phase-overview-values">{values.map(([label,value])=><div key={label} title={`${label}: ${value??'unavailable'} · physiological estimate`}><span>{label}</span><strong>{Number.isFinite(Number(value))&&value!=null?`${Math.round(value)}%`:'—'}</strong></div>)}</div>
  </section>;
}
