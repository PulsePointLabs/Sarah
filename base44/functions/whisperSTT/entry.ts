import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { audio_base64, mime_type, prompt } = await req.json();
    if (!audio_base64) return Response.json({ error: 'No audio provided' }, { status: 400 });

    // Decode base64 to binary
    const binaryStr = atob(audio_base64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
    const audioBlob = new Blob([bytes], { type: mime_type || 'audio/webm' });

    const apiKey = Deno.env.get('OPENAI_API_KEY');
    const whisperForm = new FormData();
    whisperForm.append('file', audioBlob, 'audio.webm');
    whisperForm.append('model', 'whisper-1');
    whisperForm.append('language', 'en');
    // Optional prompt biases Whisper toward correct vocabulary and punctuation
    if (prompt) whisperForm.append('prompt', prompt);

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: whisperForm,
    });

    if (!response.ok) {
      const err = await response.text();
      return Response.json({ error: err }, { status: response.status });
    }

    const data = await response.json();
    return Response.json({ text: data.text });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});