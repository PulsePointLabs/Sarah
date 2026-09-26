# Telemetry and EMG in 0.1.267

Full telemetry uses one viewport grid. Tap or click a card to move it or resize it; the other cards repack and the contents scale to fit. Small screens or many enabled items necessarily use smaller text. Threshold Load Matrix and Respiratory & Somatic Response are independent cards.

The title, wall clock and elapsed session time stay visible. Move the pointer into the header to reveal controls, or tap **Controls**. Use **Choose items** for panel visibility and **Reset default** to clear custom sizing/order.

## EMG

1. Install the Arduino sketch once. The existing sketch sends `A0,A1` at 115200 baud; connect the sensors' ENV outputs to those respective inputs. Close Serial Monitor.
2. In Live Capture select **Connect EMG**, choose one or two sensors, and connect. A sole available serial port is selected automatically. The Arduino connects to the desktop even when Sarah is viewed on a phone.
3. Name each sensor location. Watch the live meters, then follow **Relax → Contract sensor 1 → Contract sensor 2 → Save**. Each step waits for acknowledgement from the acquisition helper. One-sensor mode skips sensor 2 and accepts either the original single-value sketch or the A0 column of the dual sketch.
4. Leave the desktop running. Live readings are available before recording; CSV recording follows primary OBS. Existing CSV column names remain unchanged. Sensor names are display preferences saved on this device.

Python is a desktop prerequisite. **One-time Arduino / helper setup → Install helper dependencies** installs packages into a dedicated environment in Sarah's EMG folder. This downloads software packages, not sensor data. No terminal is needed for normal monitoring or calibration.

## Windows patch

The Android APK supplies the new UI. Managed EMG also needs the 0.1.267 desktop backend. Extract the matching Windows patch ZIP and double-click **Apply-SarahPatch.cmd**. It verifies payload hashes, refuses an active capture, backs up replaced app files, updates the default 0.1.266 installation and checks the restarted backend. It does not replace session data or calibration files. For a different installation folder, invoke the included PowerShell script with `-InstallDirectory`.

Validation covers browser layout and simulated serial input. Physical Arduino, H10 and phone validation is still required. The Windows apply script is supplied for manual execution; automatic application was blocked in the build session.

## Display refinements in 0.1.268

Every metric, including Respiration, Chest Motion and the new SDNN card, has an independent checkbox under **Controls → Choose items**. Selecting any card exposes **Hide card**; restore it from Choose items. Visibility choices persist on this device.

Phase statistics expand into the available vertical space. Changing status text uses reserved, locally fitted text areas, leaving values and plotting areas anchored. The elapsed session timer uses the same font size as the wall clock.
