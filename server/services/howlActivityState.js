const HOWL_ACTIVITIES = Object.freeze([
  ["LICKS", "Infinite licks", ["licks", "infinite licks"]],
  ["PENETRATION", "Penetration", ["penetration"]],
  ["VIBRATOR", "Sliding vibrator", ["vibrator", "sliding vibrator"]],
  ["MILKMASTER", "Milkmaster 3000", ["milkmaster", "milk master", "milkmaster 3000"]],
  ["CHAOS", "Chaos", ["chaos"]],
  ["HJ", "Luxury HJ", ["hj", "luxury hj", "handjob"]],
  ["OPPOSITES", "Opposites", ["opposites"]],
  ["CALIBRATION1", "Calibration 1", ["calibration 1", "calibration one"]],
  ["CALIBRATION2", "Calibration 2", ["calibration 2", "calibration two"]],
  ["BJ", "BJ Megamix", ["bj", "bj megamix"]],
  ["FASTSLOW", "Fast/slow", ["fastslow", "fast slow", "fast/slow", "fast and slow"]],
  ["SIMPLEX", "Simplex", ["simplex"]],
  ["RELENTLESS", "Relentless", ["relentless"]],
  ["OVERFLOWING", "Overflowing", ["overflowing"]],
  ["SUCCUBUS", "Succubus", ["succubus"]],
  ["SINETIME", "Sine time", ["sinetime", "sine time"]],
]);

function normalized(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function identifyHowlActivity(...values) {
  const candidates = values.map(normalized).filter(Boolean);
  for (const [name, displayName, aliases] of HOWL_ACTIVITIES) {
    const known = [name, displayName, ...aliases].map(normalized);
    if (candidates.some((candidate) => known.some((value) => candidate === value || candidate.includes(value)))) {
      return { name, displayName };
    }
  }
  return null;
}

export function readHowlActivityState(data = {}) {
  const player = data?.player || {};
  const explicit = data?.activity || data?.activity_name || data?.activityName || player?.activity || player?.activity_name;
  const activity = identifyHowlActivity(explicit, player?.filename, player?.file, player?.title);
  return {
    reported: Boolean(activity),
    name: activity?.name || null,
    displayName: activity?.displayName || null,
  };
}
