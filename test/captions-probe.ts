// Starts a throwaway meeting with the signed-in profile, speaks via TTS, and dumps the caption DOM.
import 'dotenv/config';
import { MeetBot } from '../src/meet.js';
import { speak, TTS_RATE } from '../src/elevenlabs.js';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now(); const log = (...a: unknown[]) => console.log(((Date.now() - t0) / 1000).toFixed(1), ...a);
const bot = new MeetBot();
await bot.launch({ onAudio: () => {}, onSpeaker: (n, at) => console.log('SPEAKER', JSON.stringify(n), at - t0) });
log('launched');
const page = bot.page;
try {
  log('goto'); await page.goto('https://meet.google.com/new', { waitUntil: 'domcontentloaded', timeout: 30000 }); log('loaded');
  await sleep(6000);
  log('url:', page.url());
  for (const name of [/^join now$/i, /^start now$/i, /^join$/i]) {
    const b = page.getByRole('button', { name }).first();
    if (await b.isVisible().catch(() => false)) { await b.click(); log('clicked', name); break; }
  }
  await sleep(6000);
  await page.getByRole('button', { name: /^(got it|dismiss|close)$/i }).first().click({ timeout: 1500 }).catch(() => {});
  log('in call:', await bot.inCall());
  const capBtn = page.getByRole('button', { name: /turn on captions/i }).first();
  if (await capBtn.isVisible().catch(() => false)) { await capBtn.click(); log('captions button clicked'); }
  else { await page.keyboard.press('c'); log('pressed c'); }
  await sleep(2500);
  await page.getByRole('button', { name: /turn on microphone/i }).first().click({ timeout: 1000 }).catch(() => {});
  const text = 'Hello everyone, this is a test of the captions. We are checking who said what in this meeting.';
  for await (const c of speak(text, process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb')) await bot.play(c.toString('base64'), TTS_RATE);
  for (let i = 0; i < 8; i++) {
    await sleep(1000);
    const r = await page.evaluate(() => {
      const reg = document.querySelector('[role="region"][aria-label*="aption" i]');
      return reg ? { label: reg.getAttribute('aria-label'), text: (reg as HTMLElement).innerText.slice(-300), html: reg.outerHTML.slice(0, 2500) } : null;
    });
    log(i, JSON.stringify(r?.text ?? null));
    if (i === 7) log('HTML:', r?.html);
  }
  await page.screenshot({ path: '/tmp/claude-1000/-home-ubuntu-projects-yomeet/7e2e2d96-1a61-47da-9760-9cecb5b7e866/scratchpad/captions.png' });
} catch (e) { log('ERROR', (e as Error).message.split('\n')[0]); } finally { await page.screenshot({ path: '/tmp/claude-1000/-home-ubuntu-projects-yomeet/7e2e2d96-1a61-47da-9760-9cecb5b7e866/scratchpad/captions.png' }).catch(() => {}); await Promise.race([bot.leave(), sleep(8000)]); process.exit(0); }
