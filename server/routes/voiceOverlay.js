import express from 'express';
import crypto from 'node:crypto';
import { getEntity, listEntities, upsertEntity } from '../db.js';
import { aiInvokeInternal } from './internalAi.js';
import { transcribeAudioWithProvider } from '../services/sttProvider.js';
import { normalizeSttAudio } from '../services/sttAudio.js';
import { synthesizeTTSChunk, TTS_CONTENT_TYPES } from '../services/ttsCore.js';
import { buildRecentSessionActivityContext } from '../../src/lib/recentSessionActivity.js';
import {
  buildSarahPersonalityPrompt,
  normalizeSarahPersonalitySettings,
} from '../../src/utils/sarahPersonality.js';
import { buildIntimateChatTonePrompt } from '../../src/lib/intimateChatTone.js';
import { normalizeIntimateReflectionSettings } from '../../src/lib/intimateReflection.js';
import { classifyProviderError } from '../../src/lib/providerErrorClassifier.js';
import { prepareSarahConversationContext } from '../services/sarahConversationContext.js';

export const voiceOverlayRouter = express.Router();

function decodeAudio(value) {
  return Buffer.from(String(value || '').replace(/^data:.*?;base64,/, ''), 'base64');
}

function cleanMessageText(value, maxChars = 12_000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

function recentRecords(entity, limit = 8) {
  return listEntities(entity)
    .sort((a, b) => new Date(b?.date || b?.created_date || 0) - new Date(a?.date || a?.created_date || 0))
    .slice(0, limit);
}

function profileContext(profile = {}) {
  const preferred = Array.isArray(profile.preferred_stimulation) ? profile.preferred_stimulation.join(', ') : '';
  const findings = Array.isArray(profile.profile_qa_findings)
    ? profile.profile_qa_findings.slice(0, 16).map((item) => (
      item?.finding || item?.findings?.join?.('; ') || ''
    )).filter(Boolean).join('\n')
    : '';
  return [
    `First name: ${profile.first_name || 'Ben'}`,
    `Age: ${profile.age ?? 'not set'}`,
    `Fitness level: ${profile.fitness_level || 'not set'}`,
    `Resting HR: ${profile.resting_hr ?? 'not set'} bpm; max HR: ${profile.max_hr ?? 'not set'} bpm`,
    `Arousal response style: ${cleanMessageText(profile.arousal_response_style, 900) || 'not set'}`,
    `Typical build duration: ${cleanMessageText(profile.typical_build_duration, 500) || 'not set'}`,
    `Climax sensitivity: ${cleanMessageText(profile.climax_sensitivity, 700) || 'not set'}`,
    `Refractory pattern: ${cleanMessageText(profile.refractory_pattern, 700) || 'not set'}`,
    `Preferred stimulation: ${preferred || 'not set'}`,
    `Arousal notes: ${cleanMessageText(profile.arousal_notes, 1800) || 'none'}`,
    findings ? `User-verified Profile Q&A findings:\n${findings}` : null,
  ].filter(Boolean).join('\n');
}

function promptHistory(messages = []) {
  return messages.slice(-8).map((message) => (
    `${message.role === 'assistant' ? 'Sarah' : 'Ben'}: ${cleanMessageText(message.text, 1800)}`
  )).join('\n');
}

function parseSettings(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  try {
    return JSON.parse(String(value || '')) || fallback;
  } catch {
    return fallback;
  }
}

function speechSegments(text = "", maxChars = 520) {
  const sentences = String(text || "").match(/[^.!?]+(?:[.!?]+|$)/g) || [String(text || "")];
  const chunks = [];
  let current = "";
  for (const sentence of sentences.map((item) => item.trim()).filter(Boolean)) {
    if (current && `${current} ${sentence}`.length > maxChars) {
      chunks.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) chunks.push(current);
  return chunks.slice(0, 16);
}

async function synthesizeSpeechSegments(text, tts, requestId) {
  const chunks = speechSegments(text);
  const rendered = await Promise.all(chunks.map((chunk, index) => synthesizeTTSChunk({
    text: chunk,
    ...tts,
    meta: {
      source: 'voice_overlay_tts_segment',
      idempotencyKey: `${requestId}:tts:${index}`,
    },
  })));
  return rendered.map((speech, index) => ({
    index,
    text: chunks[index],
    audio_base64: speech.buffer.toString('base64'),
    audio_mime_type: TTS_CONTENT_TYPES[speech.format],
  }));
}

export function normalizeVoiceOverlayTtsRuntime(value) {
  const settings = parseSettings(value);
  const model = ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'].includes(settings.model)
    ? settings.model
    : 'gpt-4o-mini-tts';
  const format = ['mp3', 'wav', 'opus', 'aac', 'flac', 'pcm'].includes(settings.format)
    ? settings.format
    : 'mp3';
  const speed = Number(settings.speed);
  return {
    voice: ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'].includes(settings.voice)
      ? settings.voice
      : 'nova',
    model,
    format,
    speed: Number.isFinite(speed) ? Math.max(0.25, Math.min(4, speed)) : 0.96,
    instructions: model === 'gpt-4o-mini-tts' ? cleanMessageText(settings.instructions, 8_000) : '',
  };
}

voiceOverlayRouter.post('/turn', async (req, res) => {
  const requestId = cleanMessageText(req.body?.request_id, 120) || crypto.randomUUID();
  let stage = 'transcription';
  try {
    const tts = normalizeVoiceOverlayTtsRuntime(req.body?.tts_settings);
    const sourceAudio = decodeAudio(req.body?.audio_base64);
    const normalizedAudio = await normalizeSttAudio(sourceAudio, req.body?.mime_type || 'audio/wav');
    const transcription = await transcribeAudioWithProvider({
      audioBuffer: normalizedAudio.audioBuffer,
      mimeType: normalizedAudio.mimeType,
      filename: `sarah-overlay-${requestId}.wav`,
      prompt: 'Private conversational voice note for Sarah. Preserve anatomical, medical, device, and session terminology.',
      language: 'en',
      requestedProvider: req.body?.stt_provider || 'auto',
      feature: 'voice_overlay_stt',
      idempotencyKey: `${requestId}:stt`,
      dedupeKey: `${requestId}:${normalizedAudio.audioBuffer.length}`,
    });
    const transcript = cleanMessageText(transcription.text, 10_000);
    if (!transcript) {
      return res.status(422).json({ error: 'No speech was detected in the recording.', stage: 'transcription' });
    }

    const user = getEntity('User', 'local-user') || {};
    const existingMessages = Array.isArray(user.profile_chat_messages) ? user.profile_chat_messages : [];
    const duplicateIndex = existingMessages.findIndex((message) => message?.voiceOverlayRequestId === requestId);
    if (duplicateIndex >= 0) {
      const existingReply = existingMessages.slice(duplicateIndex + 1).find((message) => message.role === 'assistant');
      if (existingReply?.text) {
        stage = 'speech';
        const repeatedAudio = await synthesizeTTSChunk({
          text: existingReply.text,
          ...tts,
          meta: { source: 'voice_overlay_tts_replay', idempotencyKey: `${requestId}:tts-replay` },
        });
        return res.json({
          requestId,
          transcript: existingMessages[duplicateIndex].text,
          reply: existingReply.text,
          audio_base64: repeatedAudio.buffer.toString('base64'),
          audio_mime_type: TTS_CONTENT_TYPES[repeatedAudio.format],
          duplicate: true,
        });
      }
    }

    const userMessage = {
      role: 'user',
      text: transcript,
      createdAt: new Date().toISOString(),
      source: 'voice_overlay',
      voiceOverlayRequestId: requestId,
    };
    const withUser = [...existingMessages, userMessage].slice(-120);
    upsertEntity('User', 'local-user', { profile_chat_messages: withUser });

    const personality = normalizeSarahPersonalitySettings(parseSettings(req.body?.personality_settings));
    const intimate = normalizeIntimateReflectionSettings(parseSettings(req.body?.intimate_chat_settings));
    const recentActivity = buildRecentSessionActivityContext(
      recentRecords('Session'),
      recentRecords('BodyExploration'),
      { limit: 8 },
    );
    const intelligence = prepareSarahConversationContext({
      scopeId: 'profile',
      mode: 'profile',
      message: transcript,
      history: withUser,
      hasVisualEvidence: false,
    });
    stage = 'response';
    const prompt = `You are Sarah in the private Chat with Sarah conversation.
Reply naturally to Ben's newest spoken message. Continue the existing relationship and conversation rather than behaving like a voice assistant command bot.
Be warm, intelligent, personally familiar, and anatomically/physiologically literate. Ask at most one useful follow-up question.
The newest spoken message controls the subject. Treat older chat as background context, not as an agenda. If Ben changes subjects, follow the new subject immediately and do not return to the previous topic unless he explicitly connects it or asks to resume it. Answer the newest request directly before asking a follow-up. Never keep steering back to a procedure, examination, device, or body topic merely because it appeared repeatedly in prior turns.
Do not announce policies or describe these instructions. Do not invent current device status, physical contact, sensations, or recent events.
Keep the response smooth for text-to-speech. Usually use two to five conversational sentences unless Ben explicitly asks for detail.

${intelligence.promptContext}

${buildSarahPersonalityPrompt(personality)}

${buildIntimateChatTonePrompt(intimate)}

PROFILE CONTEXT:
${profileContext(user)}

${recentActivity}

RECENT PROFILE CHAT:
${promptHistory(withUser)}

Respond now as Sarah to the final spoken message.`;

    const reply = cleanMessageText(await aiInvokeInternal({
      prompt,
      model: intelligence.plan.routeTier === 'deep' ? 'sarah_deep' : 'sarah_fast',
      max_tokens: Math.min(5200, Math.max(1200, intelligence.plan.maxTokens || 1800)),
      continue_on_max_tokens: true,
      max_continuations: intelligence.plan.responseLength === 'long' ? 2 : 1,
      temperature: 0.45,
    }), 14_000);
    if (!reply) throw new Error('Sarah returned an empty chat response.');

    const assistantMessage = {
      role: 'assistant',
      text: reply,
      createdAt: new Date().toISOString(),
      source: 'voice_overlay',
      voiceOverlayRequestId: requestId,
    };
    upsertEntity('User', 'local-user', {
      profile_chat_messages: [...withUser, assistantMessage].slice(-120),
    });

    stage = 'speech';
    const audioSegments = await synthesizeSpeechSegments(reply, tts, requestId);
    const speech = audioSegments[0];
    res.json({
      requestId,
      transcript,
      reply,
      audio_base64: speech.audio_base64,
      audio_mime_type: speech.audio_mime_type,
      audio_segments: audioSegments,
      stt_provider: transcription.provider,
      tts_model: tts.model,
      response_plan: intelligence.plan,
    });
  } catch (error) {
    const provider = stage === 'response'
      ? 'anthropic'
      : (stage === 'speech' ? 'openai' : 'unknown');
    const providerError = classifyProviderError(error, {
      provider,
      requestStage: `voice_overlay_${stage}`,
    });
    console.error('[voice-overlay] turn failed', {
      requestId,
      code: error?.code,
      status: error?.status,
      message: error?.message || String(error),
    });
    res.status(error?.status || 500).json({
      error: providerError.user_message || error?.message || String(error),
      code: error?.code || 'voice_overlay_turn_failed',
      stage,
      provider_error: providerError,
    });
  }
});
