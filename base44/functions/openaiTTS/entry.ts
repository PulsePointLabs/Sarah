import { corsHeaders } from "https://deno.land/x/base44@v0.5.0/mod.ts";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function clampSpeed(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0.25 && parsed <= 4
    ? parsed
    : 1.0;
}

async function callOpenAITTS(text: string, voice: string, speed: number) {
  let lastStatus = 500;
  let lastMessage = "Unknown TTS error";

  // Keep this short. Base44/serverless isolates can die if one request hangs too long.
  const MAX_ATTEMPTS = 3;
  const FETCH_TIMEOUT_MS = 25_000;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini-tts",
          input: text,
          voice,
          response_format: "mp3",
          speed,
        }),
      });

      clearTimeout(timeout);

      if (response.ok) {
        return response;
      }

      lastStatus = response.status;
      lastMessage = await response.text();

      const retryable = [408, 429, 500, 502, 503, 504].includes(response.status);

      if (!retryable) {
        throw new Error(lastMessage);
      }

      if (attempt === MAX_ATTEMPTS - 1) break;

      const retryAfter = response.headers.get("retry-after");
      const waitMs = retryAfter
        ? Math.min(Math.max(Number(retryAfter) * 1000, 1000), 4000)
        : Math.min(750 * 2 ** attempt, 4000) + Math.floor(Math.random() * 300);

      console.log(
        `OpenAI TTS ${response.status}, backend retry ${attempt + 1}/${MAX_ATTEMPTS} in ${waitMs}ms`
      );

      await sleep(waitMs);
    } catch (error) {
      clearTimeout(timeout);

      lastMessage = error instanceof Error ? error.message : String(error);

      console.log(
        `OpenAI TTS exception, backend retry ${attempt + 1}/${MAX_ATTEMPTS}:`,
        lastMessage
      );

      if (attempt === MAX_ATTEMPTS - 1) break;

      const waitMs = Math.min(750 * 2 ** attempt, 4000);
      await sleep(waitMs);
    }
  }

  throw new Error(
    `OpenAI TTS failed after backend retries. Status: ${lastStatus}. ${lastMessage}`
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  try {
    if (!OPENAI_API_KEY) {
      return jsonResponse({ error: "Missing OPENAI_API_KEY" }, 500);
    }

    const body = await req.json();

    const text = String(body.text || "").trim();
    const voice = String(body.voice || "alloy");
    const speed = clampSpeed(body.speed);

    if (!text) {
      return jsonResponse({ error: "Missing text" }, 400);
    }

    if (text.length > 2500) {
      return jsonResponse(
        {
          error: "Text chunk too large",
          length: text.length,
          maxLength: 2500,
        },
        413
      );
    }

    const ttsResponse = await callOpenAITTS(text, voice, speed);
    const audioBuffer = await ttsResponse.arrayBuffer();

    return new Response(audioBuffer, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "audio/mpeg",
        "Content-Length": String(audioBuffer.byteLength),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    console.error("openaiTTS failed:", message);

    return jsonResponse(
      {
        error: "TTS generation failed",
        message,
        retryable: true,
        upstream: "openai",
      },
      502
    );
  }
});