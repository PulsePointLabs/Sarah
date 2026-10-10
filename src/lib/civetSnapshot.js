// Show only resolved evidence available at the playhead in causal modes.
export function contractionSnapshot(events, end, start = end - 30) {
  const known = events.filter(event => event.peak <= end && (event.mode === 'review' || event.confirmed_at <= end));
  const visible = known.filter(event => event.end >= start && event.onset <= end);
  const latest = known.at(-1);
  const recent = known.filter(event => event.quality === 'usable' && event.peak >= end - 10);
  let train = [];
  for (const event of recent) {
    const prior = train.at(-1);
    if (prior && (event.segment !== prior.segment || event.peak - prior.peak > 3 || event.peak - prior.peak < .4 - 1e-6)) train = [];
    train.push(event);
  }
  if (!train.length || end - train.at(-1).peak > 3) train = [];
  const intervals = train.slice(1).map((event, index) => event.peak - train[index].peak).sort((a, b) => a - b);
  const middle = Math.floor(intervals.length / 2);
  const spacing = intervals.length ? (intervals.length % 2 ? intervals[middle] : (intervals[middle - 1] + intervals[middle]) / 2) : null;
  return { visible, latest: latest && end - latest.peak <= 10 ? latest : null, train: train.length >= 3 ? train : [], spacing };
}
