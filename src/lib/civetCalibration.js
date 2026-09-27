// Pressure stability checks, not identification of muscle activity or its cause.
export function calibrationFeedback(values, kind, calibration) {
  if (values.length < 10) return { tone: 'waiting', message: 'Collecting pressure…', acceptable: false };
  const sorted = [...values].sort((a, b) => a - b);
  const q = p => sorted[Math.floor((sorted.length - 1) * p)];
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
  const edge = Math.min(10, Math.floor(values.length / 2));
  const avg = a => a.reduce((s, v) => s + v, 0) / a.length;
  const drift = Math.abs(avg(values.slice(-edge)) - avg(values.slice(0, edge)));
  const span = sorted.at(-1) - sorted[0];
  let message;
  if (kind === 'baseline') {
    if (sd > .12 || drift > .15 || span > .3) message = 'Rest pressure is unstable. Relax, keep still, then redo rest.';
  } else {
    const amplitude = q(.95) - (calibration?.baseline ?? 0);
    if (amplitude < Math.max(.1, (calibration?.noise ?? 0) * 6)) message = 'Hold is too weak or noisy. Redo with a comfortable, clearer squeeze.';
    else if (q(.25) - calibration.baseline < amplitude * .3 || sd > Math.max(.12, amplitude * .2) || drift > Math.max(.15, amplitude * .3) || span > Math.max(.3, amplitude * .65)) message = 'Hold varied or was released early. Rest, then redo the hold.';
  }
  return { tone: message ? 'warning' : 'good', acceptable: !message,
    message: message || (kind === 'baseline' ? 'Pressure steady — stay relaxed.' : 'Hold steady — keep this comfortable pressure.'), sd, drift, span };
}

