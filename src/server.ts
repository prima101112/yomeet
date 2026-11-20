// YoMeet dashboard: settings (keys), launching/stopping bots, live logs, meeting notes, memory.
// Binds to 127.0.0.1 by default. To reach it from elsewhere, put it behind a reverse proxy with auth,
// or set DASHBOARD_PASSWORD (required for any non-loopback HOST).
import http from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, chmodSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseEnv } from 'dotenv';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(ROOT, '.env');
const PORT = Number(process.env.PORT || 8090);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BOTS = Number(process.env.MAX_BOTS || 2);
const DISPLAY = process.env.YOMEET_DISPLAY || ':99';
const startEnv = { ...(existsSync(ENV_FILE) ? parseEnv(readFileSync(ENV_FILE)) : {}), ...process.env };
// Optional: a noVNC (or other) viewer of DISPLAY, linked from the dashboard for the Google sign-in.
const VNC_URL = startEnv.VNC_URL || '';
const DASHBOARD_USER = startEnv.DASHBOARD_USER || 'admin';
const DASHBOARD_PASSWORD = startEnv.DASHBOARD_PASSWORD || '';
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|localhost)$/.test(HOST);
if (!LOOPBACK && !DASHBOARD_PASSWORD) {
  console.error(`[yomeet] refusing to listen on ${HOST} without DASHBOARD_PASSWORD: anyone who can reach it could read your keys and notes`);
  process.exit(1);
}
const sha = (s: string) => createHash('sha256').update(s).digest();
function authorized(req: http.IncomingMessage): boolean {
  if (!DASHBOARD_PASSWORD) return true; // loopback only; protect it with your reverse proxy
  const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const given = Buffer.from(m[1], 'base64').toString();
  return timingSafeEqual(sha(given), sha(`${DASHBOARD_USER}:${DASHBOARD_PASSWORD}`));
}
const GOOGLE_PROFILE = path.join(homedir(), '.yomeet', 'chrome-profile');

