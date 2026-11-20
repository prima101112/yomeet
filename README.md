# YoMeet

A personal Google Meet bot. It joins your call, transcribes everything with speaker names, answers questions out loud when you talk to it, and writes meeting notes when the call ends.

- **Voice:** ElevenLabs speech-to-text (Scribe) and streaming text-to-speech.
- **Brain:** Claude, through your Claude Code login (no API key needed) or the Anthropic API.
- **Workspace:** the bot's Claude Code is sandboxed in Docker to one folder (`~/yomeetnotes`), where it keeps notes and a memory file. Your own Claude Code sessions can read that folder for context.
- **Dashboard:** a small web UI to send the bot to a call, watch the live transcript, read notes, edit its memory and manage keys.

Typical latency is about 2–3 s from the end of your question to the bot's first word (longer when it searches the web; it says "Let me look that up" first).

## Requirements

- Linux or macOS with **Node.js 20+** and **Docker** (for the sandbox).
- **Claude Code** installed and logged in (`claude`), or an Anthropic API key.
- An **ElevenLabs** API key with text-to-speech and speech-to-text access.
- On a server without a screen: **Xvfb** (`apt install xvfb`). Google Meet is run in a real (not headless) Chrome.
- A **Google account for the bot**. Signed-out guests are often refused by Meet ("You can't join this video call"), especially from servers. A separate Gmail just for the bot is best.

## Setup

```bash
git clone https://github.com/prima101112/yomeet.git && cd yomeet
scripts/setup.sh            # installs dependencies, Chromium, Xvfb, .env, the sandbox image; then checks everything
```
The script is safe to re-run, and it lists anything left to do. Usually that's:
1. Add your ElevenLabs key to `.env` as `ELEVENLABS_API_KEY`.
2. Run `claude setup-token` and put the token in `.env` as `CLAUDE_CODE_OAUTH_TOKEN` (or just be logged in to Claude Code).

