# CIVET pressure policy 4

Sustained elevated pressure previously triggered baseline-shift warnings and withheld reference intensity, hold duration and CIVET phase evidence. A comfortable calibration hold is a reference, not an upper pressure limit. Policy 4 retains a verified reference during sustained elevated pressure while preserving disconnect, sampling-gap, calibration-failure and below-rest pressure checks. Pressure alone does not establish whether a change represents contraction or repositioning.

Calibration readiness requires the relaxed baseline, steady hold and return-to-rest check. The release check stays pending until it passes; the hold measurement alone does not report calibration complete.

Completed recordings default to **Reprocessed pressure (corrected policy)**. Replay starts only from an original sample with verified calibration, preserves source pressure and timestamps, and stores versioned derived files keyed by the original recording's SHA-256. Original live results remain selectable. Reprocessed exports retain original session time; video trimming is display-only. No manual event markers are rewritten and no AI jobs are triggered.

Validation: 52 targeted CIVET and phase-evidence tests, browser calibration/review checks, Video Sync stacked/dual-monitor regression checks, focused lint and production build passed. A local recorded trace reproduced the high-pressure failure and recovered reference metrics without altering its source recording. Local and Tailscale health, deployed file hashes, served frontend identity, session analysis and reprocessed CSV export were checked after Windows deployment. Physical sensor validation in the next session remains outstanding.

The Windows patch uses the existing 0.1.274 application shell with updated web assets and CIVET modules. Replacement files are backed up under the installation's `patch-backups` directory. Private recordings, recovery caches and local validation logs are excluded from Git.
