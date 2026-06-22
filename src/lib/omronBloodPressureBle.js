import { BleClient } from "@capacitor-community/bluetooth-le";

const BLOOD_PRESSURE_SERVICE_UUID = "00001810-0000-1000-8000-00805f9b34fb";
const BLOOD_PRESSURE_MEASUREMENT_UUID = "00002a35-0000-1000-8000-00805f9b34fb";
const CURRENT_TIME_SERVICE_UUID = "00001805-0000-1000-8000-00805f9b34fb";
const BATTERY_SERVICE_UUID = "0000180f-0000-1000-8000-00805f9b34fb";
const DEVICE_INFORMATION_SERVICE_UUID = "0000180a-0000-1000-8000-00805f9b34fb";

let activeOmronListener = null;

function dataViewFromValue(value) {
  if (value instanceof DataView) return value;
  if (value instanceof ArrayBuffer) return new DataView(value);
  if (value?.buffer instanceof ArrayBuffer) {
    return new DataView(value.buffer, value.byteOffset || 0, value.byteLength || value.buffer.byteLength);
  }
  throw new Error("OMRON sent a BP packet in an unsupported Bluetooth value format.");
}

function bytesFromDataView(view) {
  return Array.from({ length: view.byteLength }, (_, index) => view.getUint8(index));
}

function decodeSfloat(raw) {
  if (raw === 0x07ff || raw === 0x0800 || raw === 0x0801 || raw === 0x0802) return null;
  const mantissaRaw = raw & 0x0fff;
  const exponentRaw = (raw >> 12) & 0x000f;
  const mantissa = mantissaRaw >= 0x0800 ? mantissaRaw - 0x1000 : mantissaRaw;
  const exponent = exponentRaw >= 0x0008 ? exponentRaw - 0x0010 : exponentRaw;
  const value = mantissa * (10 ** exponent);
  return Number.isFinite(value) ? value : null;
}

function readSfloat(view, offset) {
  return decodeSfloat(view.getUint16(offset, true));
}

function roundMmHg(value, unitsAreKpa) {
  if (value == null) return null;
  const mmHg = unitsAreKpa ? value * 7.50062 : value;
  return Math.round(mmHg);
}

function readTimestamp(view, offset) {
  const year = view.getUint16(offset, true);
  const month = view.getUint8(offset + 2);
  const day = view.getUint8(offset + 3);
  const hour = view.getUint8(offset + 4);
  const minute = view.getUint8(offset + 5);
  const second = view.getUint8(offset + 6);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day, hour || 0, minute || 0, second || 0).toISOString();
}

function stableOmronId({ deviceId, measuredAt, systolic, diastolic, pulse }) {
  return [
    "omron-ble",
    String(deviceId || "device").replace(/[^a-z0-9_.:-]+/gi, "-").slice(0, 50),
    String(measuredAt || new Date().toISOString()).replace(/[^0-9TZ]/g, ""),
    systolic ?? "sys",
    diastolic ?? "dia",
    pulse ?? "pulse",
  ].join("-");
}

function summarizeServices(services = []) {
  return services.map((service) => ({
    uuid: service.uuid,
    characteristics: (service.characteristics || []).map((characteristic) => ({
      uuid: characteristic.uuid,
      properties: characteristic.properties || {},
    })),
  }));
}

async function initializeAndroidBle(onStatus) {
  if (!window.Capacitor?.isNativePlatform?.()) {
    throw new Error("Direct OMRON BP sync currently needs the installed Android APK. Use the phone to sync; desktop will read the saved PulsePoint BP record.");
  }

  onStatus?.("Press the BP7000 Bluetooth/Transfer button once until the O flashes, then select the OMRON device in the picker.");
  await BleClient.initialize({ androidNeverForLocation: true });

  if (typeof BleClient.isLocationEnabled === "function") {
    const enabled = await BleClient.isLocationEnabled().catch(() => true);
    if (!enabled) {
      throw new Error("Android Location services are off. Turn Location on, then try OMRON sync again so Android can scan for BLE devices.");
    }
  }
}

