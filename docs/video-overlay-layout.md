# Video Sync overlay layout

Full Telemetry overlays share one device/browser layout across sessions. Card position, size, opacity, visibility, selected card controls, chart window, channel choices and hide-controls mode persist locally. Session data and selected pressure episodes remain specific to the loaded record.

Drag the heading to move a card; drag its corner to resize. Snap to grid is on by default (24 pixels), and can be disabled in the overlay menu. Hold Alt for precise placement. Small pointer movements are ignored. Neighboring cards stay still during the preview and only move after a deliberate overlapping drop. A small overlap is tolerated so cards do not jump around unnecessarily.

Viewport fitting does not overwrite saved dimensions: returning to a larger display restores the preferred layout. Cards without data stay in their saved positions with a placeholder. Existing saved layouts are preserved.

The scoped overlay styling follows the dark panels and physiological channel colors from https://github.com/PulsePointLabs/sarah-monitor. Regular Video Sync controls, record loading, annotations and physiological calculations are unchanged.

Automated coverage: video-overlay-session-profile-browser.cjs checks remount/session, viewport, preferences, missing data, hide mode, grid and stable drag previews. Existing overlay, keyboard, review interaction and record-loading browser checks cover surrounding behavior. Browser checks do not establish physical Samsung DeX touchpad behavior.
