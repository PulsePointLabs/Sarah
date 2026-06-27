function safeText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message || String(value);
  if (typeof value === "object") {
    return [
      value.message,
      value.error?.message,
      value.error,
      value.data?.error?.message,
      value.data?.error,
      value.data?.message,
      value.response?.data?.error?.message,
      value.response?.data?.message,
    ].filter(Boolean).join(" ");
  }
  return String(value);
}

function parseJsonTail(value) {
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

function nestedStrings(value, out = []) {
  if (value == null) return out;
  if (typeof value === "string") {
    out.push(value);
    const parsed = parseJsonTail(value);
    if (parsed) nestedStrings(parsed, out);
    return out;
  }
  if (value instanceof Error) {
    out.push(value.message || String(value));
    nestedStrings(value.cause, out);
    return out;
  }
  if (typeof value === "object") {
    for (const key of ["type", "code", "message", "error", "status", "statusText"]) {
      if (value[key] != null) nestedStrings(value[key], out);
    }
    nestedStrings(value.data, out);
    nestedStrings(value.response?.data, out);
    nestedStrings(value.body, out);
  }
  return out;
}

export function extractProviderErrorMessage(error) {
  const strings = nestedStrings(error).map((item) => String(item || "").trim()).filter(Boolean);
  for (const text of strings) {
    const parsed = parseJsonTail(text);
    const nested = parsed?.error?.message || parsed?.message || parsed?.error;
    if (typeof nested === "string" && nested.trim()) return nested.trim();
  }
  return strings.find((text) => !text.startsWith("{")) || safeText(error) || "Provider request failed.";
}

function httpStatus(error) {
  const raw = error?.status || error?.statusCode || error?.response?.status || error?.data?.status;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function providerName(error, fallback = "unknown") {
  const text = nestedStrings(error).join(" ").toLowerCase();
  if (/anthropic|claude/.test(text)) return "anthropic";
  if (/openai|whisper|nova|gpt|tts-1|insufficient_quota/.test(text)) return "openai";
  return fallback;
}

function providerLabel(provider = "unknown") {
  if (provider === "anthropic") return "Anthropic";
  if (provider === "openai") return "OpenAI";
  return "The AI provider";
}

function providerCode(error) {
  const candidates = [
    error?.code,
    error?.type,
    error?.error?.code,
    error?.error?.type,
    error?.data?.code,
    error?.data?.type,
    error?.data?.error?.code,
    error?.data?.error?.type,
    error?.response?.data?.error?.code,
    error?.response?.data?.error?.type,
  ];
  return candidates.find(Boolean) || null;
}

export function classifyProviderError(error, options = {}) {
  const message = extractProviderErrorMessage(error);
  const haystack = nestedStrings(error).concat(message).join(" ").toLowerCase();
  const status = httpStatus(error);
  const code = providerCode(error);
  const provider = options.provider || providerName(error, options.defaultProvider || "unknown");
  let category = "unknown_provider_error";
  let retryable = false;
  let nextAction = "review_error";
  let userMessage = "The AI provider failed. Sarah preserved any completed checkpoints.";

  if (/insufficient_quota|credit balance is too low|insufficient credits?|no available credits?|billing balance|billing limit|spending limit|usage limit|quota exceeded|exceeded your current quota|purchase credits|plans\s*&\s*billing|account has no available credits/.test(haystack)) {
    category = "insufficient_credits";
    nextAction = "add_provider_credits_then_retry_final_only";
    userMessage = `${providerLabel(provider)} credits or quota are unavailable. Completed checkpoints were preserved; add credits or update billing, then retry only the failed stage.`;
  } else if (/invalid api key|incorrect api key|unauthorized|authentication|auth failed|permission denied/.test(haystack) || status === 401 || status === 403) {
    category = /invalid api key|incorrect api key/.test(haystack) ? "invalid_api_key" : "authentication_failure";
    nextAction = "fix_provider_configuration";
    userMessage = "Provider authentication failed. Check the configured API key before retrying.";
  } else if (/rate.?limit|too many requests/.test(haystack) || status === 429) {
    category = "rate_limit";
    retryable = true;
    nextAction = "retry_after_delay";
    userMessage = "The AI provider rate-limited the request. Sarah preserved completed checkpoints.";
  } else if (/overloaded|provider unavailable|service unavailable|temporarily unavailable/.test(haystack) || [500, 502, 503, 504, 529].includes(status)) {
    category = "provider_unavailable";
    retryable = true;
    nextAction = "retry_after_delay";
    userMessage = "The AI provider is temporarily unavailable. Sarah preserved completed checkpoints.";
  } else if (/timeout|timed out|aborted/.test(haystack) || status === 408) {
    category = "timeout";
    retryable = true;
    nextAction = "retry_after_delay";
    userMessage = "The AI provider timed out. Sarah preserved completed checkpoints.";
  } else if (/context.*too.*large|prompt.*too.*long|maximum context|context length/.test(haystack)) {
    category = "context_too_large";
    nextAction = "reduce_or_reuse_evidence";
    userMessage = "The AI request was too large. Sarah should reuse completed evidence and send a smaller final synthesis packet.";
  } else if (/cut off|max_tokens|truncated|output.*too.*long/.test(haystack)) {
    category = "output_truncation";
    retryable = true;
    nextAction = "retry_with_smaller_output";
    userMessage = "The AI response was cut off. Sarah preserved completed checkpoints.";
  } else if (/malformed json|invalid json|structured response|schema/.test(haystack)) {
    category = "malformed_structured_response";
    retryable = true;
    nextAction = "retry_same_stage";
    userMessage = "The AI response was not valid structured output. Sarah preserved completed checkpoints.";
  } else if (/content[_ -]?policy|safety[_ -]?refusal|request\s+(?:was\s+)?refused|provider\s+(?:has\s+)?refused|policy\s+violation|\brefusal\b/.test(haystack)) {
    category = "safety_refusal";
    nextAction = "review_request_scope";
    userMessage = "The AI provider refused this request. Sarah preserved completed checkpoints.";
  } else if (/network|econnreset|enotfound|econnrefused|socket|fetch failed/.test(haystack)) {
    category = "network_failure";
    retryable = true;
    nextAction = "retry_after_connection_recovers";
    userMessage = "The network failed during the provider request. Sarah preserved completed checkpoints.";
  }

  return {
    provider,
    model: options.model || error?.model || null,
    category,
    code: code || (status ? String(status) : null),
    retryable,
    user_message: userMessage,
    technical_message: message
      .replace(/sk-[a-z0-9_-]{8,}/gi, "[redacted_key]")
      .replace(/\s+/g, " ")
      .trim(),
    request_stage: options.requestStage || options.phase || null,
    job_id: options.jobId || null,
    occurred_at: options.occurredAt || new Date().toISOString(),
    preserved_artifacts: options.preservedArtifacts || [],
    next_action: nextAction,
  };
}

export function shouldRetryProviderError(error, options = {}) {
  return classifyProviderError(error, options).retryable;
}
