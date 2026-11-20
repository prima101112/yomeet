import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { MeetBot } from './meet.js';
import { Segmenter } from './vad.js';
import { transcribe, resolveVoice, speak, TTS_RATE } from './elevenlabs.js';
import { answerStream, warmBrain, closeBrain, writeNotes, formatTranscript, setLiveTranscriptFile, type Line } from './brain.js';
import { prepareWorkspace, startSandbox, stopSandbox } from './sandbox.js';
import { Speakers } from './speakers.js';

const url = process.argv[2];
if (!url || !/^https:\/\/meet\.google\.com\/[a-z0-9-]+/i.test(url)) {
  console.error('Usage: npm start -- https://meet.google.com/abc-defg-hij');
  process.exit(1);
}
const useSandbox = config.brain === 'claude-code' && config.sandbox;
console.log(
  `[yomeet] brain: ${config.brain === 'claude-code' ? `Claude Code${useSandbox ? `, sandboxed to ${config.workspace}` : ' (no tools)'}` : 'Anthropic API'}`,
);

const code = url.split('/').pop()!.split('?')[0];
const started = new Date();
const stamp = started.toISOString().slice(0, 16).replace('T', '_').replace(':', '');
mkdirSync(config.notesDir, { recursive: true });
const base = path.join(config.notesDir, `${stamp}_${code}`);
const liveFile = `${base}.transcript.txt`;
setLiveTranscriptFile(liveFile);

const transcript: Line[] = [];
const speakers = new Speakers();
const bot = new MeetBot();
let voiceId = '';
let shuttingDown = false;

function addLine(speaker: string, text: string, at = new Date()) {
  const line = { at, speaker, text };
  transcript.push(line);
  const s = formatTranscript([line]);
  console.log(s);
  appendFileSync(liveFile, s + '\n');
}

// ---------- wake word / question handling ----------
const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s,.-]*');
const wakeRe = new RegExp(`\\b(?:hey\\s+|hi\\s+|ok(?:ay)?\\s+)?(?:${config.wakeWords.map(esc).join('|')})\\b[\\s,.!?:-]*`, 'i');
const leaveRe = /\b(leave|exit|drop off|hang up)\b.*\b(meeting|call)\b|^(please )?leave\.?$/i;

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
// The bot's name is also matched fuzzily, since STT writes "yo me", "you met", "yomit"… (only the
// name: fuzzy "claude" would fire on "cloud").
const fuzzyNames = [config.botName.toLowerCase().replace(/[^a-z]/g, '')].filter((w) => w.length >= 5);

// "to meet" / "we meet" are not "yomeet": the first sound must match ("u"/"j" pass for a leading "y").
const sameStart = (w: string, name: string) => w[0] === name[0] || (name[0] === 'y' && /[uj]/.test(w[0]));

