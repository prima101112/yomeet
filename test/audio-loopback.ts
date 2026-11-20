// Verifies the in-page audio path without Google Meet:
// fake mic (__yomeetPlay) -> WebRTC loopback -> hooked remote track -> __yomeetAudio -> VAD.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { Segmenter } from '../src/vad.js';

const INJECT = readFileSync(new URL('../src/inject.js', import.meta.url), 'utf8');
const browser = await chromium.launch({
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const ctx = await browser.newContext();
let samples = 0, peak = 0;
const utterances: number[] = [];
const seg = new Segmenter(350, 600, (u) => utterances.push(u.pcm.length / 16000));
await ctx.exposeFunction('__yomeetAudio', (b64: string) => {
  const b = Buffer.from(b64, 'base64');
  const pcm = new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + (b.length & ~1)) as ArrayBuffer);
  samples += pcm.length;
  for (const v of pcm) peak = Math.max(peak, Math.abs(v));
  seg.push(pcm);
});
await ctx.addInitScript(INJECT);
await ctx.route('https://meet.google.com/test', (r) => r.fulfill({ contentType: 'text/html', body: '<html><body>t</body></html>' }));
const page = await ctx.newPage();
await page.goto('https://meet.google.com/test');
await page.evaluate(async () => {
  const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  if (!s.getAudioTracks().length || !s.getVideoTracks().length) throw new Error('fake devices missing');
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
await page.waitForTimeout(2000);
const before = { samples, peak };
// 1.5 s of 440 Hz tone at 24 kHz, like a TTS chunk
const tone = new Int16Array(36000).map((_, i) => Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 24000)));
await page.evaluate(([b64]) => (window as any).__yomeetPlay(b64, 24000), [Buffer.from(tone.buffer).toString('base64')]);
await page.waitForTimeout(3500);
seg.flush();
console.log(JSON.stringify({ silentPhase: before, total: { samples, peak }, utterancesSec: utterances }));
await browser.close();
const ok = before.peak < 350 && peak > 2000 && utterances.length === 1 && utterances[0] > 1.2;
console.log(ok ? 'LOOPBACK_OK' : 'LOOPBACK_FAIL');
process.exit(ok ? 0 : 1);
