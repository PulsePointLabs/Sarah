import { useCallback, useMemo, useRef, useState, useEffect } from "react";
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
  active = true,
} = {}) {
  const machineRef = useRef(createLiveCueStateMachineState());
  const generatedEpoch=useRef(0),recentGenerated=useRef([]),generating=useRef(false);
  const [latestCue, setLatestCue] = useState(null);
  const [lastSuppression, setLastSuppression] = useState(null);

  const phraseBank = useMemo(
    () => resolveLiveCuePhraseBank(cueSettings, { captureKind }),
    [captureKind, cueSettings]
  );

  const inputsRef = useRef(null);
  inputsRef.current = { audio, cueSettings, captureKind, sessionId, getSessionTime, onTimelineEvent, microphoneActive, phraseBank, active };

  const reset = useCallback(() => {
    generatedEpoch.current++;recentGenerated.current=[];
    machineRef.current = createLiveCueStateMachineState();
    setLatestCue(null);
    setLastSuppression(null);
    inputsRef.current.audio?.stop?.();
  }, []);
  useEffect(()=>{reset();},[sessionId,active,reset]);

  const step = useCallback((prediction, sample = {}) => {
    const { audio, cueSettings, captureKind, sessionId, getSessionTime, onTimelineEvent, microphoneActive, phraseBank } = inputsRef.current;
    if(!inputsRef.current.active)return null;
    const now = Date.now();
    const sessionTimeSec = typeof getSessionTime === "function" ? getSessionTime() : sample.sessionTimeSec;
    const intimateCadence = cueSettings?.style === "intimate_lovers_voice";
    const warmCadence = intimateCadence || cueSettings?.style === "intimate_coaching" || cueSettings?.style === "sarah_soft";
    const result = stepLiveCueStateMachine(
      machineRef.current,
      prediction,
      { ...sample, atMs: now, sessionTimeSec },
      {
        enabled: cueSettings?.enabled !== false,
        captureKind,
        allowSessionStyleCues: Boolean(cueSettings?.allowSessionStyleCues),
        ...(warmCadence ? {
          globalCooldownMs: intimateCadence ? 9_000 : 11_000,
          cooldowns: {
            sustained_build: intimateCadence ? 24_000 : 32_000,
            plateau_encouragement: intimateCadence ? 28_000 : 38_000,
            climax_possible: intimateCadence ? 20_000 : 25_000,
            climax_imminent: intimateCadence ? 14_000 : 18_000,
            recovery: intimateCadence ? 50_000 : 65_000,
            build_resumed: intimateCadence ? 24_000 : 32_000,
          },
          maxCuesPerMinute: intimateCadence ? 5 : 4,
        } : {}),
        ...(cueSettings?.generationMode!=='prerecorded'?{globalCooldownMs:45000,maxCuesPerMinute:2}:{}),
      },
      phraseBank.phrases
    );
    machineRef.current = result.state;

    if (result.suppressed?.length) {
      setLastSuppression({ ...result.suppressed[0], atMs: now });
    }

    if (!result.cue) return null;

    if(cueSettings?.generationMode!=='prerecorded' && audio?.speakGenerated){
      if(microphoneActive||generating.current)return null;
      generating.current=true;
      const epoch=generatedEpoch.current,state=machineRef.current.state;
      audio.speakGenerated(result.cue,{captureKind,style:cueSettings?.style,recent:recentGenerated.current,
        context:{...sample,hr:sample.hr??prediction?.currentHr,baselineHr:sample.baselineHr??prediction?.baselineHr,buildConfidence:prediction?.buildConfidence,plateauConfidence:prediction?.plateauConfidence,recovery:prediction?.recovery,sessionTimeSec},
        canPlay:()=>generatedEpoch.current===epoch&&machineRef.current.state===state&&inputsRef.current.sessionId===sessionId&&inputsRef.current.active&&inputsRef.current.cueSettings?.enabled!==false&&!inputsRef.current.microphoneActive,
      }).then(playback=>{
        if(generatedEpoch.current!==epoch)return;
        if(playback.phrase){recentGenerated.current=[...recentGenerated.current,playback.phrase].slice(-6);setLatestCue({...result.cue,phrase:playback.phrase,sessionId,sessionTimeSec,playback,generated:true});}
        if(!playback.ok)setLastSuppression({reason:playback.reason,message:playback.error,atMs:Date.now()});
        if(playback.ok)onTimelineEvent?.({type:'live_cue',label:'Sarah generated feedback',time_s:sessionTimeSec,metadata:{...result.cue,phrase:playback.phrase,generated:true,playback}});
      }).finally(()=>{generating.current=false;});
      return null;
    }

    let playback = { ok: false, reason: "microphone_active" };
    if (!microphoneActive) {
      playback = audio?.playCue?.(result.cue, { freshnessMs: 2500 }) || { ok: false, reason: "audio_unavailable" };
    }

    const cueRecord = {
      ...result.cue,
      sessionId,
      sessionTimeSec,
      playback,
      spokenAt: playback.ok ? new Date().toISOString() : null,
    };
    setLatestCue(cueRecord);
    onTimelineEvent?.({
      type: "live_cue",
      label: `Sarah live cue: ${result.cue.type.replace(/_/g, " ")}`,
      time_s: sessionTimeSec,
      metadata: cueRecord,
    });
    return cueRecord;
  }, []);

  return useMemo(() => ({
    phraseBank,
    latestCue,
    lastSuppression,
    step,
    reset,
  }), [lastSuppression, latestCue, phraseBank, reset, step]);
}