/** Returns the text after the wake word, or null if the bot wasn't addressed. */
export function findWake(text: string): string | null {
  const m = wakeRe.exec(text);
  if (m) return text.slice(m.index + m[0].length).trim();
  // Fuzzy: 1-3 consecutive words among the first 8 that, joined, are within 2 edits of the name.
  const words = [...text.matchAll(/[a-z']+/gi)].slice(0, 8);
  for (let i = 0; i < words.length; i++) {
    let joined = '';
    for (let k = i; k < Math.min(i + 3, words.length); k++) {
      joined += words[k][0].toLowerCase().replace(/'/g, '');
      if (joined.length < (k === i ? 5 : 4)) continue; // a lone "meet" isn't the name
      if (fuzzyNames.some((n) => sameStart(joined, n) && editDistance(joined, n) <= (n.length >= 6 ? 2 : 1))) {
        const end = words[k].index! + words[k][0].length;
        return text.slice(end).replace(/^[\s,.!?:-]+/, '').trim();
      }
    }
  }
  return null;
}

let participants: number | null = null; // including the bot; null = unknown
let pendingWakeUntil = 0;
let followUpUntil = 0; // after an answer, a follow-up doesn't need the wake word
const questions: string[] = [];
let busy = false;

function onTranscript(text: string, at: Date, speaker: string) {
  addLine(speaker, text, at);
  if (shuttingDown) return;
  const after = findWake(text);
  let q: string | null = null;
  if (after !== null) {
    if (after.split(/\s+/).filter(Boolean).length < 2) {
      pendingWakeUntil = Date.now() + 10_000; // "Hey YoMeet." … pause … question
      void chime();
      return;
    }
    q = after;
  } else if (Date.now() < pendingWakeUntil || (at.getTime() < followUpUntil && !busy)) {
    q = text;
  } else if (config.oneOnOne && participants === 2 && !busy && (text.match(/[a-z]{2,}/gi)?.length ?? 0) >= 2) {
    q = text; // just you and the bot: everything is addressed to it
  }
  if (!q) return;
  pendingWakeUntil = 0;
  followUpUntil = 0;
  // "I need to leave the call soon" in 1-on-1 mode isn't a command: require the wake word or a short phrase.
  if (leaveRe.test(q) && (after !== null || q.split(/\s+/).length <= 5)) {
    void sayThenLeave();
    return;
  }
  void chime();
  questions.push(q);
  void drainQuestions();
}

// A short two-note "I heard you" sound, played into the call right away.
const CHIME = (() => {
  const rate = TTS_RATE;
  const notes = [[660, 0.09], [880, 0.12]] as const;
  const total = notes.reduce((a, [, d]) => a + Math.round(d * rate), 0);
  const pcm = Buffer.alloc(total * 2);
  let o = 0;
  for (const [f, dur] of notes) {
    const n = Math.round(dur * rate);
    for (let i = 0; i < n; i++) {
      const env = Math.min(1, i / (0.01 * rate), (n - i) / (0.03 * rate));
      pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * f * i) / rate) * env * 0.18 * 0x7fff), (o++) * 2);
    }
  }
  return pcm.toString('base64');
})();
async function chime() {
  try { await bot.play(CHIME, TTS_RATE); } catch {}
}

async function waitForPlayback() {
  while ((await bot.remaining()) > 0.05) await new Promise((r) => setTimeout(r, 150));
}

async function speakSentence(text: string) {
  for await (const chunk of speak(text, voiceId)) await bot.play(chunk.toString('base64'), TTS_RATE);
}

async function say(text: string) {
  addLine(config.botName, text);
  await bot.ensureUnmuted();
  await speakSentence(text);
  await waitForPlayback(); // so answers don't overlap
}