// ---------------- settings (.env) ----------------
interface Field { key: string; label: string; secret?: boolean; group: string; help?: string; options?: string[] }
const FIELDS: Field[] = [
  { key: 'ELEVENLABS_API_KEY', label: 'ElevenLabs API key', secret: true, group: 'Keys', help: 'Needs text-to-speech and speech-to-text permissions.' },
  { key: 'CLAUDE_CODE_OAUTH_TOKEN', label: 'Claude Code token', secret: true, group: 'Keys', help: 'From `claude setup-token`. Empty = use this server\'s Claude Code login.' },
  { key: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', secret: true, group: 'Keys', help: 'Only used when Brain = api.' },
  { key: 'BOT_NAME', label: 'Bot name', group: 'Bot', help: 'Name shown in Meet and the default wake word.' },
  { key: 'WAKE_WORDS', label: 'Wake words', group: 'Bot', help: 'Comma-separated. Empty = bot name + common mishearings.' },
  { key: 'LANGUAGE', label: 'Language', group: 'Bot', help: 'ISO code like en or id. Empty = auto-detect.' },
  { key: 'ELEVENLABS_VOICE_ID', label: 'Voice ID', group: 'Bot', help: 'Empty = George.' },
  { key: 'BRAIN', label: 'Brain', group: 'Brain', options: ['claude-code', 'api'] },
  { key: 'SANDBOX', label: 'Sandbox', group: 'Brain', options: ['docker', 'none'], help: 'docker = Claude Code can read/write/run only in the workspace.' },
  { key: 'CLAUDE_MODEL', label: 'Claude model', group: 'Brain', help: 'Empty = default (claude-opus-5-5).' },
  { key: 'WEB_SEARCH', label: 'Web search', group: 'Brain', options: ['true', 'false'] },
  { key: 'WORKSPACE_SHELL', label: 'Shell in workspace', group: 'Brain', options: ['false', 'true'], help: 'Let Claude run commands (bash, python) in the workspace. Anyone in a call can talk to the bot, so only enable this if you trust the people in your meetings.' },
  { key: 'ONE_ON_ONE', label: '1-on-1 mode', group: 'Bot', options: ['true', 'false'], help: 'When it\'s just you and the bot, it answers everything without the wake word (default true).' },
  { key: 'FOLLOWUP_SEC', label: 'Follow-up window (s)', group: 'Tuning', help: 'After an answer, ask again without the wake word for this long (default 15, 0 = off).' },
  { key: 'VAD_THRESHOLD', label: 'Voice threshold', group: 'Tuning', help: 'Raise if noise gets transcribed (default 350).' },
  { key: 'SILENCE_MS', label: 'Silence before cut (ms)', group: 'Tuning', help: 'Raise if people get cut off (default 900).' },
  { key: 'ADMIT_TIMEOUT_MIN', label: 'Admit timeout (min)', group: 'Tuning' },
  { key: 'ALONE_TIMEOUT_MIN', label: 'Leave when alone after (min)', group: 'Tuning' },
  { key: 'MAX_DURATION_MIN', label: 'Max meeting length (min)', group: 'Tuning' },
];
const ALLOWED = new Set(FIELDS.map((f) => f.key));

function readEnv(): Record<string, string> {
  return existsSync(ENV_FILE) ? parseEnv(readFileSync(ENV_FILE)) : {};
}
function writeEnv(env: Record<string, string>) {
  const body = Object.entries(env)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}=${/[\s#"'\\]/.test(v) ? JSON.stringify(v) : v}`)
    .join('\n');
  writeFileSync(ENV_FILE, body + '\n', { mode: 0o600 });
  chmodSync(ENV_FILE, 0o600);
}
const mask = (v: string) => (v.length <= 8 ? '••••' : `${v.slice(0, 3)}…${v.slice(-4)}`);

function workspace(): string {
  const w = readEnv().WORKSPACE || path.join(homedir(), 'yomeetnotes');
  return path.resolve(w.replace(/^~(?=$|\/)/, homedir()));
}
const meetingsDir = () => path.join(workspace(), 'meetings');

// ---------------- bots ----------------
interface Bot {
  id: string; url: string; name: string; startedAt: string; status: string;
  proc: ChildProcess; logs: string[]; notesFile?: string; exitCode?: number | null; error?: string;
}
const bots = new Map<string, Bot>();

function statusFromLine(bot: Bot, line: string) {
  if (/\[meet\] opening/.test(line)) bot.status = 'joining';
  else if (/waiting to be admitted/.test(line)) bot.status = 'waiting to be admitted';
  else if (/\[meet\] in the call/.test(line)) bot.status = 'in call';
  else if (/shutting down/.test(line)) bot.status = 'leaving';
  else if (/writing notes/.test(line)) bot.status = 'writing notes';
  const f = /\[yomeet\] fatal: (.*)/.exec(line);
  if (f) bot.error = f[1];
  const m = /notes saved to (.+\.md)/.exec(line);
  if (m) bot.notesFile = path.basename(m[1]);
}

let xvfb: ChildProcess | null = null;
function ensureDisplay() {
  if (xvfb && xvfb.exitCode === null) return;
  xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
  xvfb.on('exit', () => (xvfb = null));
}

function startBot(url: string, name?: string): Bot {
  if (name !== undefined && !/^[\p{L}][\p{L} .'-]{0,29}$/u.test(name)) {
    throw new HttpError(400, 'Bot name: 1-30 letters (spaces, dots, apostrophes and dashes allowed)');
  }
  const running = [...bots.values()].filter((b) => b.exitCode === undefined).length;
  if (running >= MAX_BOTS) throw new HttpError(429, `Already running ${running} bot(s); stop one first`);
  if (!/^https:\/\/meet\.google\.com\/[a-z]{3,4}-[a-z]{4}-[a-z]{3,4}(\?.*)?$/i.test(url)) {
    throw new HttpError(400, 'That doesn\'t look like a Google Meet link (https://meet.google.com/abc-defg-hij)');
  }
  if (!readEnv().ELEVENLABS_API_KEY) throw new HttpError(400, 'Add your ElevenLabs API key in Settings first');
  ensureDisplay();
  // Fresh env from .env each launch (overrides whatever the server was started with).
  const env = { ...process.env, ...readEnv(), DISPLAY, HEADLESS: 'false', ...(name ? { BOT_NAME: name } : {}) };
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', url], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const id = `${Date.now().toString(36)}`;
  const bot: Bot = { id, url, name: name || readEnv().BOT_NAME || 'YoMeet', startedAt: new Date().toISOString(), status: 'starting', proc, logs: [] };
  const onData = (d: Buffer) => {
    for (const line of d.toString().split('\n')) {
      if (!line.trim()) continue;
      bot.logs.push(line);
      if (bot.logs.length > 2000) bot.logs.shift();
      statusFromLine(bot, line);
    }
  };
  proc.stdout!.on('data', onData);
  proc.stderr!.on('data', onData);
  proc.on('exit', (code) => {
    bot.exitCode = code;
    bot.status = bot.error ? `failed: ${bot.error.slice(0, 80)}` : code === 0 ? 'finished' : `exited (${code})`;
  });
  bots.set(id, bot);
  return bot;
}

// ---------------- Google sign-in ----------------
let login: { proc: ChildProcess; out: string } | null = null;

function googleView() {
  const env = readEnv();
  return { signedIn: !!env.PROFILE_DIR && existsSync(env.PROFILE_DIR), account: env.GOOGLE_ACCOUNT || null, loginOpen: !!login, vncUrl: VNC_URL };
}
function startLogin() {
  if (login) throw new HttpError(409, 'The login window is already open');
  ensureDisplay();
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/login.ts', GOOGLE_PROFILE], {
    cwd: ROOT, env: { ...process.env, DISPLAY }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const l = { proc, out: '' };
  proc.stdout!.on('data', (d) => (l.out += d));
  proc.stderr!.on('data', (d) => (l.out += d));
  proc.on('exit', () => { if (login === l) { applyLoginResult(l.out); login = null; } });
  login = l;
}
function applyLoginResult(out: string) {
  const m = /LOGIN_RESULT (.*)/.exec(out);
  const r = m ? JSON.parse(m[1]) : { signedIn: null };
  const env = readEnv();
  if (r.signedIn === true) {
    env.PROFILE_DIR = GOOGLE_PROFILE;
    if (r.email) env.GOOGLE_ACCOUNT = r.email; else delete env.GOOGLE_ACCOUNT;
  } else if (r.signedIn === false) {
    delete env.PROFILE_DIR; delete env.GOOGLE_ACCOUNT;
  } else if (existsSync(GOOGLE_PROFILE)) {
    env.PROFILE_DIR = GOOGLE_PROFILE; // window closed by hand: keep the profile, account unknown
  }
  writeEnv(env);
  return r;
}
function finishLogin(): Promise<unknown> {
  const l = login;
  if (!l) throw new HttpError(409, 'The login window is not open');
  login = null; // the generic exit handler skips it; we apply the result here
  return new Promise((resolve) => {
    l.proc.once('exit', () => resolve(applyLoginResult(l.out)));
    l.proc.kill('SIGTERM');
    setTimeout(() => l.proc.kill('SIGKILL'), 30_000).unref();
  });
}

// ---------------- meetings & memory ----------------
function listMeetings() {
  const dir = meetingsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const p = path.join(dir, f);
      const first = readFileSync(p, 'utf8').split('\n').find((l) => l.startsWith('# '));
      return { file: f, title: first ? first.slice(2).trim() : f, modified: statSync(p).mtime.toISOString(), size: statSync(p).size };
    })
    .sort((a, b) => b.modified.localeCompare(a.modified));
}
function safeMeetingPath(file: string) {
  if (!/^[\w.-]+\.(md|txt)$/.test(file)) throw new HttpError(400, 'bad file name');
  const p = path.join(meetingsDir(), file);
  if (!existsSync(p)) throw new HttpError(404, 'not found');
  return p;
}

// ---------------- key checks ----------------
async function testElevenLabs() {
  const env = readEnv();
  if (!env.ELEVENLABS_API_KEY) return { ok: false, message: 'No key set' };
  const voice = env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb';
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=pcm_16000`, {
    method: 'POST',
    headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'ok', model_id: env.ELEVENLABS_TTS_MODEL || 'eleven_flash_v2_5' }),
  });
  if (!r.ok) return { ok: false, message: `Text-to-speech failed (${r.status}): ${(await r.text()).slice(0, 200)}` };
  return { ok: true, message: 'Text-to-speech works with this key and voice' };
}

function testClaude(): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    const env = { ...process.env, ...readEnv() };
    const child = spawn(process.execPath, ['--import', 'tsx', '-e',
      `import('./src/brain.ts').then(async (b) => { const s = await import('./src/sandbox.ts'); const { config } = await import('./src/config.ts');
         const sb = config.brain === 'claude-code' && config.sandbox; s.prepareWorkspace(); if (sb) await s.startSandbox();
         try { console.log('ANSWER:' + await b.answer('Reply with just the word ready.', [])); } finally { if (sb) await s.stopSandbox(); } })`,
    ], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      const m = /ANSWER:(.*)/.exec(out);
      resolve(m && code === 0 ? { ok: true, message: `Claude answered: "${m[1].trim()}"` } : { ok: false, message: out.trim().split('\n').slice(-3).join(' ').slice(0, 300) || `exit ${code}` });
    });
  });
}

// ---------------- HTTP ----------------
class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

async function body(req: http.IncomingMessage): Promise<any> {
  let raw = '';
  for await (const c of req) { raw += c; if (raw.length > 1e6) throw new HttpError(413, 'too large'); }
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, 'invalid JSON'); }
}
function send(res: http.ServerResponse, status: number, data: unknown, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY' });
  res.end(type === 'application/json' ? JSON.stringify(data) : (data as string));
}
const botView = (b: Bot, withLogs = false) => ({
  id: b.id, url: b.url, name: b.name, startedAt: b.startedAt, status: b.status, running: b.exitCode === undefined,
  notesFile: b.notesFile, ...(withLogs ? { logs: b.logs.slice(-500) } : {}),
});

const INDEX = path.join(ROOT, 'web', 'index.html');

async function route(req: http.IncomingMessage, res: http.ServerResponse) {
  const u = new URL(req.url || '/', 'http://x');
  const p = u.pathname.replace(/\/+$/, '') || '/';
  const m = req.method || 'GET';

  if (m === 'GET' && (p === '/' || p === '/index.html')) return send(res, 200, readFileSync(INDEX, 'utf8'), 'text/html; charset=utf-8');
  if (!p.startsWith('/api/')) throw new HttpError(404, 'not found');
  // CSRF guard: browsers can't add custom headers cross-site without a CORS preflight we never approve.
  if (m !== 'GET' && req.headers['x-yomeet'] !== '1') throw new HttpError(403, 'missing X-Yomeet header');

  if (m === 'GET' && p === '/api/settings') {
    const env = readEnv();
    return send(res, 200, {
      workspace: workspace(),
      fields: FIELDS.map((f) => ({ ...f, value: f.secret ? '' : env[f.key] ?? '', isSet: !!env[f.key], masked: f.secret && env[f.key] ? mask(env[f.key]) : '' })),
    });
  }
  if (m === 'PUT' && p === '/api/settings') {
    const patch = (await body(req)) as Record<string, string | null>;
    const env = readEnv();
    for (const [k, v] of Object.entries(patch)) {
      if (!ALLOWED.has(k)) throw new HttpError(400, `unknown setting ${k}`);
      if (v === null) delete env[k]; // explicit clear
      else if (typeof v === 'string') {
        if (/[\r\n]/.test(v)) throw new HttpError(400, `${k} can't contain newlines`);
        const field = FIELDS.find((f) => f.key === k)!;
        if (field.secret && v === '') continue; // blank secret = keep current
        if (field.options && v && !field.options.includes(v)) throw new HttpError(400, `${k} must be one of ${field.options.join(', ')}`);
        env[k] = v.trim();
      }
    }
    writeEnv(env);
    return send(res, 200, { ok: true });
  }
  if (m === 'POST' && p === '/api/test/elevenlabs') return send(res, 200, await testElevenLabs());
  if (m === 'POST' && p === '/api/test/claude') return send(res, 200, await testClaude());

  if (m === 'GET' && p === '/api/google') return send(res, 200, googleView());
  if (m === 'POST' && p === '/api/google/login') { startLogin(); return send(res, 200, googleView()); }
  if (m === 'POST' && p === '/api/google/done') { const r = await finishLogin(); return send(res, 200, { ...googleView(), result: r }); }
  if (m === 'POST' && p === '/api/google/logout') {
    if (login) throw new HttpError(409, 'Close the login window first');
    rmSync(GOOGLE_PROFILE, { recursive: true, force: true });
    const env = readEnv(); delete env.PROFILE_DIR; delete env.GOOGLE_ACCOUNT; writeEnv(env);
    return send(res, 200, googleView());
  }

  if (m === 'GET' && p === '/api/bots') return send(res, 200, [...bots.values()].reverse().map((b) => botView(b)));
  if (m === 'POST' && p === '/api/bots') {
    const { url, name } = await body(req);
    const n = typeof name === 'string' && name.trim() ? name.trim() : undefined;
    return send(res, 201, botView(startBot(String(url || '').trim(), n)));
  }
  let mm = /^\/api\/bots\/([\w]+)(\/stop)?$/.exec(p);
  if (mm) {
    const bot = bots.get(mm[1]);
    if (!bot) throw new HttpError(404, 'no such bot');
    if (m === 'GET' && !mm[2]) return send(res, 200, botView(bot, true));
    if (m === 'POST' && mm[2]) {
      if (bot.exitCode === undefined) { bot.proc.kill('SIGINT'); bot.status = 'leaving'; }
      return send(res, 200, botView(bot));
    }
    if (m === 'DELETE' && !mm[2]) {
      if (bot.exitCode === undefined) throw new HttpError(409, 'stop it first');
      bots.delete(bot.id);
      return send(res, 200, { ok: true });
    }
  }

  if (m === 'GET' && p === '/api/meetings') return send(res, 200, listMeetings());
  mm = /^\/api\/meetings\/([^/]+)$/.exec(p);
  if (mm) {
    const file = decodeURIComponent(mm[1]);
    if (m === 'GET') return send(res, 200, { file, content: readFileSync(safeMeetingPath(file), 'utf8') });
    if (m === 'DELETE') {
      unlinkSync(safeMeetingPath(file));
      const live = path.join(meetingsDir(), file.replace(/\.md$/, '.transcript.txt'));
      if (file.endsWith('.md') && existsSync(live)) unlinkSync(live);
      return send(res, 200, { ok: true });
    }
  }

  if (p === '/api/memory') {
    const f = path.join(workspace(), 'memory.md');
    if (m === 'GET') return send(res, 200, { content: existsSync(f) ? readFileSync(f, 'utf8') : '' });
    if (m === 'PUT') {
      const { content } = await body(req);
      mkdirSync(workspace(), { recursive: true });
      writeFileSync(f, String(content ?? ''));
      return send(res, 200, { ok: true });
    }
  }
  throw new HttpError(404, 'not found');
}

const server = http.createServer((req, res) => {
  if (!authorized(req)) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="YoMeet", charset="UTF-8"', 'content-type': 'text/plain' });
    return res.end('Authentication required');
  }
  route(req, res).catch((e) => {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    send(res, status, { error: e.message });
  });
});

function shutdown() {
  for (const b of bots.values()) if (b.exitCode === undefined) b.proc.kill('SIGINT');
  login?.proc.kill('SIGTERM');
  setTimeout(() => { xvfb?.kill(); process.exit(0); }, 30_000).unref();
  const check = setInterval(() => {
    if ([...bots.values()].every((b) => b.exitCode !== undefined)) { xvfb?.kill(); process.exit(0); }
  }, 500);
  check.unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, HOST, () => console.log(`[yomeet] dashboard on http://${HOST}:${PORT}`));
