export async function resumeLiveCueContext(context, timeoutMs = 1500) {
  if (context.state === "running") return true;
  let timer;
  try {
    await Promise.race([
      context.resume(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Tap Test voice on this device to enable Sarah audio.")), timeoutMs);
      }),
    ]);
    if (context.state !== "running") throw new Error("Tap Test voice on this device to enable Sarah audio.");
    return true;
  } finally {
    clearTimeout(timer);
  }
}

export function liveCuePlaybackMessage(reason) {
  return {
    audio_context_not_running: "Audio needs permission on this device. Tap Test voice.",
    clip_not_preloaded: "A voice clip is unavailable. Tap Test voice to retry preparation.",
    microphone_active: "Sarah is quiet while a voice note is recording.",
    muted: "Sarah volume is at 0%. Raise it, then tap Test voice.",
  }[reason] || "";
}
