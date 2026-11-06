import { Capacitor, registerPlugin } from "@capacitor/core";

const androidVoice = registerPlugin("SarahVoice");
const speechOptions = { langs: ["en-US"], processLocally: true, quality: "dictation" };

export function liveVoiceWakePlatform() {
  if (Capacitor.getPlatform() === "android") return Capacitor.isPluginAvailable("SarahVoice") ? "android" : null;
  if (window.sarahDesktop?.isDesktop && window.sarahDesktop?.startVoiceWake && window.sarahDesktop?.onVoiceWakeEvent) {
    return "windows";
  }
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  return Recognition?.install && "processLocally" in Recognition.prototype ? "browser" : null;
}

export function playAndroidWakeCue() {
  return androidVoice.cue().catch(() => {});
}

export function acknowledgeAndroidVoice(command) {
  return androidVoice.acknowledge({ command }).catch(() => {});
}

export function connectLiveVoiceWake(platform, receive) {
  let closed = false;
  let recognition;
  let unsubscribe;
  let timer;
  let watchdog;
  let opened = false;
  let failures = 0;
  let stopped;
  const emit = (event) => { if (!closed) receive(event); };
  const fail = (message) => emit({ type: "error", message });

  function startBrowserTurn() {
    if (closed || document.hidden || recognition) return;
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const engine = new Recognition();
    recognition = engine;
    engine.processLocally = true;
    if ("quality" in engine) engine.quality = speechOptions.quality;
    engine.lang = speechOptions.langs[0];
    engine.continuous = true;
    let startedAt;
    let errorCode;
    engine.onstart = () => {
      if (recognition !== engine) return;
      clearTimeout(watchdog);
      startedAt = Date.now();
      emit({ type: "ready" });
    };
    engine.onerror = ({ error }) => {
      if (recognition === engine) errorCode = error;
    };
    engine.onresult = (event) => {
      if (recognition !== engine) return;
      const final = Array.from(event.results).slice(event.resultIndex).filter((result) => result.isFinal);
      if (final.length) {
        failures = 0;
        emit({ type: "recognized", transcript: final.map((result) => result[0]?.transcript).join(" ") });
      }
    };
    engine.onend = () => {
      if (recognition !== engine) return;
      recognition = null;
      clearTimeout(watchdog);
      if (["not-allowed", "service-not-allowed", "language-not-supported"].includes(errorCode)) {
        fail(errorCode === "language-not-supported"
          ? "Chrome's offline English speech pack is unavailable. Try Enable Wake again or use Record Now."
          : "Allow microphone access and on-device speech recognition to use Wake Listening.");
        return;
      }
      const interrupted = (errorCode && errorCode !== "no-speech") || !startedAt || Date.now() - startedAt < 500;
      failures = interrupted ? failures + 1 : 0;
      if (failures >= 5) {
        fail("Browser speech could not recover. Check microphone access and try Wake again.");
        return;
      }
      if (interrupted) emit({ type: "retrying" });
      timer = setTimeout(startBrowserTurn, interrupted ? 500 * failures : 150);
    };
    try {
      engine.start();
      watchdog = setTimeout(() => fail("Browser speech did not start. Check microphone access and try Wake again."), 15000);
    } catch {
      fail("Browser speech could not start. Check microphone access and try Wake again.");
    }
  }

  function stopBrowserTurn() {
    clearTimeout(timer);
    clearTimeout(watchdog);
    const engine = recognition;
    recognition = null;
    try { engine?.abort(); } catch {}
  }

  function visibilityChanged() {
    if (!opened || closed) return;
    if (document.hidden) {
      stopBrowserTurn();
      emit({ type: "suspended" });
    } else {
      failures = 0;
      startBrowserTurn();
    }
  }

  async function open() {
    if (platform === "android") {
      const handle = await androidVoice.addListener("speech", emit);
      if (closed) { await handle.remove(); return; }
      unsubscribe = () => handle.remove();
      opened = true;
      await androidVoice.start();
    } else if (platform === "windows") {
      unsubscribe = window.sarahDesktop.onVoiceWakeEvent((event) => {
        if (event.type === "ready") clearTimeout(watchdog);
        if (event.type === "stopped") fail("Windows speech stopped. Select Enable Wake to restart it.");
        else emit(event);
      });
      opened = true;
      watchdog = setTimeout(() => fail("Windows speech did not start. Check the default mic and English speech pack."), 15000);
      const result = await window.sarahDesktop.startVoiceWake();
      if (!result?.ok) throw new Error(result?.error || "Windows speech could not start.");
    } else {
      const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!await Recognition.install(speechOptions)) {
        throw new Error("Chrome could not install its offline English speech pack. Try Enable Wake again or use Record Now.");
      }
      if (closed) return;
      opened = true;
      document.addEventListener("visibilitychange", visibilityChanged);
      visibilityChanged();
    }
  }
  open().catch((error) => fail(error.message || "Wake Listening could not start."));

  return () => {
    if (closed) return stopped;
    closed = true;
    unsubscribe?.();
    stopBrowserTurn();
    document.removeEventListener("visibilitychange", visibilityChanged);
    if (opened && platform === "android") stopped = androidVoice.stop().catch(() => {});
    if (opened && platform === "windows") stopped = window.sarahDesktop.stopVoiceWake().catch(() => {});
    return stopped;
  };
}
