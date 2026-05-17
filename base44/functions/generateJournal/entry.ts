import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { session_id, voice_transcript, session_data } = await req.json();
    if (!session_id) return Response.json({ error: 'session_id required' }, { status: 400 });

    const s = session_data || {};

    const sessionContext = [
      s.date ? `Date: ${new Date(s.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}` : null,
      s.duration_minutes ? `Duration: ${s.duration_minutes} minutes` : null,
      s.methods?.length ? `Methods: ${s.methods.join(', ')}` : null,
      s.intensity != null ? `Intensity: ${s.intensity}/10` : null,
      s.satisfaction != null ? `Satisfaction: ${s.satisfaction}/10` : null,
      s.build_quality != null ? `Build quality: ${s.build_quality}/10` : null,
      s.build_type ? `Build type: ${s.build_type}` : null,
      s.climax_duration ? `Climax duration: ${s.climax_duration}` : null,
      s.no_climax ? 'No climax this session' : null,
      s.mood ? `Mood: ${s.mood}` : null,
      s.avg_hr ? `Avg HR: ${s.avg_hr} bpm` : null,
      s.max_hr ? `Max HR: ${s.max_hr} bpm` : null,
      s.hr_at_climax ? `HR at climax: ${s.hr_at_climax} bpm` : null,
      s.ejaculate_volume ? `Ejaculate volume: ${s.ejaculate_volume}` : null,
      s.discomfort ? `Discomfort noted: ${s.discomfort_notes || 'yes'}` : null,
      s.discomfort_entries?.length ? `Discomfort entries: ${s.discomfort_entries.map(d => `severity ${d.severity}/10 — ${d.note}`).join('; ')}` : null,
      s.unusual_sensations ? `Unusual sensations: ${s.unusual_sensations}` : null,
      s.hydration ? `Hydration: ${s.hydration}` : null,
      s.substances?.length ? `Substances: ${s.substances.join(', ')}` : null,
      s.foley_size ? `Foley size: ${s.foley_size}` : null,
      s.foley_type ? `Foley type: ${s.foley_type}` : null,
      s.estim_notes ? `E-stim notes: ${s.estim_notes}` : null,
      s.refractory_notes ? `Refractory notes: ${s.refractory_notes}` : null,
      s.notes ? `Session notes: ${s.notes}` : null,
      s.event_timeline?.length
        ? `Event timeline: ${s.event_timeline.slice(0, 10).map(e => `[${Math.floor(e.time_s / 60)}:${String(Math.round(e.time_s % 60)).padStart(2, '0')}] ${e.note}`).join(' | ')}`
        : null,
    ].filter(Boolean).join('\n');

    const transcriptSection = voice_transcript?.trim()
      ? `\n\nNOTES FROM THE PERSON (written or transcribed immediately after session):\n"${voice_transcript.trim()}"`
      : '';

    const prompt = `You are a compassionate physiological journal assistant. Write in second person ("you", "your") directly to the person. Your writing is warm, introspective, and data-grounded.

CRITICAL FOR TEXT-TO-SPEECH:
- Write all numbers as words (e.g., "eight out of ten", "seventy-two beats per minute")
- Use natural spoken prose — no bullet headers, no markdown
- Short, flowing sentences with natural pauses

SESSION DATA:
${sessionContext}
${transcriptSection}

Write a structured journal entry using EXACTLY these JSON keys. All fields are required and must be non-empty strings (or array for key_moments):
- title: a short evocative title (not just the date)
- emotional_reflection: 2-3 sentences about the emotional tone
- physiological_observations: 2-3 sentences grounding the experience in physiological data
- experience_narrative: 3-4 sentences weaving the full arc as a personal narrative
- key_moments: array of 2-4 brief strings, one per notable moment
- insights: 1-2 sentences of meaningful insight
- next_session_intentions: 1-2 sentences of intentions for next time`;

    const rawResult = await base44.asServiceRole.integrations.Core.InvokeLLM({
      model: 'claude_sonnet_4_6',
      prompt,
      response_json_schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          emotional_reflection: { type: 'string' },
          physiological_observations: { type: 'string' },
          experience_narrative: { type: 'string' },
          key_moments: { type: 'array', items: { type: 'string' } },
          insights: { type: 'string' },
          next_session_intentions: { type: 'string' },
        },
        required: ['title', 'emotional_reflection', 'physiological_observations', 'experience_narrative', 'key_moments', 'insights', 'next_session_intentions'],
      },
    });

    // InvokeLLM may wrap the result in a `response` key
    const result = rawResult?.response ?? rawResult;

    const journal = {
      title: result.title || `Session Journal`,
      emotional_reflection: result.emotional_reflection || '',
      physiological_observations: result.physiological_observations || '',
      experience_narrative: result.experience_narrative || '',
      key_moments: Array.isArray(result.key_moments) ? result.key_moments : [],
      insights: result.insights || '',
      next_session_intentions: result.next_session_intentions || '',
    };

    return Response.json({ journal });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});