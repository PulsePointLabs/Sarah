# PulsePoint Local OpenAI API audit

Audit baseline: `main` at `061bb1a3c49efad4cc7a7196a638032ec0570d10` (2026-07-02).

## Proven usage pattern

The local database contains 6,812 recorded TTS chunk executions across completed/background media work:

| Feature | Jobs | Recorded chunks |
| --- | ---: | ---: |
| Report TTS exports | 262 | 4,949 |
| Pelvic/Head-to-Toe anatomy videos | 56 | 1,590 |
| Session review videos | 54 | 273 |
| **Total** | **372** | **6,812** |

This nearly equals the OpenAI dashboard's 6,833 requests. The dominant cause was therefore chunked speech generation, not OpenAI analysis. One report reached 139 chunks and one anatomy-video run recorded 277 chunks. Every chunk previously allowed three backend attempts. The Settings voice-sample UI separately allowed four frontend attempts, creating a possible 12 upstream attempts from one tap.

The dashboard's 1.29 billion `input tokens` should not be interpreted as 1.29 billion characters of report prompts. PulsePoint does not send analysis conversations, profiles, or telemetry to an OpenAI chat model. OpenAI audio accounting can report audio/text token units that are not comparable to ordinary text tokens. The request count is nevertheless directly explained by persisted TTS chunk totals.

## Local runtime call sites

| Call site | Trigger | Multiplicity and automatic behavior | Data sent |
| --- | --- | --- | --- |
| `server/services/ttsCore.js` `callOpenAITTS` / `synthesizeTTSChunk` | Shared report playback, chat playback, settings sample, live cues, and renderer calls | One upstream speech call per cache miss/chunk. Previously up to 3 backend attempts per chunk. Now guarded, deduplicated, and capped at 2 transient attempts. | Current speech chunk, voice, model, format, speed, voice instructions, and bounded previous narration context. No conversation history, profile, or telemetry. |
| `server/services/ttsRenderer.js` `renderTTSExport` | Explicit Download/export; narration requested by video renderers | One call per supplied chunk, with concurrency up to 4. Historical max 139 report chunks. No polling-triggered generation. | Chunk text and prior-context continuity instructions. |
| `server/services/profileAnatomyVideoRenderer.js` narration render paths | Explicit Pelvic/Genital or Head-to-Toe video build | Calls `renderTTSExport`; section-measured mode can run a separate export per anatomy section. Historical recorded total reached 277 chunks in one job. | Existing saved review narration, not image data or full profile history. |
| `server/services/sessionReviewVideoRenderer.js` `ensureReviewNarration` and `synthesizeReviewSegmentAudio` | Explicit session-review video build | Reuses a matching completed narration when available; otherwise exports narration. Segment rendering can make one TTS call per video narration segment. | Saved session-review narration segment text and bounded previous segment context. |
| `server/services/liveCueAudioCache.js` `prepareLiveCueAudioClip`; `server/routes/liveCues.js` POST `/prepare` | Live Capture launch with Sarah voice cues enabled | Up to 40 one-time cue calls on cache miss. Disk cache prevents repeat calls for unchanged text/settings. Not caused by render or polling effects. | Short configured cue phrases only. |
| `server/routes/functions.js` POST `/openaiTTS` | Explicit Read/play action or settings sample | One request per uncached playback chunk. Concurrent identical requests now share one in-flight request. | One speech chunk and voice settings. |
| `server/routes/functions.js` POST `/whisperSTT` | Microphone recording stop in chat/journal/live capture/video tools | One transcription per completed recording. No automatic polling. | Recorded audio, fixed vocabulary prompt, language. |
| `server/routes/files.js` `transcribeAudioSnippet` | Explicit local-video audio pass with transcription enabled | Up to the user-selected snippet count (default 10), one transcription per snippet. | Short extracted audio snippets and a fixed vocabulary prompt. |
| `server/routes/sarahBrand.js` `callOpenAIImageGeneration` | Explicit Generate Sarah portrait button | One image call per explicit action. | Portrait prompt only; no patient data or anatomy media. |
| `server/routes/status.js` `getOpenAIStatus` | Settings & Status refresh/poll while an admin reporting key is configured | Two organization cost-report HTTP calls (7-day and 30-day), now cached server-side for five minutes instead of repeating on each five-second UI poll. These are administrative reads, not model inference/token usage, and are suppressed while the kill switch is off. | No user content. |
| `server/scripts/ttsVoiceLab.js` | Developer explicitly runs the voice-lab script | Calls the guarded local `/openaiTTS` route. | Developer sample text. |

## Frontend invocation paths

- `src/components/AIChat.jsx`: explicit message audio playback and microphone stop. IndexedDB audio cache and one-chunk lookahead; no render-driven generation.
- `src/components/TTSReader.jsx`: explicit shared-report playback and Download/export. Live playback uses IndexedDB; export can submit many chunks to `tts_export`.
- `src/components/TTSButton.jsx`: explicit legacy play button; one call per speech chunk.
- `src/components/TTSSettingsPanel.jsx`: explicit sample button. The former four-attempt frontend retry loop was removed.
- `src/pages/EventSyncPlayer.jsx`: explicit paragraph playback/preload and microphone stop.
- `src/components/JournalRecorder.jsx`, `src/components/VideoSyncPlayer.jsx`, `src/pages/LiveCapture.jsx`: one Whisper request when recording stops.
- `src/hooks/useLiveCueAudio.js`: only `prepare()` requests cues; Live Capture calls it during explicit session launch. It is not an automatic render/effect loop.
- `src/pages/SettingsStatus.jsx`: explicit portrait generation.

## Legacy/non-local call sites

- `base44/functions/openaiTTS/entry.ts`: legacy Base44 serverless TTS endpoint. It is not used by the local Express route, but remains deployable. It now requires `OPENAI_ENABLED=true`, caps attempts at two, and does not retry 429/auth/invalid errors.
- `base44/functions/whisperSTT/entry.ts`: legacy Base44 serverless transcription endpoint. It now requires `OPENAI_ENABLED=true` and a server-side key.

## Negative findings

- No OpenAI Chat Completions or Responses API call exists in the local runtime.
- Main session analysis, Profiler review generation, and Sarah chat reasoning use Anthropic/local services, not OpenAI.
- No OpenAI request includes full conversation history, the full longitudinal profile, raw HR/HRV/ECG/EMG arrays, or complete session exports.
- No React effect was found that automatically calls OpenAI on ordinary page render, SSE update, reconnect, or polling.
- No recursive OpenAI analysis path was found.
- Tests do not make real OpenAI requests.

## Safeguards added

- `OPENAI_ENABLED` is disabled by default and required in addition to a server-only key.
- Global in-flight and short-lived completed-request deduplication.
- Job idempotency using the existing `clientRequestId`.
- Maximum two transient attempts by default; no retry for 400/401/403/404/409/413/422/429, billing, authentication, quota, or invalid-request errors.
- Daily and monthly estimated-spend guards with concurrent cost reservation.
- Hard per-call input-character limit and bounded TTS export chunk/text limits.
- Prompt character count, estimated text tokens, model, feature, local request ID, provider request ID, latency, and estimated cost logged without prompt content.
- Append-only per-feature usage ledger at `data/openai-usage.jsonl` (ignored local runtime data).
- Whisper upload size cap.
- Legacy Base44 functions honor the kill switch.
