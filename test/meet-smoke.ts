// Opens a Meet link and reports what the pre-join screen shows (no API keys needed).
import { MeetBot } from '../src/meet.js';
const t0 = Date.now();
const log = (m: string) => console.log(((Date.now() - t0) / 1000).toFixed(1), m);
const bot = new MeetBot();
await bot.launch({ onAudio: () => {} });
log('launched');
await bot.page.goto(process.argv[2] ?? 'https://meet.google.com/new', { waitUntil: 'commit' });
log('committed');
await bot.page.waitForTimeout(8000);
const text = (await bot.page.locator('body').innerText({ timeout: 5000 })).slice(0, 600);
const buttons = await bot.page.getByRole('button').allInnerTexts();
console.log({ url: bot.page.url(), text, buttons: buttons.filter(Boolean).slice(0, 15) });
await bot.page.screenshot({ path: process.env.SHOT ?? 'meet-smoke.png', timeout: 5000 });
await bot.leave();
log('done');
