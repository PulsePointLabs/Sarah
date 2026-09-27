# Starting Sarah on Windows

Use the **Sarah desktop shortcut**, or run `scripts\start-sarah.cmd`. The shortcut now calls that launcher. It checks the local Sarah health response, starts the native backend when needed, waits for readiness, and opens a Chrome app window in the signed-in user's desktop. It clears an inherited `ELECTRON_RUN_AS_NODE` flag and does not depend on PowerShell script execution policy.

A Chrome/PWA shortcut alone cannot start the local backend. Conversely, the native Sarah process can already be running in Windows session 0, where its window is invisible to the signed-in user in session 1. A healthy API and a native process therefore do not prove that the user has a visible application. The launcher explicitly opens the browser client from the user's desktop session, independently of which session owns the backend. The previous shortcut is backed up under `release-artifacts/launch-repair-20260927`.

Do not reapply the obsolete 0.1.267 patch to launch the application. Its downloaded PowerShell script was blocked by RemoteSigned/Mark-of-the-Web. On this machine, its CMD entry point now explains that it is obsolete and opens the installed app instead. Its original CMD was backed up; no global execution-policy setting was changed.

The current patch launcher verifies the installer checksum before unblocking that one installer. The installer verifies every payload checksum before replacing anything. If all installed file hashes already match, it opens Sarah and verifies health without stopping capture or replacing files. If an actual update is required, the existing active-capture guard, shutdown checks and backup remain in place.

Readiness means more than a process existing: verify local and Tailscale health responses, frontend identity, CIVET API, browser rendering and the user's visible window. Repeated launches must not create duplicate backends. Physical sensor validation is separate from application launch readiness.
