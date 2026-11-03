# Sarah Chat and telemetry recovery — v0.1.297

Normal chat again includes ten complete recent messages and profile grounding.
The July 15 speed change (`e84112c`) reduced ordinary chat to six messages of
520 characters and omitted profile grounding outside visual reviews. The restore
keeps newer persistence and visual-review features. Ordinary typed messages use
a direct conversational instruction instead of the old mandatory interview/pivot
instruction. Saved personality, model-provider, and TTS settings are unchanged.
The optional context endpoint now has a six-second timeout and its existing local
fallback. Profile/history context goes to the existing configured AI provider only
when the user sends a chat request; validation does not call that provider.

Channels, Cards, and overlay selection use one document-aware menu. Selection,
outside taps, and Escape dismiss it. Portals render in the trigger's document,
including detached telemetry. Video overlay dragging previews across occupied
space; only a non-overlapping final drop is saved. Cancellation restores position.

Manual notes and episode reviews share an Anatomy & images viewer. Areas are
consistent across reports and camera-specific; missing saved coverage is distinct
from an explicit not-visible observation. Text is presented in second person.
Only saved images within 0.6 seconds of an observation are associated with it.
New reviews retain matching native-resolution evidence locally. Older reports
remain readable without automatic paid re-analysis; missing images are labeled.
New manual reviews request a complete camera-specific anatomy checklist, separate
from findings eligible for profile promotion. Uncertainty and subjective labels
remain separate from observed physiology.

Live Capture has a secondary-screen action and real fullscreen (F), with header
controls hidden until hovered/focused. Its layout supports free unoccupied drops,
saved positions, and minimum resize sizes. Telemetry no longer scales a whole
canvas down into tiny type. Primary resize surfaces use readable text floors and
larger metric values. Crowded/short screens scroll rather than violate those
floors. Manual card sizes are retained; hidden cards do not inflate peers.

The three Live Capture dashboard alternatives are mockups, not a replacement of
the installed main dashboard. The cuff transport is unchanged from v0.1.295's
reading-only connection flow. Physical cuff operation still needs a fresh test.

Validation covers context/prompt routing, optional-context timeout, saved reviews,
evidence timestamps, camera scope, sizing/packing, menus, native fullscreen,
secondary windows, overlay movement/resizing, persistence, and pixel-based SVGs.
Browser/API fixtures use synthetic data and no paid analysis. This validates the
software paths, not model prose quality or physical sensor behavior.
