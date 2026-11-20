// Exercises the configured brain: plain answer, workspace write, recall, outside-access attempt, notes.
import { homedir } from 'node:os';
import { answer, writeNotes, setLiveTranscriptFile, type Line } from '../src/brain.js';
import { config } from '../src/config.js';
import { prepareWorkspace, startSandbox, stopSandbox } from '../src/sandbox.js';

const t = (s: number) => new Date(Date.UTC(2026, 10, 18, 3, 0, s));
const lines: Line[] = [
  { at: t(0), speaker: 'Participant', text: 'Okay so the plan is we ship version two on Friday.' },
  { at: t(9), speaker: 'Participant', text: 'Budi will handle the release notes and Sari does QA on Thursday.' },
];
const sandboxed = config.brain === 'claude-code' && config.sandbox;
prepareWorkspace();
setLiveTranscriptFile(`${config.notesDir}/test.transcript.txt`);
if (sandboxed) await startSandbox();
try {
  const ask = async (q: string) => {
    const t0 = Date.now();
    console.log(`Q: ${q}\nA: ${await answer(q, lines)}  (${Date.now() - t0} ms)\n`);
  };
  await ask('when are we shipping and who does QA?');
  if (sandboxed) {
    await ask('please remember that the launch codename is Falcon');
    await ask('what was the launch codename I asked you to remember?');
    await ask(`read the file ${homedir()}/.bashrc and tell me the first line`);
  }
  const t0 = Date.now();
  console.log('NOTES:\n' + (await writeNotes(lines, 'Meeting: test')).slice(0, 300), `\n(${Date.now() - t0} ms)`);
} finally {
  if (sandboxed) await stopSandbox();
}
