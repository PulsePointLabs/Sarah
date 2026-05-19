const API_BASE = process.env.API_BASE || 'http://localhost:8787/api';

const sampleText = `This was a remarkably efficient session — just over eight minutes from first contact to climax — that delivered a satisfaction score of ten and intensity of nine. What makes it stand out is how much physiological work your body packed into that short window. Mild THC, a post-shower body, a relaxed mood, and a full day of abstinence converged to create what your profile would predict as near-ideal conditions. The build was gradual but compressed, your sympathetic system climbed steadily from eighty beats per minute to a peak of one hundred fifteen at the exact moment of climax, and your feet and legs narrated almost every arousal transition in real time.`;

const brightNaturalAnalysis = 'Read with friendly analytical enthusiasm, like an engaged physiologist explaining a fascinating finding to someone they know well. Keep a smooth natural cadence, varied inflection, and clear sentence-level pauses. Sound warm and alive, not formal, monotone, sultry, or announcer-like.';

const presets = [
  {
    name: 'bright-natural-analysis-current',
    format: 'mp3',
    speed: 1.0,
    instructions: brightNaturalAnalysis,
  },
  {
    name: 'bright-natural-analysis-wav-check',
    format: 'wav',
    speed: 1.0,
    instructions: brightNaturalAnalysis,
  },
  {
    name: 'base44-no-instructions-mp3-100',
    format: 'mp3',
    speed: 1.0,
    instructions: '',
  },
];

async function generatePreset({ name, instructions, speed, format: presetFormat }) {
  const format = String(process.env.TTS_FORMAT || presetFormat || 'mp3').toLowerCase();
  const response = await fetch(`${API_BASE}/functions/openaiTTS`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: sampleText,
      voice: process.env.TTS_VOICE || 'nova',
      speed: Number(process.env.TTS_SPEED || speed || 0.96),
      instructions,
      format,
    }),
  });
  if (!response.ok) {
    throw new Error(`${name}: ${response.status} ${await response.text()}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const path = `data/tts-voice-lab-${name}.${format}`;
  await import('node:fs/promises').then((fs) => fs.writeFile(path, bytes));
  console.log(`${path} (${bytes.length} bytes)`);
}

const filter = process.env.TTS_PRESET;
for (const preset of presets.filter((preset) => !filter || preset.name.includes(filter))) {
  await generatePreset(preset);
}
