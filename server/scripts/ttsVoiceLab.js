const API_BASE = process.env.API_BASE || 'http://localhost:8787/api';

const sampleText = `This was a remarkably efficient session — just over eight minutes from first contact to climax — that delivered a satisfaction score of ten and intensity of nine. What makes it stand out is how much physiological work your body packed into that short window. Mild THC, a post-shower body, a relaxed mood, and a full day of abstinence converged to create what your profile would predict as near-ideal conditions. The build was gradual but compressed, your sympathetic system climbed steadily from eighty beats per minute to a peak of one hundred fifteen at the exact moment of climax, and your feet and legs narrated almost every arousal transition in real time.`;

const presets = [
  {
    name: 'base44-default',
    instructions: null,
  },
  {
    name: 'warm-enthusiastic-podcast',
    instructions: 'Read as a warm, natural podcast-style narrator: emotionally present, lightly enthusiastic, curious, and conversational. Use natural inflection, gentle emphasis on meaningful findings, and brief pauses between ideas. Avoid sounding flat, clinical, robotic, intimate-whispery, or theatrical.',
  },
  {
    name: 'bright-natural-analysis',
    instructions: 'Read with friendly analytical enthusiasm, like an engaged physiologist explaining a fascinating finding to someone they know well. Keep a smooth natural cadence, varied inflection, and clear sentence-level pauses. Sound warm and alive, not formal, monotone, sultry, or announcer-like.',
  },
];

async function generatePreset({ name, instructions }) {
  const response = await fetch(`${API_BASE}/functions/openaiTTS`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: sampleText,
      voice: process.env.TTS_VOICE || 'nova',
      speed: Number(process.env.TTS_SPEED || 1),
      instructions,
    }),
  });
  if (!response.ok) {
    throw new Error(`${name}: ${response.status} ${await response.text()}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const path = `data/tts-voice-lab-${name}.mp3`;
  await import('node:fs/promises').then((fs) => fs.writeFile(path, bytes));
  console.log(`${path} (${bytes.length} bytes)`);
}

for (const preset of presets) {
  await generatePreset(preset);
}
