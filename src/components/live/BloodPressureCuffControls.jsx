import { formatBloodPressure } from "@/lib/bloodPressure";

export default function BloodPressureCuffControls({ listening, busy, message, error, receipt, sessionReading, onToggle, onChoose, onDiagnostics, label }) {
  const inSession = receipt?.external_id && receipt.external_id === sessionReading?.external_id;
  return <section aria-label={label} className="w-full rounded-xl border border-border p-3 space-y-2">
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-sm font-semibold">Blood pressure</span>
      <button type="button" className="min-h-11 rounded-lg border border-primary/40 px-3 py-2 text-sm" disabled={busy} onClick={onToggle}>{listening ? "Disconnect cuff" : "Connect cuff"}</button>
      <span role="status" className={`text-sm ${error ? "text-amber-400" : "text-muted-foreground"}`}>{message}</span>
    </div>
    {receipt ? <p className="text-sm"><strong>{formatBloodPressure(receipt)}</strong> · {inSession ? "Saved to this session" : "Saved to BP history"} · received {new Date(receipt.received_at || receipt.raw?.received_at).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}</p>
      : <p className="text-sm text-muted-foreground">{sessionReading ? `This session: ${formatBloodPressure(sessionReading)}` : "Take a cuff reading to test the connection. A recording is not required."}</p>}
    <details className="text-sm text-muted-foreground">
      <summary className="cursor-pointer">Cuff options</summary>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={onChoose} className="rounded-lg border border-border px-3 py-2">Change cuff</button>
        <button type="button" onClick={onDiagnostics} className="rounded-lg border border-border px-3 py-2">Copy technical details</button>
      </div>
    </details>
  </section>;
}
