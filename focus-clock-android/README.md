# Focus Clock (Android)

Standalone keep-the-screen-on focus display: big clock, date, and current + tomorrow weather.
Native Kotlin, no third-party libraries. Weather comes from Open-Meteo (no API key).

## Using it

- **Tap** anywhere: toggle time-only mode.
- **Long-press**: settings (12/24h, seconds, °F/°C, night dim, set a city, back to device location).
- Screen stays on while the app is open; content drifts a few pixels each minute to avoid burn-in.
- Weather refreshes every 30 minutes (retries after 2 minutes if it fails).

## Re-skinning

All colors, fonts, and sizes live in `app/src/main/res/values/focus_style.xml`.

## Build

Needs JDK 17+ and the Android SDK (platform 36).

```sh
cd focus-clock-android
ANDROID_HOME=/path/to/sdk ./gradlew assembleRelease
# -> app/build/outputs/apk/release/app-release.apk (debug-signed, installs directly)
```
