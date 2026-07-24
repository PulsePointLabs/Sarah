import { useEffect, useState } from "react";
import { ExternalLink, RefreshCw, Scale } from "lucide-react";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { base44 } from "@/api/base44Client";
import BodyCompositionSummaryCard from "@/components/BodyCompositionSummaryCard";
import {
  listBodyCompositionReadings,
  openBodyCompositionHealthConnectSettings,
  requestBodyCompositionPermission,
  syncBodyCompositionFromHealthConnect,
} from "@/lib/bodyComposition";
import { isSarahNativeShell } from "@/lib/mobileApiBase";

export default function BodyCompositionProfilePanel({ onLatestReading }) {
  const { toast } = useToast();
  const [readings, setReadings] = useState([]);
  const [busy, setBusy] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
  const [syncError, setSyncError] = useState(false);

  const reload = async () => {
    const rows = await listBodyCompositionReadings(180).catch(() => []);
    setReadings(rows);
    if (rows[0]) onLatestReading?.(rows[0]);
    return rows;
  };

  useEffect(() => {
    reload();
  }, []);

  const sync = async () => {
    setBusy(true);
    setSyncError(false);
    setSyncMessage("Checking Health Connect permissions and weigh-ins...");
    try {
      let result;
      try {
        result = await syncBodyCompositionFromHealthConnect({ days: 365, limit: 300 });
      } catch (error) {
        if (/permission/i.test(error.message || "")) {
          await requestBodyCompositionPermission();
          result = await syncBodyCompositionFromHealthConnect({ days: 365, limit: 300 });
        } else {
          throw error;
        }
      }
      const rows = await reload();
      if (rows[0]) {
        await base44.auth.updateMe({
          weight_kg: rows[0].weight_kg ?? null,
          latest_body_composition: rows[0],
        });
      }
      const nativeCount = Number(result.native?.count || 0);
      const typeLabels = {
        WeightRecord: "weight",
        BodyFatRecord: "body fat",
        LeanBodyMassRecord: "lean mass",
        BodyWaterMassRecord: "body water",
        BoneMassRecord: "bone mass",
        BasalMetabolicRateRecord: "BMR",
      };
      const typeCounts = result.native?.recordTypeCounts || {};
      const suppliedTypes = Object.entries(typeLabels)
        .filter(([type]) => Number(typeCounts[type] || 0) > 0)
        .map(([, label]) => label);
      const missingTypes = Object.entries(typeLabels)
        .filter(([type]) => Number(typeCounts[type] || 0) === 0)
        .map(([, label]) => label);
      const sourceDetail = suppliedTypes.length
        ? ` Health Connect supplied ${suppliedTypes.join(", ")}.${missingTypes.length ? ` Not supplied: ${missingTypes.join(", ")}.` : ""}`
        : "";
      const message = result.inserted
        ? `Imported ${result.inserted} body-composition reading${result.inserted === 1 ? "" : "s"}.${sourceDetail}`
        : nativeCount
          ? `Health Connect returned ${nativeCount} reading${nativeCount === 1 ? "" : "s"}, but none were new.`
          : "Health Connect returned no weigh-ins. Grant Sarah all body-composition and history permissions, and confirm VeSync is sharing weight data.";
      setSyncMessage(message);
      toast({ title: message });
    } catch (error) {
      const message = error.message || "Health Connect sync failed";
      setSyncError(true);
      setSyncMessage(message);
      toast({ title: message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const chart = [...readings].reverse()
    .filter((reading) => (
      reading.weight_kg != null
      && reading.weight_kg !== ""
      && Number.isFinite(Number(reading.weight_kg))
    ))
    .map((reading) => ({
      date: new Date(reading.measured_at).toLocaleDateString([], { month: "short", day: "numeric" }),
      weight: reading.weight_kg,
      bodyFat: reading.body_fat_percent,
    }));
  const hasBodyFat = chart.some((row) => (
    row.bodyFat != null
    && row.bodyFat !== ""
    && Number.isFinite(Number(row.bodyFat))
  ));

  return (
    <div className="space-y-4 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
            <Scale className="h-4 w-4" /> Body Composition History
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">VeSync measurements imported through Android Health Connect.</p>
        </div>
        {isSarahNativeShell() && (
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={sync} disabled={busy} className="gap-2">
              <RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />
              {busy ? "Syncing…" : "Sync Health Connect"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="gap-2"
              onClick={() => openBodyCompositionHealthConnectSettings().catch((error) => {
                setSyncError(true);
                setSyncMessage(error.message || "Could not open Health Connect settings.");
              })}
            >
              <ExternalLink className="h-4 w-4" /> Permissions
            </Button>
          </div>
        )}
      </div>
      {syncMessage && (
        <div className={`rounded-lg border px-3 py-2 text-sm ${syncError ? "border-destructive/40 bg-destructive/10 text-destructive" : "border-primary/25 bg-primary/5 text-foreground"}`}>
          {syncMessage}
        </div>
      )}
      {readings[0] ? <BodyCompositionSummaryCard reading={readings[0]} compact title="Latest Weigh-In" /> : (
        <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          No weigh-ins saved yet. Open this page in the APK and tap Sync Health Connect.
        </div>
      )}
      {chart.length > 1 && (
        <div className="h-52 rounded-lg border border-border bg-muted/10 p-3">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chart}>
              <XAxis dataKey="date" tick={{ fontSize: 10 }} />
              <YAxis yAxisId="weight" domain={["dataMin - 2", "dataMax + 2"]} tick={{ fontSize: 10 }} />
              {hasBodyFat && <YAxis yAxisId="fat" orientation="right" domain={["dataMin - 2", "dataMax + 2"]} tick={{ fontSize: 10 }} />}
              <Tooltip />
              <Line yAxisId="weight" type="monotone" dataKey="weight" name="Weight kg" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} connectNulls />
              {hasBodyFat && <Line yAxisId="fat" type="monotone" dataKey="bodyFat" name="Body fat %" stroke="hsl(var(--chart-2))" strokeWidth={2} dot={false} connectNulls />}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
