import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "@/components/ui/use-toast";
import { importBloodGlucoseCsvBytes } from "@/lib/bloodGlucoseImport";
import { importPulseOxCsvBytes } from "@/lib/pulseOxImport";
import { classifyVitalsCsvBytes } from "@/lib/vitalsCsvClassifier";
import {
  base64ToBytes,
  consumePendingNativeCsv,
  isNativeCsvImportSupported,
  listenForNativeCsv,
} from "@/lib/nativeCsvImport";

export default function IncomingCsvImportCoordinator() {
  const navigate = useNavigate();
  const importingRef = useRef(false);

  useEffect(() => {
    if (!isNativeCsvImportSupported()) return undefined;
    let active = true;
    let listener = null;

    const consume = async () => {
      if (!active || importingRef.current) return;
      importingRef.current = true;
      try {
        const incoming = await consumePendingNativeCsv();
        if (!incoming?.pending) return;
        if (incoming.error) throw new Error(incoming.error);
        if (!incoming.base64) throw new Error("Android received the CSV but did not provide readable file data.");

        const bytes = base64ToBytes(incoming.base64);
        const classified = classifyVitalsCsvBytes(bytes, incoming.filename);
        const result = classified.kind === "pulse_ox"
          ? await importPulseOxCsvBytes(bytes, {
              filename: incoming.filename || "emay-pulse-ox.csv",
              parsed: classified.parsed,
            })
          : await importBloodGlucoseCsvBytes(bytes);
        if (result.error) throw new Error(result.error);

        const pulseOx = classified.kind === "pulse_ox";
        window.dispatchEvent(new CustomEvent(
          pulseOx ? "sarah:pulse-ox-imported" : "sarah:blood-glucose-imported",
          {
          detail: result,
          },
        ));
        toast({
          title: pulseOx
            ? `Imported ${result.imported} SpO2 reading${result.imported === 1 ? "" : "s"}`
            : `Imported ${result.imported} blood glucose reading${result.imported === 1 ? "" : "s"}`,
          description: `${result.newlySaved} new · matched ${result.matchedRecords} session record${result.matchedRecords === 1 ? "" : "s"}`,
          duration: 5000,
        });
        navigate("/vitals", {
          state: {
            [pulseOx ? "incomingPulseOxImport" : "incomingGlucoseImport"]: {
              filename: incoming.filename || (pulseOx ? "emay-pulse-ox.csv" : "blood-glucose.csv"),
              imported: result.imported,
              newlySaved: result.newlySaved,
              matchedRecords: result.matchedRecords,
            },
          },
        });
      } catch (error) {
        toast({
          title: "Vitals CSV import failed",
          description: error?.message || String(error),
          variant: "destructive",
          duration: 7000,
        });
      } finally {
        importingRef.current = false;
      }
    };

    listenForNativeCsv(consume)
      .then((handle) => {
        listener = handle;
        consume();
      })
      .catch(() => {
        consume();
      });

    return () => {
      active = false;
      listener?.remove?.();
    };
  }, [navigate]);

  return null;
}
