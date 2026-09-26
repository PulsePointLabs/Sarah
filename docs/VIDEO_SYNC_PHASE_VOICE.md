# Video Sync phase voice

Full Telemetry has an independent Phase voice switch and Voice options for volume/test. It is off by default; the preference is saved on this device separately from Live Capture encouragement.

Uses the saved telemetry review model, including recorded CIVET evidence where available. Requires 12 seconds of continuous qualifying video-time evidence, a minimum 2.5 seconds of real observation, and at least 15 real seconds between successful announcements. Speech uses the configured Sarah voice speed, independently of video rate. At 6x, crossed telemetry samples are inspected but only the current qualifying phase can speak; skipped phases never form a speech queue.

Pausing, seeking, buffering, changing speed/feed/session, recording a voice note, disabling phase voice, or leaving Full Telemetry cancels playback and resets observation. Missing/stale telemetry cannot trigger a cue. Seeking into an established phase still requires a fresh observation window. Warm-up and initial baseline are silent.

Phrases: Sustained build; Sustained plateau; Climax candidate; Recovery; Back near baseline. Body Exploration uses Sustained physiological load / High physiological load instead of arousal/climax wording. These are review heuristics, not confirmation of an event. Only fixed phrases are sent to the configured TTS provider; recordings and physiological values are not sent by this feature.
