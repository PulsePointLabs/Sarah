# Video Sync overlay layout

Full Telemetry overlays share one device/browser layout across sessions. Card position, size, opacity, visibility, selected card controls, chart window, channel choices and hide-controls mode persist locally. Session data and selected pressure episodes remain specific to the loaded record.

Drag the heading to move a card; drag its corner to resize. Snap to grid is on by default (24 pixels), and can be disabled in the overlay menu. Hold Alt for precise placement. Small pointer movements are ignored. Neighboring cards stay still during the preview and only move after a deliberate overlapping drop. A small overlap is tolerated so cards do not jump around unnecessarily.

Viewport fitting does not overwrite saved dimensions: returning to a larger display restores the preferred layout. Cards without data stay in their saved positions with a placeholder. Existing saved layouts are preserved.

The scoped overlay styling follows the dark panels and physiological channel colors from https://github.com/PulsePointLabs/sarah-monitor. Regular Video Sync controls, record loading, annotations and physiological calculations are unchanged.

Automated coverage: video-overlay-session-profile-browser.cjs checks remount/session, viewport, preferences, missing data, hide mode, grid and stable drag previews. Existing overlay, keyboard, review interaction and record-loading browser checks cover surrounding behavior. Browser checks do not establish physical Samsung DeX touchpad behavior.


## Monitor dashboard (v0.1.321)

The Video Sync sidebar and detached monitor share a fitted dashboard. Arrange cards enables header dragging, corner resizing, keyboard arrows on the handles, two-finger touch movement, and touchpad wheel movement (Ctrl-wheel resizes). The lifted card follows the pointer and highlights its destination. Neighbors remain stable during the gesture; order and weight changes apply on release. Cards automatically tile the available viewport, with no dashboard scrolling. Their order, relative sizes and visibility persist locally across records. Cards can be expanded to inspect their full content. Small cards show a compact reading/state and keep detail accessible through expansion.

On the detached monitor, F or Fullscreen (F) enters immersive native fullscreen and hides all setup/playback toolbars; only cards and current/upcoming events remain. F or Escape restores controls. Playback/annotation shortcuts continue to work from either window. Main-window F retains its existing video/sidebar focus behavior; H toggles video-only mode.

Video overlay fitting now packs cards when switching to a narrower video viewport, without changing the larger-screen preferences. Drag previews are smooth; snapping applies on release. Minimum card dimensions are 140x100 for individual metrics, 220x150 for trends/phase and 240x170 for pressure (grid snapping may round up). Ctrl-drag or the header moves a card; the corner resizes it. Touchpad two-finger wheel moves overlays and Ctrl-wheel resizes them.

Charts measure in their own document, so popup/resolution changes update the full plot dimensions. Tooltips render in a document-level portal to avoid card clipping. Styling across all three surfaces uses Sarah Monitor's ink panels, compact headings, green cardiac numerics, and yellow/blue HRV traces. No telemetry calculations, record-loading routes or saved annotations are changed.

Validation includes rich synthetic pressure/Howl dashboards at 1080p and 720p, no scroll/content overflow, text floors, chart dimension checks, mode-change persistence, small-card resizing, stable previews, simulated two-touch movement and detached F behavior. This is not a physical Samsung DeX test.


## v0.1.322 regression correction

The v0.1.321 collision fallback wrongly tiled floating cards across the whole video. It is removed: viewport projection only constrains each floating box, and never packs the video into dashboard tiles. Stored user geometry is retained. Display > Compact overlay positions is an explicit reset of positions/sizes that keeps selected cards. Display > Hide overlays removes all overlays from view without discarding the saved layout.

Pressure and Howl overlay entries are now independent of sidebar channel visibility. A selected sensor overlay renders its data even if its sidebar card is disabled. Loading, failed requests (with Retry) and genuinely empty saved records have distinct states; optional sidebar visibility must never masquerade as missing data. Sensor requests still use the selected saved record. Howl refresh preserves known samples and ignores responses after a record change/unmount.

Display stays visible in video-only/focus mode, and in the detached monitor. Show sidebar and controls restores review controls without leaving Video Sync; Exit full telemetry returns to the video review page. Three quick clicks/taps on an unobstructed video area also restore the sidebar, rather than navigating. Android system gestures are outside the web app's control.

Arrange overlays provides click-to-select, Place (click a destination), directional buttons, Smaller/Bigger/Narrower/Shorter and Done. These require ordinary touchpad clicks, so gesture support is not the only way to arrange a card. Header/corner dragging and touchpad movement remain available. Smaller buttons use exact bounded resizing; snapping never forces a minimum-size card to grow.

### Monitor graph port

Source: PulsePointLabs/sarah-monitor at `10d852aaaa739ae1629ce64eb8d321c8460ae9ce`, `app/src/main/java/com/pulsepointlabs/sarahmonitor/ui/Charts.kt` (`TrendChart`, `niceTicks`, pressure fill conventions). `monitorChartGeometry.js` and `MonitorTrendChart.jsx` port the drawing rules to SVG: minimum span and 10% padding, 1/2/2.5/5/10 tick steps, label-aware margins/tick count, three time labels, horizontal grid, linear round traces and open missing-data gaps. Review uses session-relative seconds. Pressure uses existing calibrated values, its existing gap policy and reference range; commands remain dots. HRV uses Monitor yellow/blue; cardiac uses green with a window-average reference. Howl exposes observed A/B levels. Existing phase calculations, saved record content and episode boundary edits are preserved; boundary handles accept the ported plot width.

Validation includes selected pressure/Howl overlays with both sidebar channels disabled, transient failure/retry/empty states, no automatic tiling, click placement/resizing, hide/show persistence, visible exit, triple-click restore, graph geometry unit vectors, 720p/1080p layout checks and existing playback/annotation/record-loading checks. Real server records were checked read-only for sensor sample presence. Physical S25/DeX testing remains unavailable without that device connected.
