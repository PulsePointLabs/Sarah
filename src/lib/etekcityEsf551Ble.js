import { BleClient } from "@capacitor-community/bluetooth-le";
import { calculateEsf551BodyComposition, parseEsf551Measurement } from "@/lib/etekcityEsf551Metrics";
import { isSarahNativeShell } from "@/lib/mobileApiBase";

const ESF551_SERVICE_UUID = "0000fff0-0000-1000-8000-00805f9b34fb";
const ESF551_MEASUREMENT_UUID = "0000fff1-0000-1000-8000-00805f9b34fb";

function normalizeUuid(value) {
  return String(value || "").toLowerCase();
}

function findMeasurementService(services = []) {
  return services.find((service) => (
    service.characteristics?.some((characteristic) => (
      normalizeUuid(characteristic.uuid) === ESF551_MEASUREMENT_UUID
    ))
  ));
}

export async function readEsf551Scale({
  age,
  heightCm,
  biologicalSex,
  onStatus,
  timeoutMs = 75000,
} = {}) {
  if (!isSarahNativeShell()) {
    throw new Error("Direct ESF-551 scale capture is available in the Android APK.");
  }
  if (!Number.isFinite(Number(age)) || !Number.isFinite(Number(heightCm)) || !["male", "female"].includes(String(biologicalSex || "").toLowerCase())) {
    throw new Error("Enter age, height, and biological sex in Sarah's profile before reading the scale.");
  }

  onStatus?.("Close VeSync, wake the scale, then select Etekcity Smart Fitness Scale.");
  await BleClient.initialize({ androidNeverForLocation: true });
  if (typeof BleClient.isLocationEnabled === "function") {
    const enabled = await BleClient.isLocationEnabled().catch(() => true);
    if (!enabled) throw new Error("Turn on Android Location services so Sarah can scan for the scale.");
  }

  const device = await BleClient.requestDevice({
    optionalServices: [ESF551_SERVICE_UUID],
  });
  let serviceUuid = ESF551_SERVICE_UUID;
  let timeoutId;

  try {
    onStatus?.("Connecting directly to the ESF-551...");
    await BleClient.disconnect(device.deviceId).catch(() => {});
    await BleClient.connect(device.deviceId, undefined, { timeout: 20000 });
    const services = await BleClient.getServices(device.deviceId);
    const measurementService = findMeasurementService(services);
    if (!measurementService) {
      throw new Error("That Bluetooth device is not exposing the ESF-551 measurement channel. Select the Etekcity scale.");
    }
    serviceUuid = measurementService.uuid;

    onStatus?.("Connected. Step on barefoot and remain still until impedance is captured.");
    const measurement = await new Promise((resolve, reject) => {
      timeoutId = window.setTimeout(() => {
        reject(new Error("The scale did not send a complete body-composition reading. Keep VeSync closed, step on barefoot, and stay still through the impedance measurement."));
      }, timeoutMs);

      BleClient.startNotifications(
        device.deviceId,
        serviceUuid,
        ESF551_MEASUREMENT_UUID,
        (value) => {
          const parsed = parseEsf551Measurement(value);
          if (!parsed) return;
          if (parsed.impedance_ohms == null) {
            onStatus?.(`Stable weight ${parsed.weight_kg.toFixed(1)} kg received. Keep bare feet on all four electrodes for composition.`);
            return;
          }
          window.clearTimeout(timeoutId);
          resolve(parsed);
        },
        { timeout: 15000 },
      ).catch(reject);
    });

    const composition = calculateEsf551BodyComposition({
      weightKg: measurement.weight_kg,
      impedanceOhms: measurement.impedance_ohms,
      heightCm,
      age,
      biologicalSex,
    });
    return {
      ...composition,
      measured_at: new Date().toISOString(),
      source_app: "Etekcity ESF-551 direct BLE",
      source_package: "direct_ble",
      source_device: device.name || "Etekcity ESF-551",
      import_source: "direct_ble_esf551",
      raw_measurement: {
        transport: "bluetooth_le",
        display_unit: measurement.display_unit,
        service_uuid: serviceUuid,
        characteristic_uuid: ESF551_MEASUREMENT_UUID,
      },
    };
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
    await BleClient.stopNotifications(device.deviceId, serviceUuid, ESF551_MEASUREMENT_UUID).catch(() => {});
    await BleClient.disconnect(device.deviceId).catch(() => {});
  }
}
