export function hasActiveLiveSession(session, recording) {
  return Boolean(recording?.active || (session?.active && session?.activeSessionId));
}

export function describeSessionRecording({recording,session,camera,obsConnected=true}) {
  if(camera?.phase==='recording')return {label:'RECORDING · phone camera',tone:'text-red-500',detail:'Local camera capture is running.'};
  if(session?.importing||camera?.phase==='saving')return {label:'SAVING · recording has stopped',tone:'text-amber-500',detail:'Wait for finalization before starting another session.'};
  // A completed Sarah record remains addressable for review. Its ID does not
  // represent an active session, and an offline recorder cannot reopen it.
  if(session && !session.active && !recording?.active && session.finalizedAt)return {label:'SESSION ENDED',tone:'text-muted-foreground',detail:'Your Sarah session is saved and ready for review. No Sarah session is active. OBS is offline or idle; its laptop video stop time is separate.'};
  if(obsConnected===false){
    if(session && !session.active && !recording?.active)return {label:'NO ACTIVE SARAH SESSION',tone:'text-muted-foreground',detail:'Sarah is not recording a session. OBS is offline; Sarah cannot independently verify laptop video.'};
    return {label:'OBS CONNECTION LOST · recording unconfirmed',tone:'text-amber-500',detail:'OBS may still be recording independently. Sarah cannot confirm its video or session state until the connection returns.'};
  }
  if(recording?.active)return {label:recording.paused?'PAUSED · OBS':'RECORDING · OBS',tone:recording.paused?'text-amber-500':'text-red-500',detail:session?.active?'Sarah session and telemetry recording are active.':'OBS is recording. Sarah session confirmation is pending.'};
  return {label:'NOT RECORDING',tone:'text-muted-foreground',detail:session?.active?'Sarah has an open record, but OBS is not recording video.':'Live heart rate is monitoring only. No session is being recorded.'};
}
