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