Then start the dashboard with `npm run server` (http://127.0.0.1:8090).

**Using a coding agent?** Point it at this repo and ask it to install YoMeet. [AGENTS.md](AGENTS.md) tells it what to do and which steps need you.

### Sign the bot in to Google

In the dashboard, go to **Settings → Google account → Sign in to Google**. A Chrome window opens on the bots' display. Sign in there, then press **Done**. The profile is saved in `~/.yomeet/chrome-profile`, and each bot runs on a temporary copy of it.

- On a desktop machine the window simply appears on your screen.
- On a server it opens on the virtual display (`YOMEET_DISPLAY`, default `:99`). Reach it with a VNC viewer, e.g. `x11vnc -display :99 -localhost` plus an SSH tunnel, or noVNC. Set `VNC_URL` in `.env` to get a link to it in the dashboard.

## Using it

Paste a Meet link in the dashboard, pick the bot's name (Jarvis, Nova, YoMeet or your own), press **Join**, then admit the bot in Meet. The name is what it shows in Meet and the word it listens for.

- **Ask it something:** start with its name. *"YoMeet, what did we decide about the launch date?"* or *"Hey YoMeet."* (pause) *"Summarize the last ten minutes."* A short chime means it heard you. "Hey Claude" works too.
- **1-on-1:** when it's just you and the bot, you don't need its name. Just talk.
- **Follow-ups:** for 15 s after an answer you can ask again without its name.
- **Memory and notes:** *"YoMeet, remember that the codename is Falcon"*, *"What did we decide in last week's meeting?"*, *"Save a todo list from this call."*
- **End:** *"YoMeet, leave the meeting"*, press **Stop** in the dashboard, or end the call. Notes are written to `~/yomeetnotes/meetings/<date>_<code>.md`: summary, key points, decisions, action items with owners, open questions, and the full transcript.

**Pick a name speech recognition gets right.** "YoMeet" is often heard as "Umit" or "Yo meat". The bot matches close guesses, but a real word works best: pick a name like *Jarvis* or *Nova* in the Join form (or set the default **Bot name** in Settings). Avoid everyday words ("Friday", "Max"), or it will jump in when they come up.

### Command line

```bash
npm start -- https://meet.google.com/abc-defg-hij
```
It uses a virtual display automatically when there's no screen. Press Ctrl+C to leave and write the notes.

## The `~/yomeetnotes` workspace

```
~/yomeetnotes/
  CLAUDE.md                              # explains the layout (for the bot and for you)
  memory.md                              # "remember that…"
  meetings/<date>_<code>.md              # notes + transcript per meeting
  meetings/<date>_<code>.transcript.txt  # live transcript during the call
```
To use your meetings from your own Claude Code: `claude --add-dir ~/yomeetnotes`.

## Security

Anyone in a meeting can talk to the bot, so treat what it can do like something you'd let your meeting guests do.

- The bot's Claude Code runs in a Docker container that only sees the workspace folder. By default it can read and write files there and search the web. Nothing else on your machine exists for it.
- **`WORKSPACE_SHELL=true`** additionally lets it run commands (bash, python) in the workspace. The container has internet access and holds your Claude login. A malicious participant could try to talk the bot into sending that login somewhere. Claude is instructed never to do that, but only enable the shell if you trust the people in your calls.
- Prefer **`CLAUDE_CODE_OAUTH_TOKEN`** (from `claude setup-token`) over mounting `~/.claude/.credentials.json`. It's a separate token you can revoke without touching your main login.
- The dashboard holds your keys and notes. It listens on `127.0.0.1` only. To reach it remotely, put it behind a reverse proxy with authentication, or set `DASHBOARD_PASSWORD` (built-in basic auth; required for any non-loopback `HOST`, and use HTTPS). Requests that change things need an `X-Yomeet: 1` header, which blocks cross-site form attacks.
- Settings, including keys, are stored in `.env` with mode 600.

## Running the dashboard as a service

`sandbox/yomeet.service` is a systemd user unit. Edit the paths in it, then:
```bash
cp sandbox/yomeet.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now yomeet
loginctl enable-linger "$USER"      # keep running after logout
journalctl --user -u yomeet -f      # logs
```
Restarting it makes running bots leave and write their notes first. At most `MAX_BOTS` (default 2) bots run at once. Each one is a full Chrome, about 400 MB.

## How it works

```
Meet tab (Playwright Chromium)
 ├─ hooked RTCPeerConnection → remote audio → 16 kHz PCM ──────┐
 ├─ Meet captions (bot's view only) → who is speaking ─┐        │
 └─ fake mic (WebAudio) ◀── PCM ◀── ElevenLabs TTS     │        ▼
                                        ▲              └─▶ VAD → ElevenLabs Scribe STT → transcript
                  Claude (warm session) ◀── addressed? ◀─────────────────────────────────┘
                  Claude notes          ◀── transcript (at the end)
```

- `src/inject.js`: page script. Captures meeting audio, replaces the mic and camera, plays TTS, and reports caption speaker names.
- `src/meet.ts`: launching Chrome, joining, admission, captions, mute handling, end and alone detection.
- `src/vad.ts`: splits audio into utterances by energy level.
- `src/elevenlabs.ts`: Scribe STT and streaming TTS.
- `src/speakers.ts`: lines up caption updates with utterances to label who said what.
- `src/brain.ts`: Claude.
  - With Claude Code, one `claude -p` stream-json session stays open per meeting and the answer is spoken sentence by sentence.
  - With `BRAIN=api`, it calls the Anthropic SDK.
  - Notes use a separate one-shot call.
- `src/sandbox.ts`: the Docker sandbox. `src/server.ts` and `web/index.html`: the dashboard. `src/login.ts`: the Google sign-in window.

## Notes and limits

- **Tell people it's recording.** The bot's camera tile says it's an AI notetaker, but in many places you legally need everyone's consent to record or transcribe a call.
- This automates the Google Meet web app. Google doesn't offer an official bot API for this, so use it for your own meetings and at your own risk.
- **Speaker names** come from Meet's captions, so they're the names shown in Meet. When captions don't say who spoke, a line is labelled `Participant`. Overlapping speech can get the wrong name.
- Meet's UI changes over time. If joining breaks, the bot saves `meetings/<date>_<code>.error.png` with what the page showed.
- If background noise gets transcribed, raise `VAD_THRESHOLD`. If people get cut off mid-sentence, raise `SILENCE_MS`.

## Tests

- `npm run test:audio`: offline WebRTC loopback (fake mic → WebRTC → capture → VAD).
- `npm run test:voice`: ElevenLabs TTS → fake mic → WebRTC → capture → Scribe STT round trip.
- `npm run test:brain`: answers, memory, an outside-the-workspace attempt, and notes from the configured brain.
- `npm run test:meet -- <meet url>`: opens a Meet link and prints what the pre-join screen shows.
- `npm run test:captions`: with the signed-in profile, starts a throwaway meeting, speaks via TTS and prints caption speaker events.
- `npm run typecheck`

## License

MIT, see [LICENSE](LICENSE).
