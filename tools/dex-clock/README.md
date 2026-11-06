# Floating Clock (DeX) 🕙

Ben's always-on-top desktop clock for Samsung DeX on the S25 Ultra.

- 24h time, full date ("Thursday, November 5")
- Bar along the bottom fills across the hour, drifting **blue → violet → red**
- The glass background can take on the same hour colour (Background colour slider)
- Weather icon + temperature on the date line (Open-Meteo, no account or key needed)
- Optional second card: **bedtime countdown** (H:MM until bed, blue → red over the last
  4 hours, then "+H:MM past bedtime" for up to 4 hours). Same look, moves and resizes on its own.
- Floats over every app, and automatically jumps to the DeX monitor when DeX is connected
  (back to the phone screen when it isn't)

## Install

1. Download `FloatingClock.apk` onto the phone and open it. Allow "install unknown apps" for whatever opened it.
2. Open **Floating Clock**, tap **Show clock**, and turn on **Allow display over other apps** when asked.
3. Allow notifications. Android needs a small "Clock is floating" notification to keep it alive.
4. Recommended: **Battery settings → Battery → Unrestricted**, so One UI doesn't put it to sleep.
5. For weather: in settings tap **Use my location** once (or type a city / ZIP). It's only looked
   up when you tap, never tracked in the background. Weather refreshes every 20 minutes.

## Using it

| Do this | Get this |
| --- | --- |
| Drag the clock | Move it |
| Hover with the mouse (or tap it) | Gear + resize corner appear |
| Drag the bottom-right corner, mouse-wheel over it, or pinch | Resize |
| Click the gear | Settings (opacity, background, colour tint, size, weather, bedtime, start on boot) |
| "Hide clock" in the notification | Put it away |

## Build

```
./gradlew assembleRelease     # needs Android SDK 35 (set sdk.dir in local.properties)
```

`app/debug.keystore` is checked in on purpose so every new build installs over the old
one without a signature conflict. It signs nothing but this personal app.

Fonts: Inter (SIL OFL 1.1), see `FONT_LICENSE_Inter.txt`.
