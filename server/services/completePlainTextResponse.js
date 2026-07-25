function extractText(message = {}) {
  return (Array.isArray(message?.content) ? message.content : [])
    .map((part) => (part?.type === "text" ? part.text : ""))
    .join("\n")
    .trim();
}

function appendContinuation(existing, continuation) {
  const left = String(existing || "").trimEnd();
  const right = String(continuation || "").trimStart();
  if (!left) return right;
  if (!right) return left;
  return `${left}${/\s$/.test(existing) ? "" : " "}${right}`;
}

export async function completePlainTextResponse({
  createMessage,
  initialMessage,
  payload,
  maxContinuations = 2,
}) {
  let message = initialMessage;
  let text = extractText(message);
  let continuationCount = 0;
  const messages = [...(payload?.messages || [])];

  while (message?.stop_reason === "max_tokens" && continuationCount < maxContinuations) {
    if (!text) {
      const error = new Error("AI response reached its output limit without returning usable text.");
      error.status = 502;
      throw error;
    }

    messages.push(
      { role: "assistant", content: text },
      {
        role: "user",
        content: "Continue from the exact point where the response stopped. Start with the next word only: no preamble, no recap, and no repeated text. Finish the response cleanly within this continuation.",
      },
    );

    message = await createMessage({ ...payload, messages });
    const continuation = extractText(message);
    text = appendContinuation(text, continuation);
    continuationCount += 1;
  }

  if (message?.stop_reason === "max_tokens") {
    const error = new Error("AI response was still incomplete after automatic continuation.");
    error.status = 502;
    error.stop_reason = message.stop_reason;
    throw error;
  }

  return { text, continuationCount, stopReason: message?.stop_reason || null };
}

