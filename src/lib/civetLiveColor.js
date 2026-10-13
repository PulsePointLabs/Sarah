// Color describes pressure relative to the comfortable reference, never arousal.
export function civetLiveColor(snapshot) {
  if (snapshot.current == null) return { hue: 38, accent: 'hsl(38 90% 74%)', background: 'hsl(38 25% 13%)', mode: 'uncertain' };
  const reference = snapshot.sample?.calibration?.reference;
  const ratio = reference > 0 ? Math.max(0, snapshot.current / reference) : 0;
  const intensity = Math.min(1, ratio);
  const hue = snapshot.rhythmic ? 285 : ratio < .2 ? 205 - intensity * 150 : 170 - Math.min(1, (ratio - .2) / .8) * 145;
  const sustained = snapshot.held && snapshot.sample.duration_s >= 3;
  return { hue, accent: `hsl(${hue} 85% 74%)`, background: `hsl(${hue} ${sustained ? 48 : 38}% ${13 + intensity * 5}%)`,
    mode: snapshot.rhythmic ? 'rhythmic' : sustained ? 'sustained' : snapshot.held ? 'rising' : 'rest' };
}
