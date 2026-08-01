import { parseBloodGlucoseCsv } from "../utils/parseBloodGlucoseCsv.js";
import { decodePulseOxCsvBytes, parsePulseOxCsv } from "../utils/parsePulseOxCsv.js";

function filenameHint(filename = "") {
  const normalized = String(filename).toLowerCase();
  if (/emay|spo2|sp02|pulse.?ox|oximeter|oxygen/.test(normalized)) return "pulse_ox";
  if (/onetouch|glucose|blood.?sugar/.test(normalized)) return "blood_glucose";
  return null;
}

export function classifyVitalsCsvBytes(bytes, filename = "") {
  const text = decodePulseOxCsvBytes(bytes);
  const glucose = parseBloodGlucoseCsv(text);
  const pulseOx = parsePulseOxCsv(text);
  const glucoseValid = !glucose.error && glucose.rows?.length > 0;
  const pulseOxValid = !pulseOx.error && pulseOx.rows?.length > 0;
  const hint = filenameHint(filename);

  if (hint === "pulse_ox" && pulseOxValid) return { kind: "pulse_ox", parsed: pulseOx };
  if (hint === "blood_glucose" && glucoseValid) return { kind: "blood_glucose", parsed: glucose };
  if (pulseOxValid && !glucoseValid) return { kind: "pulse_ox", parsed: pulseOx };
  if (glucoseValid && !pulseOxValid) return { kind: "blood_glucose", parsed: glucose };
  if (pulseOxValid && glucoseValid) return { kind: hint || "pulse_ox", parsed: hint === "blood_glucose" ? glucose : pulseOx };

  throw new Error(
    `Sarah could not identify this CSV as OneTouch glucose or EMAY pulse-ox data. `
    + `Glucose: ${glucose.error || "no valid rows"} Pulse ox: ${pulseOx.error || "no valid rows"}`,
  );
}
