import { useCallback, useMemo, useRef, useState } from "react";
import { createLiveCueStateMachineState, stepLiveCueStateMachine } from "@/lib/liveCueStateMachine";
import { resolveLiveCuePhraseBank } from "@/lib/liveCuePhrases";

export function useLiveCueEngine({
  captureKind,
  cueSettings,
  audio,
  sessionId,
  getSessionTime,
  onTimelineEvent,
  microphoneActive = false,
} = {}) {
  const machineRef = useRef(createLiveCueStateMachineState());
  const [latestCue, setLatestCue] = useState(null);
  const [lastSuppression, setLastSuppression] = useState(null);
  const [edgingCandidates, setEdgingCandidates] = useState([]);

  const phraseBank = useMemo(
    () => resolveLiveCuePhraseBank(cueSettings, { captureKind }),
    [captureKind, cueSettings]
  );

  const reset = useCallback(() => {
    machineRef.current = createLiveCueStateMachineState();
    setLatestCue(null);
    setLastSuppression(null);
    setEdgingCandidates([]);
    audio?.stop?.();
  }, [audio]);

  const step = useCallback((prediction, sample = {}) => {
    const now = Date.now();
    const sessionTimeSec = typeof getSessionTime === "function" ? getSessionTime() : sample.sessionTimeSec;
    const result = stepLiveCueStateMachine(
      machineRef.current,
      prediction,
      { ...sample, atMs: now, sessionTimeSec },
      {
        enabled: cueSettings?.enabled !== false,
        captureKind,
        allowSessionStyleCues: Boolean(cueSettings?.allowSessionStyleCues),
      },
      phraseBank.phrases
    );
    machineRef.current = result.state;

    if (result.edgingCandidate) {
      setEdgingCandidates((prev) => [...prev.slice(-8), result.edgingCandidate]);
      onTimelineEvent?.({
        type: "live_cue_edging_candidate",
        label: "edging pattern candidate",
        time_s: sessionTimeSec,
        metadata: result.edgingCandidate,
      });
    }

    if (result.suppressed?.length) {
      setLastSuppression({ ...result.suppressed[0], atMs: now });
    }

    if (!result.cue) return null;

    let playback = { ok: false, reason: "microphone_active" };
    if (!microphoneActive) {
      playback = audio?.playCue?.(result.cue, { freshnessMs: 2500 }) || { ok: false, reason: "audio_unavailable" };
    }

    const cueRecord = {
      ...result.cue,
      sessionId,
      sessionTimeSec,
      playback,
      spokenAt: new Date().toISOString(),
    };
    setLatestCue(cueRecord);
    onTimelineEvent?.({
      type: "live_cue",
      label: `Sarah live cue: ${result.cue.type.replace(/_/g, " ")}`,
      time_s: sessionTimeSec,
      metadata: cueRecord,
    });
    return cueRecord;
  }, [audio, captureKind, cueSettings, getSessionTime, microphoneActive, onTimelineEvent, phraseBank.phrases, sessionId]);

  return useMemo(() => ({
    phraseBank,
    latestCue,
    lastSuppression,
    edgingCandidates,
    step,
    reset,
  }), [edgingCandidates, lastSuppression, latestCue, phraseBank, reset, step]);
}
