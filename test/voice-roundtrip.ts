// Full voice path minus Google Meet: ElevenLabs TTS -> fake mic -> WebRTC loopback
// -> captured remote audio -> VAD -> ElevenLabs STT. Needs ELEVENLABS_API_KEY.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { Segmenter, type Utterance } from '../src/vad.js';
import { config } from '../src/config.js';
import { resolveVoice, speak, transcribe, TTS_RATE } from '../src/elevenlabs.js';

const PHRASE = 'The quarterly review moved to Thursday at three in the afternoon.';
const browser = await chromium.launch({
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const ctx = await browser.newContext();
const utts: Utterance[] = [];
const seg = new Segmenter(config.vadThreshold, config.silenceMs, (u) => utts.push(u));
await ctx.exposeFunction('__yomeetAudio', (b64: string) => {
  const b = Buffer.from(b64, 'base64');
  seg.push(new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + (b.length & ~1)) as ArrayBuffer));
});
await ctx.addInitScript(readFileSync(new URL('../src/inject.js', import.meta.url), 'utf8'));
await ctx.route('https://meet.google.com/test', (r) => r.fulfill({ contentType: 'text/html', body: '<html></html>' }));
const page = await ctx.newPage();
await page.goto('https://meet.google.com/test');
await page.evaluate(async () => {
  const s = await navigator.mediaDevices.getUserMedia({ audio: true });
  const a = new RTCPeerConnection(), b = new RTCPeerConnection();
  a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
  b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
  s.getTracks().forEach((t) => a.addTrack(t, s));
  await a.setLocalDescription(await a.createOffer());
  await b.setRemoteDescription(a.localDescription!);
  await b.setLocalDescription(await b.createAnswer());
  await a.setRemoteDescription(b.localDescription!);
  (window as any).__pcs = [a, b];
});
await page.waitForTimeout(1500);

const voice = await resolveVoice();
let t0 = Date.now(), first = 0;
for await (const chunk of speak(PHRASE, voice)) {
  first ||= Date.now() - t0;
  await page.evaluate(([c, r]) => (window as any).__yomeetPlay(c, r), [chunk.toString('base64'), TTS_RATE] as const);
}
console.log(`TTS first audio after ${first} ms`);
while ((await page.evaluate(() => (window as any).__yomeetRemaining())) > 0) await page.waitForTimeout(200);
await page.waitForTimeout(config.silenceMs + 500);
seg.flush();
await browser.close();

t0 = Date.now();
const texts = await Promise.all(utts.map((u) => transcribe(u.pcm)));
const heard = texts.join(' ');
console.log(`utterances=${utts.length} STT ${Date.now() - t0} ms\nheard: "${heard}"`);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, '');
const ok = ['quarterly', 'thursday', 'afternoon'].every((w) => norm(heard).includes(w));
console.log(ok ? 'ROUNDTRIP_OK' : 'ROUNDTRIP_FAIL');
process.exit(ok ? 0 : 1);