async function drainQuestions() {
  if (busy) return;
  busy = true;
  try {
    while (questions.length && !shuttingDown) {
      const q = questions.shift()!;
      const t0 = Date.now();
      console.log(`[brain] question: ${q}`);
      const spoken: string[] = [];
      try {
        await bot.ensureUnmuted();
        // Speak each sentence as soon as Claude has written it; TTS of the next one overlaps playback.
        for await (const sentence of answerStream(q, transcript)) {
          if (!spoken.length) console.log(`[brain] first sentence after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
          spoken.push(sentence);
          await speakSentence(sentence);
        }
      } catch (e) {
        console.error('[brain] failed to answer:', (e as Error).message ?? e);
        if (!spoken.length) await speakSentence("Sorry, something went wrong on my side. Could you ask again?").catch(() => {});
      }
      if (spoken.length) addLine(config.botName, spoken.join(' '));
      await waitForPlayback();
      followUpUntil = Date.now() + config.followUpSec * 1000;
    }
  } finally {
    busy = false;
  }
}

async function sayThenLeave() {
  try {
    await say('Okay, leaving now. I will write up the notes. Bye everyone!');
  } catch {}
  await shutdown('asked to leave');
}

// ---------- audio → STT, in order ----------
let sttChain: Promise<void> = Promise.resolve();
const segmenter = new Segmenter(config.vadThreshold, config.silenceMs, ({ pcm, startedAt }) => {
  const job = transcribe(pcm).catch((e) => {
    console.error('[stt]', e.message);
    return '';
  });
  const start = startedAt.getTime();
  const end = start + (pcm.length / 16000) * 1000;
  sttChain = sttChain.then(async () => {
    const text = await job;
    if (!text) return;
    // captions trail the audio; give them a moment before deciding who spoke
    const wait = end + 1500 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    onTranscript(text, startedAt, speakers.who(start, end));
  });
});

// ---------- lifecycle ----------
async function shutdown(reason: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[yomeet] shutting down: ${reason}`);
  segmenter.flush();
  await sttChain;
  await bot.leave();
  // Lines from before captions came on say "Participant"; in a 1-on-1 call we know who that was.
  const other = speakers.onlyOther();
  if (other) for (const l of transcript) if (l.speaker === 'Participant') l.speaker = other;
  const notesFile = `${base}.md`;
  const meta = `Meeting: ${url}\nStarted: ${started.toString()}\nEnded: ${new Date().toString()}`;
  if (transcript.length === 0) {
    console.log('[yomeet] nothing was said; no notes written');
  } else {
    console.log('[yomeet] writing notes with Claude…');
    let notes: string;
    try {
      notes = await writeNotes(transcript, meta);
    } catch (e) {
      console.error('[yomeet] notes generation failed, saving transcript only:', e);
      notes = '# Meeting transcript\n\n(Notes generation failed.)';
    }
    writeFileSync(
      notesFile,
      `${notes}\n\n---\n\n<sub>${meta.replace(/\n/g, ' · ')}</sub>\n\n<details><summary>Full transcript</summary>\n\n\`\`\`\n${formatTranscript(transcript)}\n\`\`\`\n</details>\n`,
    );
    console.log(`[yomeet] notes saved to ${notesFile}`);
  }
  closeBrain();
  if (useSandbox) await stopSandbox();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('Ctrl+C'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

async function main() {
  if (!config.elevenApiKey) throw new Error('ELEVENLABS_API_KEY is not set (add it to .env, see .env.example)');
  prepareWorkspace();
  if (useSandbox) await startSandbox();
  voiceId = await resolveVoice();
  warmBrain(); // start the Claude session while joining
  await bot.launch({
    onAudio: (pcm) => !shuttingDown && segmenter.push(pcm),
    onSpeaker: (name, at) => speakers.add(name, at),
  });
  await bot.join(url);
  await bot.ensureCaptions();
  console.log(`[yomeet] listening. Wake words: ${config.wakeWords.join(', ')}. Ctrl+C to leave and write notes.`);

  let aloneSince: number | null = null;
  let sawOthers = false;
  while (!shuttingDown) {
    await new Promise((r) => setTimeout(r, 5000));
    if (await bot.ended()) return shutdown('meeting ended or bot was removed');
    if (Date.now() - started.getTime() > config.maxDurationMin * 60_000) return shutdown('max duration reached');
    await bot.ensureCaptions();
    const n = await bot.participantCount();
    if (n !== participants) {
      console.log(`[meet] participants: ${n ?? 'unknown'}${config.oneOnOne && n === 2 ? ' (1-on-1: answering everything)' : ''}`);
      participants = n;
    }
    if (n !== null && n > 1) sawOthers = true;
    if (n === 1 && sawOthers) {
      aloneSince ??= Date.now();
      if (Date.now() - aloneSince > config.aloneTimeoutMin * 60_000) return shutdown('everyone else left');
    } else {
      aloneSince = null;
    }
  }
}

main().catch(async (e) => {
  console.error('[yomeet] fatal:', e.message ?? e);
  try {
    await bot.page?.screenshot({ path: `${base}.error.png` });
    console.error(`[yomeet] screenshot saved to ${base}.error.png`);
  } catch {}
  await shutdown('error');
});
