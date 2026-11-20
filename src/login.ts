// Opens a visible Chrome window (on the server's VNC display) with YoMeet's Google profile so you can
// sign in by hand. Started and stopped by the dashboard. On SIGTERM it closes the window and prints
// `LOGIN_RESULT {"signedIn":bool,"email":string|null}`.
import { chromium, type BrowserContext } from 'playwright';
import { mkdirSync } from 'node:fs';
import { LAUNCH_OPTS, CONTEXT_OPTS } from './meet.js';

const profile = process.argv[2];
if (!profile) throw new Error('usage: login.ts <profile dir>');
mkdirSync(profile, { recursive: true });

async function status(ctx: BrowserContext) {
  const cookies = await ctx.cookies('https://accounts.google.com').catch(() => []);
  const signedIn = cookies.some((c) => c.name === 'SID' || c.name === '__Secure-1PSID');
  let email: string | null = null;
  if (signedIn) {
    // Read the signed-in address from the account chooser; best effort only.
    const page = await ctx.newPage();
    try {
      await page.goto('https://accounts.google.com/SignOutOptions', { timeout: 15000 });
      const text = await page.locator('body').innerText({ timeout: 5000 });
      email = /[\w.+-]+@[\w-]+(\.[\w-]+)+/.exec(text)?.[0] ?? null;
    } catch {}
  }
  return { signedIn, email };
}

const ctx = await chromium.launchPersistentContext(profile, { ...LAUNCH_OPTS, ...CONTEXT_OPTS, headless: false });
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto('https://accounts.google.com/');
console.log('[login] window open');

let done = false;
async function finish() {
  if (done) return;
  done = true;
  const s = await status(ctx);
  console.log(`LOGIN_RESULT ${JSON.stringify(s)}`);
  await ctx.close().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', finish);
process.on('SIGINT', finish);
// If the window gets closed by hand in VNC, there's nothing left to read: report not signed in only if no cookies.
ctx.on('close', () => { if (!done) { console.log('LOGIN_RESULT {"signedIn":null,"email":null}'); process.exit(0); } });
setTimeout(finish, 30 * 60_000); // give up after 30 minutes
