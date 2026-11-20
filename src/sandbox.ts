// Runs YoMeet's Claude Code inside a Docker container whose only host mount is the
// workspace folder (plus its own config dir and your Claude login credentials).
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { config } from './config.js';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
// Tagged by the Dockerfile's hash, so editing it rebuilds the image on the next run.
const IMAGE = `yomeet-sandbox:${createHash('sha256').update(readFileSync(path.join(here, '..', 'sandbox', 'Dockerfile'))).digest('hex').slice(0, 12)}`;
export const containerName = `yomeet-${process.pid}`;

const WORKSPACE_GUIDE = `# yomeetnotes

The workspace of YoMeet, an AI bot that joins Google Meet calls. YoMeet runs
Claude Code sandboxed to this folder: it can read, write and run commands here,
and nothing outside this folder is visible to it.

- \`meetings/<date>_<code>.md\`: notes for each meeting (summary, decisions, action items, transcript)
- \`meetings/<date>_<code>.transcript.txt\`: live transcript written during the call
- \`memory.md\`: things YoMeet was asked to remember across meetings
- anything else: files YoMeet created when asked during a call

Other Claude Code sessions can read this folder for meeting context.
`;

export function prepareWorkspace() {
  mkdirSync(path.join(config.workspace, 'meetings'), { recursive: true });
  for (const f of ['CLAUDE.md']) {
    const p = path.join(config.workspace, f);
    if (!existsSync(p)) writeFileSync(p, WORKSPACE_GUIDE);
  }
}

/** Removes sandbox containers left behind by bot processes that were killed without cleaning up. */
async function removeOrphans() {
  const { stdout } = await run('docker', ['ps', '-a', '--filter', 'label=yomeet.sandbox', '--format', '{{.Names}}']).catch(() => ({ stdout: '' }));
  for (const name of stdout.split('\n').filter(Boolean)) {
    const pid = Number(/^yomeet-(\d+)$/.exec(name)?.[1]);
    let alive = false;
    try { if (pid) { process.kill(pid, 0); alive = true; } } catch {}
    if (!alive) await run('docker', ['rm', '-f', name]).catch(() => {});
  }
}

/** Builds the sandbox image if this version of the Dockerfile hasn't been built yet. */
export async function ensureImage() {
  const { stdout } = await run('docker', ['images', '-q', IMAGE]);
  if (!stdout.trim()) {
    console.log('[sandbox] building Docker image (first run only)…');
    await run('docker', ['build', '-t', IMAGE, path.join(here, '..', 'sandbox')], { maxBuffer: 1 << 26 });
  }
  console.log(`[sandbox] image ready: ${IMAGE}`);
}

export async function startSandbox() {
  await removeOrphans();
  await ensureImage();
  const cfgDir = path.join(homedir(), '.yomeet', 'claude-config');
  mkdirSync(cfgDir, { recursive: true });
  const { uid, gid } = userInfo();
  const args = [
    'run', '-d', '--rm', '--name', containerName, '--label', 'yomeet.sandbox=1',
    '--user', `${uid}:${gid}`,
    '--memory', '1g', '--pids-limit', '256',
    // same absolute path as on the host, so paths YoMeet mentions are real host paths
    '-v', `${config.workspace}:${config.workspace}`, '-w', config.workspace,
    '-v', `${cfgDir}:/home/yomeet/.claude`,
  ];
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN'); // from `claude setup-token`
  } else {
    const creds = path.join(homedir(), '.claude', '.credentials.json');
    if (!existsSync(creds)) throw new Error('No Claude Code login found: run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN in .env');
    args.push('-v', `${creds}:/home/yomeet/.claude/.credentials.json`);
  }
  args.push(IMAGE);
  await run('docker', args);
  console.log(`[sandbox] Claude Code sandbox up; workspace ${config.workspace}`);
}

export async function stopSandbox() {
  await run('docker', ['rm', '-f', containerName]).catch(() => {});
}

/** Spawns `claude <args>` inside the sandbox. */
export function spawnInSandbox(args: string[]) {
  return spawn('docker', ['exec', '-i', containerName, 'claude', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
}
