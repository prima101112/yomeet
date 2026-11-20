import 'dotenv/config';
import { homedir } from 'node:os';
import path from 'node:path';

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var ${name} (see .env.example)`);
  }
  return v;
}

const botName = env('BOT_NAME', 'YoMeet');
const expand = (p: string) => path.resolve(p.replace(/^~(?=$|\/)/, homedir()));
const workspace = expand(env('WORKSPACE', path.join(homedir(), 'yomeetnotes')));

export const config = {
  botName,
  // Words that wake the bot up. STT often splits/mangles names, so include variants.
  // The bot's name is also matched fuzzily (see findWake in index.ts).
  wakeWords: env(
    'WAKE_WORDS',
    [
      botName,
      ...(botName.toLowerCase().replace(/[^a-z]/g, '') === 'yomeet'
        ? ['yo meet', 'you meet', 'yo mit', 'you mit', 'yomit', 'yumit', 'umit', 'umeet', 'u meet', 'yumeet', 'yo meat', 'you meat']
        : []),
      'claude',
      'hey assistant',
    ].join(','),
  )
    .split(',')
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean),
  // Seconds after an answer during which a follow-up question doesn't need the wake word (0 = off).
  followUpSec: Number(env('FOLLOWUP_SEC', '15')),
  // When the bot and exactly one person are in the call, answer everything without the wake word.
  oneOnOne: env('ONE_ON_ONE', 'true') !== 'false',
  elevenApiKey: process.env.ELEVENLABS_API_KEY || '', // checked when a bot starts
  voiceId: process.env.ELEVENLABS_VOICE_ID || '',
  ttsModel: env('ELEVENLABS_TTS_MODEL', 'eleven_flash_v2_5'),
  sttModel: env('ELEVENLABS_STT_MODEL', 'scribe_v1'),
  language: process.env.LANGUAGE || '', // e.g. "en", "id"; empty = auto-detect
  // "claude-code" = shell out to `claude -p` (your Claude Code login); "api" = Anthropic SDK + ANTHROPIC_API_KEY
  brain: env('BRAIN', process.env.ANTHROPIC_API_KEY ? 'api' : 'claude-code') as 'claude-code' | 'api',
  claudeBin: env('CLAUDE_BIN', 'claude'),
  // Claude Code gets read/write/exec tools, but only inside `workspace` (Docker sandbox).
  workspace,
  sandbox: env('SANDBOX', 'docker') === 'docker',
  // Also give it bash/python in the workspace. Off by default: anyone in a call can talk to the bot.
  workspaceShell: env('WORKSPACE_SHELL', 'false') === 'true',
  claudeModel: env('CLAUDE_MODEL', 'claude-opus-5-5'),
  webSearch: env('WEB_SEARCH', 'true') === 'true',
  headless: env('HEADLESS', 'false') === 'true',
  profileDir: process.env.PROFILE_DIR || '', // set to use a signed-in Google profile
  notesDir: expand(env('NOTES_DIR', path.join(workspace, 'meetings'))),
  vadThreshold: Number(env('VAD_THRESHOLD', '350')), // RMS on int16 scale
  silenceMs: Number(env('SILENCE_MS', '900')),
  admitTimeoutMin: Number(env('ADMIT_TIMEOUT_MIN', '10')),
  aloneTimeoutMin: Number(env('ALONE_TIMEOUT_MIN', '3')),
  maxDurationMin: Number(env('MAX_DURATION_MIN', '180')),
};
