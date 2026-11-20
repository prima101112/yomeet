import { config } from './config.js';
import { toWav } from './vad.js';

const BASE = 'https://api.elevenlabs.io/v1';
export const TTS_RATE = 24000;

async function check(res: Response, what: string) {
  if (!res.ok) throw new Error(`ElevenLabs ${what} failed: ${res.status} ${await res.text()}`);
  return res;
}

/** Speech-to-text for one utterance using ElevenLabs Scribe. */
export async function transcribe(pcm: Int16Array): Promise<string> {
  const form = new FormData();
  form.append('model_id', config.sttModel);
  form.append('tag_audio_events', 'false');
  if (config.language) form.append('language_code', config.language);
  form.append('file', new Blob([new Uint8Array(toWav(pcm))], { type: 'audio/wav' }), 'utterance.wav');
  const res = await check(
    await fetch(`${BASE}/speech-to-text`, {
      method: 'POST',
      headers: { 'xi-api-key': config.elevenApiKey },
      body: form,
    }),
    'speech-to-text',
  );
  const json = (await res.json()) as { text?: string };
  return (json.text ?? '')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ') // drop "(music)", "[silence]" style tags
    .replace(/\s+/g, ' ')
    .trim();
}

/** Picks a voice if ELEVENLABS_VOICE_ID isn't set. */
const DEFAULT_VOICE = 'JBFqnCBsd6RMkjVDRZzb'; // "George", an ElevenLabs premade voice

export async function resolveVoice(): Promise<string> {
  if (config.voiceId) return config.voiceId;
  const res = await fetch(`${BASE}/voices`, { headers: { 'xi-api-key': config.elevenApiKey } });
  if (!res.ok) {
    // e.g. restricted keys without voices_read
    console.log(`[tts] can't list voices (${res.status}); using default voice ${DEFAULT_VOICE}. Set ELEVENLABS_VOICE_ID to change`);
    return DEFAULT_VOICE;
  }
  const { voices } = (await res.json()) as { voices: { voice_id: string; name: string; category?: string }[] };
  const pick = voices.find((v) => v.category === 'premade') ?? voices[0];
  if (!pick) throw new Error('No ElevenLabs voices available on this account');
  console.log(`[tts] using voice "${pick.name}" (${pick.voice_id}); set ELEVENLABS_VOICE_ID to change`);
  return pick.voice_id;
}

/** Streams raw 24 kHz PCM16 audio chunks (even byte lengths) for `text`. */
export async function* speak(text: string, voiceId: string): AsyncGenerator<Buffer> {
  const res = await check(
    await fetch(`${BASE}/text-to-speech/${voiceId}/stream?output_format=pcm_${TTS_RATE}`, {
      method: 'POST',
      headers: { 'xi-api-key': config.elevenApiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ text, model_id: config.ttsModel }),
    }),
    'text-to-speech',
  );
  let carry = Buffer.alloc(0);
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    const buf = Buffer.concat([carry, Buffer.from(chunk)]);
    const even = buf.length - (buf.length % 2);
    carry = buf.subarray(even);
    if (even > 0) yield buf.subarray(0, even);
  }
}
