import { classifyProviderError, extractProviderErrorMessage } from "./providerErrorClassifier.js";

export { extractProviderErrorMessage };

export function friendlyJobErrorMessage(error, { preserveContext = true, defaultProvider = "anthropic", provider } = {}) {
  const classified = classifyProviderError(error, { defaultProvider, provider });
  if (classified.category === "insufficient_credits") {
    const provider = classified.provider === "openai" ? "OpenAI" : classified.provider === "anthropic" ? "Anthropic" : "AI provider";
    return preserveContext
      ? `${provider} credits or quota are unavailable. Completed checkpoints were preserved; add credits or update billing, then retry only the failed stage.`
      : `${provider} credits or quota are unavailable. Add credits or update billing, then try again.`;
  }
  if (classified.category === "provider_unavailable") {
    return preserveContext
      ? "The AI provider is temporarily unavailable. Sarah kept any completed checkpoints; wait a minute, then retry only the failed stage."
      : "The AI provider is temporarily unavailable. Wait a minute, then try again.";
  }
  if (classified.category === "rate_limit") {
    return preserveContext
      ? "The AI provider rate-limited the request. Sarah kept any completed checkpoints; retry after the limit cools down."
      : "The AI provider rate-limited the request. Wait, then try again.";
  }
  if (classified.category === "invalid_api_key" || classified.category === "authentication_failure") {
    return "Provider authentication failed. Check the configured API key before retrying.";
  }
  if (classified.category === "timeout") return "The AI provider timed out. Sarah preserved completed checkpoints.";
  if (classified.category === "context_too_large") return "The AI request was too large. Reuse completed evidence and retry final synthesis with a smaller packet.";
  if (classified.category === "output_truncation") return "The AI response was cut off before it finished. Sarah preserved completed checkpoints.";
  if (classified.category === "malformed_structured_response") return "The AI response was not valid structured output. Sarah preserved completed checkpoints.";
  if (classified.category === "safety_refusal") return "The AI provider refused this request. Sarah preserved completed checkpoints.";
  const raw = extractProviderErrorMessage(error);
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

export function providerErrorCategory(error) {
  return classifyProviderError(error, { defaultProvider: "anthropic" }).category;
}
