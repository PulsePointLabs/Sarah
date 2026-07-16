export const STT_PROVIDER_STORAGE_KEY = "sarah.sttProvider";

export const STT_PROVIDER_OPTIONS = [
  {
    value: "auto",
    label: "Auto",
    helper: "Use Groq when it is configured on the backend; otherwise fall back to OpenAI.",
  },
  {
    value: "groq",
    label: "Groq",
    helper: "Prefer Groq for speech to text. Requires GROQ_API_KEY on the local Sarah backend.",
  },
  {
    value: "openai",
    label: "OpenAI",
    helper: "Always use OpenAI transcription for mic input.",
  },
];

export function normalizeSttProvider(value) {
  const normalized = String(value || "auto").trim().toLowerCase();
  return STT_PROVIDER_OPTIONS.some((option) => option.value === normalized) ? normalized : "auto";
}

export function readSttProviderPreference(storage = globalThis?.localStorage) {
  try {
    return normalizeSttProvider(storage?.getItem?.(STT_PROVIDER_STORAGE_KEY) || "auto");
  } catch {
    return "auto";
  }
}

export function saveSttProviderPreference(value, storage = globalThis?.localStorage) {
  const normalized = normalizeSttProvider(value);
  try {
    storage?.setItem?.(STT_PROVIDER_STORAGE_KEY, normalized);
  } catch {
    // Keep the normalized value in memory even if storage is unavailable.
  }
  globalThis?.window?.dispatchEvent?.(new CustomEvent("sarah:stt-provider", { detail: normalized }));
  return normalized;
}
