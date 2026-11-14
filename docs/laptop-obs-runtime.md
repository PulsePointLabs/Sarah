# Laptop OBS runtime setup

The Sarah Laptop profile and scene collection use the EMEET S600 and NexiGo N60 external USB cameras. The built-in HP camera is excluded. Sources use stable /dev/v4l/by-id paths rather than changing video device numbers.

Main / PIP shares one NexiGo source with Feet. Avoid adding another V4L2 source for the same physical camera; duplicate handles caused failures and unnecessary decoding/rendering work.

For the current CachyOS laptop, use MJPEG camera acquisition at 1920x1080 and 30 fps, a 1920x1080 canvas/output, and MKV recording. Two-camera preview held 30 fps after this change; 4K acquisition/output and duplicate sources had reduced preview to around 20 fps. This is preview validation, not a multi-camera recording endurance test.

The per-user Sarah Laptop Session shortcut maps the external cameras, opens Sarah, and checks configuration without starting a recording. Its camera settings are explicitly 1080p MJPEG rather than the camera driver's 320x240 default.

The private OBS configuration and backup snapshots stay on the laptop. The OBS WebSocket password is not stored in this repository. Sarah's server connects to the laptop over Tailscale; the server may remain downstairs.