async function requestOmronDevice(onStatus) {
  const pickerOptions = {
    services: [BLOOD_PRESSURE_SERVICE_UUID],
    optionalServices: [
      BLOOD_PRESSURE_SERVICE_UUID,
      CURRENT_TIME_SERVICE_UUID,
      BATTERY_SERVICE_UUID,
      DEVICE_INFORMATION_SERVICE_UUID,
    ],
  };

  try {
    return await BleClient.requestDevice(pickerOptions);
  } catch (error) {
    if (/cancel|dismiss|denied/i.test(error?.message || "")) throw error;
    onStatus?.("Android did not advertise the BP service. Trying common OMRON/BLEsmart device names...");
    const namePrefixes = ["BLEsmart", "OMRON", "BP7000", "Evolv", "HEM"];
    let lastError = error;
    for (const namePrefix of namePrefixes) {
      try {
        return await BleClient.requestDevice({
          namePrefix,
          optionalServices: pickerOptions.optionalServices,
        });
      } catch (fallbackError) {
        lastError = fallbackError;
        if (/cancel|dismiss|denied/i.test(fallbackError?.message || "")) throw fallbackError;
      }
    }
    throw lastError;
  }
}

export function parseBloodPressureMeasurement(value, device = {}) {
  const view = dataViewFromValue(value);
  if (view.byteLength < 7) throw new Error("OMRON BP packet was too short to contain systolic/diastolic values.");

  const flags = view.getUint8(0);
  const unitsAreKpa = Boolean(flags & 0x01);
  const hasTimestamp = Boolean(flags & 0x02);
  const hasPulse = Boolean(flags & 0x04);
  const hasUserId = Boolean(flags & 0x08);
  const hasMeasurementStatus = Boolean(flags & 0x10);

  let offset = 1;
  const systolic = roundMmHg(readSfloat(view, offset), unitsAreKpa);
  offset += 2;
  const diastolic = roundMmHg(readSfloat(view, offset), unitsAreKpa);
  offset += 2;
  const meanArterialPressure = roundMmHg(readSfloat(view, offset), unitsAreKpa);
  offset += 2;

  let measuredAt = new Date().toISOString();
  if (hasTimestamp && view.byteLength >= offset + 7) {
    measuredAt = readTimestamp(view, offset) || measuredAt;
    offset += 7;
  }

  let pulseBpm = null;
  if (hasPulse && view.byteLength >= offset + 2) {
    const pulse = readSfloat(view, offset);
    pulseBpm = pulse == null ? null : Math.round(pulse);
    offset += 2;
  }

  let userId = null;
  if (hasUserId && view.byteLength >= offset + 1) {
    userId = view.getUint8(offset);
    offset += 1;
  }

  let measurementStatus = null;
  if (hasMeasurementStatus && view.byteLength >= offset + 2) {
    measurementStatus = view.getUint16(offset, true);
  }

  if (systolic == null || diastolic == null) {
    throw new Error("OMRON BP packet did not contain usable systolic/diastolic values.");
  }

  const deviceName = device?.name || device?.displayName || "OMRON BP7000";
  const deviceId = device?.deviceId || device?.id || "";
  return {
    measured_at: measuredAt,
    systolic_mm_hg: systolic,
    diastolic_mm_hg: diastolic,
    pulse_bpm: pulseBpm,
    source_app: "OMRON BP7000 direct BLE",
    source_device: deviceName,
    source_package: "direct_ble",
    body_position: "unknown",
    measurement_location: "upper_arm",
    external_id: stableOmronId({ deviceId, measuredAt, systolic, diastolic, pulse: pulseBpm }),
    raw: {
      transport: "bluetooth_le",
      service_uuid: BLOOD_PRESSURE_SERVICE_UUID,
      characteristic_uuid: BLOOD_PRESSURE_MEASUREMENT_UUID,
      flags,
      units: unitsAreKpa ? "kPa" : "mmHg",
      mean_arterial_pressure_mm_hg: meanArterialPressure,
      user_id: userId,
      measurement_status: measurementStatus,
      bytes: bytesFromDataView(view),
    },
  };
}

