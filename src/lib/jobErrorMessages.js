function asText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message || String(value);
  if (typeof value === "object") {
    return value.error || value.message || value.data?.error || value.data?.message || "";
  }
  return String(value);
}

function tryParseJsonText(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}$/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

export function extractProviderErrorMessage(error) {
  const candidates = [
    error?.data?.error,
    error?.data?.message,
    error?.error?.message,
    error?.error,
    error?.message,
    asText(error),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const parsed = tryParseJsonText(candidate);
    const nested = parsed?.error?.message || parsed?.message || parsed?.error;
    if (typeof nested === "string" && nested.trim()) return nested.trim();
    if (typeof candidate === "string" && candidate.trim() && !candidate.trim().startsWith("{")) return candidate.trim();
  }

  return "Background task failed.";
}

export function friendlyJobErrorMessage(error, { preserveContext = true } = {}) {
  const raw = extractProviderErrorMessage(error);
  if (/credit balance is too low|plans\s*&\s*billing|purchase credits|anthropic api/i.test(raw)) {
    return preserveContext
      ? "Anthropic credits are exhausted. Any completed checkpoints were kept; add credits, then retry or recover the saved findings."
      : "Anthropic credits are exhausted. Add credits in Anthropic Plans & Billing, then try again.";
  }
  if (/overloaded|overloaded_error|529/i.test(raw)) {
    return preserveContext
      ? "The AI provider is overloaded right now. Sarah kept any completed checkpoints; wait a minute, then retry or let the remaining queued job continue."
      : "The AI provider is overloaded right now. Wait a minute, then try again.";
  }
  if (/server restarted before this job could be resumed/i.test(raw)) {
    return "The desktop backend restarted before this job could resume. Start the task again.";
  }
  if (/cancelled/i.test(raw)) return "Cancelled.";
  return raw.replace(/\s+/g, " ").trim();
}

export function friendlyJobStatusMessage(job) {
  if (!job) return "";
  const message = job?.progress?.message || job?.error || job?.status;
  if (
    job?.status === "complete" &&
    job?.progress?.phase === "complete" &&
    !/(complete|completed|ready|finished)/i.test(String(message || ""))
  ) {
    return "Complete";
  }
  if (job?.status === "error" || job?.progress?.phase === "error") {
    return friendlyJobErrorMessage({
      message,
      error: job?.error,
      data: { error: message },
    });
  }
  return message;
}
