function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeActivity(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\.[A-Z0-9]+$/i, "")
    .replace(/[^A-Z0-9]+/g, "");
}

function statusPower(statusData, channel) {
  const options = statusData?.options || {};
  return channel === 1 ? finite(options.power_b) : finite(options.power_a);
}

function statusActivity(statusData) {
  return normalizeActivity(
    statusData?.player?.title
      || statusData?.player?.filename
      || statusData?.player?.file
      || statusData?.activity?.name
      || statusData?.activity_name,
  );
}

function commandChannel(command) {
  const value = String(command?.channel || "a").toLowerCase();
  return value === "b" || value === "1" ? 1 : 0;
}

function requestedPower(command) {
  return finite(command?.intensity);
}

function reconciliationFor(command, statusData) {
  if (["set_power", "set_intensity", "set_state"].includes(command.action)) {
    const requested = requestedPower(command);
    const applied = statusPower(statusData, commandChannel(command));
    return {
      result: applied == null ? "unverified" : applied === requested ? "applied" : "mismatch",
      requested: { power: requested, channel: command.channel },
      applied: { power: applied, channel: command.channel },
    };
  }
  if (command.action === "load_activity") {
    const requested = normalizeActivity(command.activity_name);
    const applied = statusActivity(statusData);
    return {
      result: !applied ? "unverified" : applied.includes(requested) || requested.includes(applied) ? "applied" : "mismatch",
      requested: { activity: command.activity_name },
      applied: { activity: applied || null },
    };
  }
  if (["set_mute", "stop", "emergency_stop"].includes(command.action)) {
    const mute = statusData?.options?.mute;
    return {
      result: mute === true ? "applied" : mute == null ? "unverified" : "mismatch",
      requested: { mute: true },
      applied: { mute: mute ?? null },
    };
  }
  return { result: "unverified", requested: {}, applied: {} };
}

export function ceilingViolation(statusData, ceiling) {
  const limit = finite(ceiling, 0);
  const powerA = statusPower(statusData, 0);
  const powerB = statusPower(statusData, 1);
  return [powerA, powerB].some((power) => power != null && power > limit);
}

export async function executeReconciledHowlCommand({
  command,
  settings,
  request,
  commandRequest,
  clock = () => performance.now(),
  log = () => {},
}) {
  const startedAt = clock();
  const records = [];
  const writeLog = (event, details = {}) => {
    const record = { event, commandId: command.id, action: command.action, at: clock(), ...details };
    records.push(record);
    log(record);
  };
  writeLog("requested_command", {
    requested: {
      activity: command.activity_name || null,
      channel: command.channel,
      intensity: command.intensity,
    },
  });

  let commandResult = null;
  let commandError = null;
  try {
    commandResult = await request(settings, commandRequest.endpoint, commandRequest.body);
    writeLog("applied_command_response", { status: commandResult.status });
  } catch (error) {
    commandError = error;
    writeLog("command_error", { status: error?.status || null, error: error?.message || String(error) });
  }

  let statusResult;
  try {
    statusResult = await request(settings, "/status", {}, { timeoutMs: 3000 });
    writeLog("howl_status_response", {
      status: statusResult.status,
      powerA: statusPower(statusResult.data, 0),
      powerB: statusPower(statusResult.data, 1),
      activity: statusActivity(statusResult.data) || null,
    });
  } catch (statusError) {
    writeLog("status_error", { status: statusError?.status || null, error: statusError?.message || String(statusError) });
    writeLog("command_latency", { latencyMs: Math.max(0, clock() - startedAt) });
    return {
      sent: Boolean(commandResult),
      commandTimedOut: commandError?.status === 504,
      reconciliation: { result: "unresolved", requested: {}, applied: {} },
      latencyMs: Math.max(0, clock() - startedAt),
      statusData: null,
      logs: records,
      error: commandError?.message || statusError?.message || "Howl status reconciliation failed.",
      safetyAction: null,
    };
  }

  if (ceilingViolation(statusResult.data, settings.intensityCeiling)) {
    writeLog("ceiling_violation", {
      ceiling: settings.intensityCeiling,
      powerA: statusPower(statusResult.data, 0),
      powerB: statusPower(statusResult.data, 1),
    });
    let muteStatus = "failed";
    try {
      await request(settings, "/set_mute", { value: true });
      muteStatus = "sent";
    } catch (error) {
      writeLog("safety_mute_error", { error: error?.message || String(error) });
    }
    writeLog("safety_action", { action: "mute_disarm", muteStatus });
    writeLog("command_latency", { latencyMs: Math.max(0, clock() - startedAt) });
    return {
      sent: Boolean(commandResult),
      commandTimedOut: commandError?.status === 504,
      reconciliation: { result: "ceiling_violation", requested: {}, applied: {} },
      latencyMs: Math.max(0, clock() - startedAt),
      statusData: statusResult.data,
      logs: records,
      error: "Howl reported power above Sarah's configured ceiling.",
      safetyAction: "mute_disarm",
    };
  }

  const reconciliation = reconciliationFor(command, statusResult.data);
  writeLog("reconciliation_result", reconciliation);
  writeLog("command_latency", { latencyMs: Math.max(0, clock() - startedAt) });
  return {
    sent: Boolean(commandResult) || reconciliation.result === "applied",
    commandTimedOut: commandError?.status === 504,
    reconciliation,
    latencyMs: Math.max(0, clock() - startedAt),
    statusData: statusResult.data,
    logs: records,
    error: reconciliation.result === "mismatch"
      ? "Howl status did not match the requested command."
      : commandError && reconciliation.result !== "applied"
        ? commandError.message
        : null,
    safetyAction: null,
  };
}