export async function startOmronBloodPressureListener({
  onStatus,
  onReading,
  onDisconnect,
  onError,
} = {}) {
  await stopOmronBloodPressureListener().catch(() => {});
  await initializeAndroidBle(onStatus);

  const device = await requestOmronDevice(onStatus);

  const deviceId = device?.deviceId;
  if (!deviceId) throw new Error("Android Bluetooth picker did not return a usable OMRON device id.");

  try {
    onStatus?.("Connecting to OMRON BP7000...");
    await BleClient.disconnect(deviceId).catch(() => {});
    await BleClient.connect(deviceId, () => {
      const listener = activeOmronListener;
      if (listener?.deviceId === deviceId) activeOmronListener = null;
      onStatus?.("OMRON BP7000 disconnected.");
      onDisconnect?.({ device });
    }, { timeout: 20000 });

    const services = await BleClient.getServices(deviceId).catch(() => []);
    const serviceSummary = summarizeServices(services);
    const bpService = serviceSummary.find((service) => service.uuid?.toLowerCase() === BLOOD_PRESSURE_SERVICE_UUID);
    const measurement = bpService?.characteristics?.find((characteristic) => characteristic.uuid?.toLowerCase() === BLOOD_PRESSURE_MEASUREMENT_UUID);
    if (bpService && measurement && !measurement.properties?.notify && !measurement.properties?.indicate) {
      throw new Error("The OMRON BP measurement characteristic is present, but it is not advertising notify/indicate support.");
    }

    onStatus?.("Connected and listening. Take a BP reading or press the BP7000 Bluetooth/Transfer button once until the O flashes.");

    await BleClient.startNotifications(
      deviceId,
      BLOOD_PRESSURE_SERVICE_UUID,
      BLOOD_PRESSURE_MEASUREMENT_UUID,
      (value) => {
        try {
          const parsed = parseBloodPressureMeasurement(value, device);
          onStatus?.(`Received OMRON reading ${parsed.systolic_mm_hg}/${parsed.diastolic_mm_hg} mmHg.`);
          onReading?.(parsed, { device, services: serviceSummary });
        } catch (error) {
          onError?.(error);
        }
      },
      { timeout: 15000 },
    );

    activeOmronListener = {
      deviceId,
      device,
      startedAt: new Date().toISOString(),
      services: serviceSummary,
    };

    return { ok: true, device, services: serviceSummary };
  } catch (error) {
    await BleClient.disconnect(deviceId).catch(() => {});
    throw error;
  }
}

export async function stopOmronBloodPressureListener() {
  const listener = activeOmronListener;
  activeOmronListener = null;
  if (!listener?.deviceId) return { ok: true, stopped: false };
  await BleClient.stopNotifications(listener.deviceId, BLOOD_PRESSURE_SERVICE_UUID, BLOOD_PRESSURE_MEASUREMENT_UUID).catch(() => {});
  await BleClient.disconnect(listener.deviceId).catch(() => {});
  return { ok: true, stopped: true, device: listener.device };
}

export function getOmronBloodPressureListenerState() {
  return activeOmronListener
    ? {
      listening: true,
      deviceName: activeOmronListener.device?.name || "OMRON BP7000",
      startedAt: activeOmronListener.startedAt,
      services: activeOmronListener.services,
    }
    : { listening: false };
}

export async function readOmronBloodPressureOnce({ timeoutMs = 60000, onStatus } = {}) {
  let settled = false;
  let timer = null;
  return new Promise((resolve, reject) => {
    timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      stopOmronBloodPressureListener().finally(() => {
        reject(new Error("Timed out waiting for the OMRON BP measurement. Leave Sarah listening, take a fresh reading, or press the cuff Bluetooth/Transfer button once until the O flashes."));
      });
    }, timeoutMs);

    startOmronBloodPressureListener({
      onStatus,
      onReading: (reading, context) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        stopOmronBloodPressureListener().finally(() => resolve({ ok: true, reading, ...context }));
      },
      onDisconnect: () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        reject(new Error("OMRON BP7000 disconnected before it sent a measurement."));
      },
      onError: (error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        stopOmronBloodPressureListener().finally(() => reject(error));
      },
    }).catch((error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      reject(error);
    });
  });
}
