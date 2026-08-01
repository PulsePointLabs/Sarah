import { apiUrl } from "@/lib/mobileApiBase";
import {
  buildConversationIntelligencePrompt,
  buildResponsePlan,
  updateConversationTopicState,
} from "@/lib/sarahConversationIntelligence";

async function jsonRequest(path, options = {}) {
  const response = await fetch(apiUrl(path), {
    cache: "no-store",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || `Request failed: ${response.status}`);
  return data;
}

export async function loadSarahConversationContext(payload = {}) {
  try {
    return await jsonRequest("/sarah-conversation/context", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  } catch (error) {
    const topicState = updateConversationTopicState({}, payload.message || "");
    const plan = buildResponsePlan({
      message: payload.message,
      topicState,
      mode: payload.mode,
      hasVisualEvidence: payload.hasVisualEvidence,
    });
    return {
      topicState,
      plan,
      memories: [],
      evidence: [],
      languageProfile: {},
      promptContext: buildConversationIntelligencePrompt({ topicState, plan }),
      degraded: true,
      error: error.message || String(error),
    };
  }
}

export function loadSarahLanguageProfile() {
  return jsonRequest("/sarah-conversation/language-profile");
}

export function saveSarahLanguageProfile(value = {}) {
  return jsonRequest("/sarah-conversation/language-profile", {
    method: "PUT",
    body: JSON.stringify(value),
  });
}
