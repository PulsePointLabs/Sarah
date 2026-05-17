/**
 * parseEmgCsv — parse single-channel or dual-channel MyoWare EMG CSV
 * Returns { rows, channelMode, error }
 * channelMode: "single" | "dual"
 */
export function parseEmgCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return { error: "CSV appears empty or has no data rows." };

  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());

  // Detect channel mode
  const isDual = headers.includes("left_pct") || headers.includes("left_raw") || headers.includes("right_pct");
  const channelMode = isDual ? "dual" : "single";

  // Column index helpers
  const col = (name) => headers.indexOf(name);

  const timeIdx = col("time_s");
  const tRelIdx = col("t_rel_s");
  const unixIdx = col("unix_time");
  const isoIdx = col("iso_time");
  const markerIdx = col("marker");
  const obsRecIdx = col("obs_recording");
  const obsStateIdx = col("obs_state");

  // Single-channel
  const rawEnvIdx = col("raw_env");
  const envSmoothIdx = col("env_smooth");
  const levelPctIdx = col("level_pct");

  // Dual-channel
  const leftRawIdx = col("left_raw");
  const leftEnvIdx = col("left_env");
  const leftPctIdx = col("left_pct");
  const rightRawIdx = col("right_raw");
  const rightEnvIdx = col("right_env");
  const rightPctIdx = col("right_pct");
  const diffPctIdx = col("diff_pct");
  const restLIdx = col("rest_l");
  const maxLIdx = col("max_l");
  const restRIdx = col("rest_r");
  const maxRIdx = col("max_r");
  const flipLRIdx = col("flip_lr");

  const hasTimeCol = timeIdx !== -1 || tRelIdx !== -1 || unixIdx !== -1;

  let firstUnixTime = null;
  let rowIndex = 0;
  const rows = [];
  let skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = line.split(",");
    const get = (idx) => (idx !== -1 && cols[idx] !== undefined ? cols[idx].trim() : "");
    const getNum = (idx) => {
      const v = get(idx);
      const n = parseFloat(v);
      return isNaN(n) ? null : n;
    };
    const getBool = (idx) => {
      const v = get(idx);
      if (v === "1" || v.toLowerCase() === "true") return true;
      if (v === "0" || v.toLowerCase() === "false") return false;
      return null;
    };

    const marker = get(markerIdx) || null;
    const isMarkerRow = !!marker;

    // Determine time_s
    let time_s = null;
    if (timeIdx !== -1 && get(timeIdx) !== "") {
      time_s = getNum(timeIdx);
    } else if (tRelIdx !== -1 && get(tRelIdx) !== "") {
      time_s = getNum(tRelIdx);
    } else if (unixIdx !== -1 && get(unixIdx) !== "") {
      const ut = getNum(unixIdx);
      if (ut != null) {
        if (firstUnixTime == null) firstUnixTime = ut;
        time_s = parseFloat((ut - firstUnixTime).toFixed(6));
      }
    }
    // Fallback: row index based on 30 Hz
    if (time_s == null) {
      time_s = parseFloat((rowIndex / 30).toFixed(6));
    }

    // Check if row has any meaningful numeric data
    const hasNumericData = isDual
      ? (getNum(leftPctIdx) != null || getNum(rightPctIdx) != null || getNum(leftRawIdx) != null)
      : (getNum(levelPctIdx) != null || getNum(rawEnvIdx) != null || getNum(envSmoothIdx) != null);

    if (!hasNumericData && !isMarkerRow) {
      skipped++;
      continue;
    }

    const row = {
      time_s,
      unix_time: getNum(unixIdx),
      iso_time: get(isoIdx) || null,
      marker,
      obs_recording: getBool(obsRecIdx),
      obs_state: get(obsStateIdx) || null,
    };

    if (isDual) {
      row.left_raw = getNum(leftRawIdx);
      row.left_env = getNum(leftEnvIdx);
      row.left_pct = getNum(leftPctIdx);
      row.right_raw = getNum(rightRawIdx);
      row.right_env = getNum(rightEnvIdx);
      row.right_pct = getNum(rightPctIdx);
      row.diff_pct = getNum(diffPctIdx);
      row.rest_l = getNum(restLIdx);
      row.max_l = getNum(maxLIdx);
      row.rest_r = getNum(restRIdx);
      row.max_r = getNum(maxRIdx);
      row.flip_lr = getBool(flipLRIdx);
    } else {
      row.raw_env = getNum(rawEnvIdx);
      row.env_smooth = getNum(envSmoothIdx);
      row.level_pct = getNum(levelPctIdx);
    }

    // Remove null values to keep storage clean
    Object.keys(row).forEach((k) => { if (row[k] === null) delete row[k]; });

    rows.push(row);
    rowIndex++;
  }

  if (rows.length === 0) return { error: "No valid EMG rows found in the CSV." };

  return { rows, channelMode, skipped, total: lines.length - 1 };
}