import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { readFileSync, existsSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from './config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const INJECT = readFileSync(path.join(here, 'inject.js'), 'utf8');

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

// Shared by the bot and the Google login window (src/login.ts) so Google sees the same browser.
export const BROWSER_ARGS = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-blink-features=AutomationControlled',
  '--lang=en-US',
  '--no-sandbox',
  '--window-position=0,0',
  '--window-size=1280,800',
];
export const LAUNCH_OPTS = { args: BROWSER_ARGS, ignoreDefaultArgs: ['--enable-automation'] };
export const CONTEXT_OPTS = { userAgent: UA, locale: 'en-US', viewport: null };

/** Copy the signed-in profile so several bots (and a later re-login) don't fight over Chrome's profile lock. */
function copyProfile(src: string): string {
  const dst = mkdtempSync(path.join(tmpdir(), 'yomeet-profile-'));
  const skip = /^(Singleton\w*|.*Cache|GPUCache|Crashpad|ShaderCache|GrShaderCache|component_crx_cache)$/;
  cpSync(src, dst, { recursive: true, filter: (f) => !skip.test(path.basename(f)) });
  return dst;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface MeetHandlers {
  onAudio: (pcm: Int16Array) => void;
  /** A caption update: `name` (as shown in Meet) is speaking now. */
  onSpeaker?: (name: string, at: number) => void;
}

export class MeetBot {
  browser?: Browser;
  context!: BrowserContext;
  page!: Page;

  private profileCopy?: string;

  async launch(handlers: MeetHandlers) {
    const launchOpts = { ...LAUNCH_OPTS, headless: config.headless };
    const ctxOpts = {
      ...CONTEXT_OPTS,
      viewport: { width: 1280, height: 800 },
      permissions: ['microphone', 'camera'],
      bypassCSP: true,
    };
    if (config.profileDir && existsSync(config.profileDir)) {
      this.profileCopy = copyProfile(config.profileDir);
      console.log('[meet] using the signed-in Google profile');
      this.context = await chromium.launchPersistentContext(this.profileCopy, { ...launchOpts, ...ctxOpts });
    } else {
      this.browser = await chromium.launch(launchOpts);
      this.context = await this.browser.newContext(ctxOpts);
    }
    await this.context.grantPermissions(['microphone', 'camera'], { origin: 'https://meet.google.com' });

    await this.context.exposeFunction('__yomeetAudio', (b64: string) => {
      const buf = Buffer.from(b64, 'base64');
      // copy: pooled Buffers may sit at an odd byteOffset, which Int16Array can't view
      const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + (buf.length & ~1));
      handlers.onAudio(new Int16Array(bytes as ArrayBuffer));
    });
    await this.context.exposeFunction('__yomeetSpeaker', (name: string) => handlers.onSpeaker?.(String(name).slice(0, 100), Date.now()));
    await this.context.addInitScript(
      `window.__yomeetBotName = ${JSON.stringify(config.botName)};\n${INJECT}`,
    );
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
  }

  private async clickIfVisible(name: RegExp, timeout = 1500): Promise<boolean> {
    const btn = this.page.getByRole('button', { name }).first();
    try {
      await btn.waitFor({ state: 'visible', timeout });
      await btn.click();
      return true;
    } catch {
      return false;
    }
  }

  async inCall(): Promise<boolean> {
    return this.page.getByRole('button', { name: /leave call/i }).first().isVisible().catch(() => false);
  }

  async join(url: string) {
    console.log(`[meet] opening ${url}`);
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    await sleep(4000);
    await this.clickIfVisible(/^(got it|dismiss|continue without microphone and camera)$/i);

    const body = await this.page.locator('body').innerText().catch(() => '');
    if (/you can't join this video call|check your meeting code|meeting code is invalid/i.test(body)) {
      const hint = this.profileCopy ? '' : ' (Google often blocks signed-out guests from servers: sign ${config.botName} in to a Google account in Settings → Google account)';
      throw new Error(`Google Meet refused the join: ${body.split('\n')[0]}${hint}`);
    }

    const nameInput = this.page.locator('input[aria-label="Your name"], input[placeholder="Your name"]').first();
    if (await nameInput.isVisible().catch(() => false)) {
      await nameInput.fill(config.botName);
      console.log(`[meet] joining as guest "${config.botName}"`);
    }
    // Make sure our virtual mic/camera are on in the preview.
    await this.clickIfVisible(/^turn on microphone/i, 800);
    await this.clickIfVisible(/^turn on camera/i, 800);

    const joined =
      (await this.clickIfVisible(/^(join now|ask to join|join anyway|join here too|switch here)$/i, 15000)) ||
      (await this.clickIfVisible(/join/i, 5000));
    if (!joined) {
      const t = await this.page.locator('body').innerText().catch(() => '');
      if (/you can't join this video call/i.test(t)) {
        throw new Error("Meet says \"You can't join this video call\" (wrong code, the meeting doesn't allow guests, or it has ended)");
      }
      throw new Error('Could not find a Join button (is the link correct?)');
    }
    console.log('[meet] waiting to be admitted…');

    const deadline = Date.now() + config.admitTimeoutMin * 60_000;
    while (Date.now() < deadline) {
      if (await this.inCall()) {
        console.log('[meet] in the call');
        await sleep(1500);
        await this.clickIfVisible(/^(got it|dismiss|close)$/i, 500);
        return;
      }
      const t = await this.page.locator('body').innerText().catch(() => '');
      if (/denied your request|you can't join|removed you|no one responded/i.test(t)) {
        throw new Error('Not admitted to the meeting');
      }
      await sleep(2000);
    }
    throw new Error(`Not admitted within ${config.admitTimeoutMin} minutes`);
  }

  private captionsLogged = false;
  /** Turn on Meet's captions (used only to see who is speaking). Safe to call repeatedly. */
  async ensureCaptions() {
    const on = () => this.page.evaluate(() => !!(window as any).__yomeetCaptionsOn).catch(() => false);
    if (await on()) return;
    const btn = this.page.getByRole('button', { name: /turn on captions/i }).first();
    if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => {});
    else await this.page.keyboard.press('c').catch(() => {}); // Meet's captions shortcut
    await sleep(1500);
    const ok = await on();
    if (ok && !this.captionsLogged) console.log('[meet] captions on (for speaker names)');
    this.captionsLogged ||= ok;
  }

  /** Meet sometimes auto-mutes late joiners; make sure we're audible before speaking. */
  async ensureUnmuted() {
    await this.clickIfVisible(/^turn on microphone/i, 300);
  }

  async play(pcmB64: string, rate: number): Promise<number> {
    return this.page.evaluate(([b, r]) => (window as any).__yomeetPlay(b, r), [pcmB64, rate] as const);
  }

  async remaining(): Promise<number> {
    return this.page.evaluate(() => (window as any).__yomeetRemaining()).catch(() => 0);
  }

  /** Number of participants, or null if it can't be determined from the DOM. */
  async participantCount(): Promise<number | null> {
    return this.page
      .evaluate(() => {
        const ids = new Set(
          [...document.querySelectorAll('[data-participant-id]')].map((e) => e.getAttribute('data-participant-id')),
        );
        return ids.size || null;
      })
      .catch(() => null);
  }

  async ended(): Promise<boolean> {
    if (this.page.isClosed()) return true;
    if (await this.inCall()) return false;
    const t = await this.page.locator('body').innerText().catch(() => '');
    return /you left the meeting|you've been removed|the call has ended|return to home screen|rejoin/i.test(t);
  }

  async leave() {
    try {
      if (this.page && !this.page.isClosed()) await this.clickIfVisible(/leave call/i, 1000);
      await sleep(500);
    } catch {}
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    if (this.profileCopy) rmSync(this.profileCopy, { recursive: true, force: true });
  }
}
