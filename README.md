# YoMeet

A personal Google Meet bot. It joins your call and transcribes everything with speaker names. It answers questions out loud when you talk to it, and writes meeting notes when the call ends.

> *"Jarvis, what did we decide about the launch date?"*
> **Jarvis:** "March 3rd, with the beta a week earlier."

- **Voice:** ElevenLabs speech-to-text (Scribe) and streaming text-to-speech. It answers in about 2–3 s. Before a slow task, like a web search, it says "Let me look that up."
- **Brain:** Claude, through your Claude Code login (no API key needed) or the Anthropic API.
- **Notes:** written at the end of each call. They have a summary, decisions, action items with owners, open questions and the full transcript, with speaker names taken from Meet's captions.
- **Memory:** *"remember that the codename is Falcon"*. It can also look things up in past meetings.
- **Sandboxed:** the bot's Claude Code runs in Docker and sees only one folder (`~/yomeetnotes`).
- **Dashboard:** send a bot to a call and choose its name (Jarvis, Nova, YoMeet or your own). Watch the live transcript, read notes, edit its memory and manage keys.

## Install with your AI agent (easiest)

Open Claude Code (or Codex, Cursor, …) on the machine that should run the bot and say:

> **Install YoMeet from https://github.com/prima101112/yomeet. Follow its AGENT_INSTALL.md.**

The agent clones the repo and runs the setup script. It fixes what it can, and asks you for the few things only you can do:
- an ElevenLabs API key;
- a Claude login token;
- signing the bot in to Google.

Then it checks everything works. The steps it follows are in [AGENT_INSTALL.md](AGENT_INSTALL.md).

## Install by hand

### Requirements

- Linux or macOS with **Node.js 20+** and **Docker** (for the sandbox).
- **Claude Code** installed and logged in (`claude`), or an Anthropic API key.
- An **ElevenLabs** API key with *Text to Speech* and *Speech to Text* access.
- On a Linux server without a screen: **Xvfb** (`apt install xvfb`). Meet runs in a real (not headless) Chrome.
- A **Google account for the bot**. Meet often refuses signed-out guests ("You can't join this video call"), especially from servers. A separate Gmail just for the bot is best.

### Setup

```bash
git clone https://github.com/prima101112/yomeet.git && cd yomeet
scripts/setup.sh     # installs dependencies, Chromium, Xvfb, .env and the sandbox image, then checks everything
```
The script is safe to re-run, and it lists anything left to do (`TODO` lines). Usually that's:
1. Add your ElevenLabs key to `.env` as `ELEVENLABS_API_KEY`.
2. Run `claude setup-token` and put the token in `.env` as `CLAUDE_CODE_OAUTH_TOKEN`. Or just be logged in to Claude Code.

Then start the dashboard: `npm run server`, then open http://127.0.0.1:8090.

On a remote server the dashboard listens on loopback only. Open it through an SSH tunnel: `ssh -L 8090:127.0.0.1:8090 you@server`.

### Sign the bot in to Google

In the dashboard, go to **Settings → Google account → Sign in to Google**. A Chrome window opens. Sign in there, then press **Done**. The profile is saved in `~/.yomeet/chrome-profile`, and each bot runs on a temporary copy of it.

- **On a desktop** (macOS, or Linux with a screen), the window opens on your screen.
- **On a headless server**, it opens on the virtual display `:99`. View it over VNC, for example:
  1. On the server: `x11vnc -display :99 -localhost -forever -bg`
  2. On your computer: `ssh -L 5900:127.0.0.1:5900 you@server`, then point a VNC viewer at `127.0.0.1:5900`.
  3. If you run noVNC, set `VNC_URL` in `.env` and the dashboard links to it.

## Using it

Paste a Meet link in the dashboard, pick the bot's name and press **Join**. Then admit the bot in Meet. The name is what it shows in Meet, and it's also the word it listens for.

- **Ask it something:** start with its name.
  - *"Jarvis, what did we decide about the launch date?"*
  - *"Hey Jarvis."* (pause) *"Summarize the last ten minutes."*
  - A short chime means it heard you. "Hey Claude" works too.
- **1-on-1:** when it's just you and the bot, you don't need its name. Just talk.
- **Follow-ups:** for 15 s after an answer you can ask again without its name.
- **Memory and notes:**
  - *"Jarvis, remember that the codename is Falcon."*
  - *"What did we decide in last week's meeting?"*
  - *"Save a todo list from this call."*
- **End:** say *"Jarvis, leave the meeting"*, press **Stop** in the dashboard, or end the call. Notes are written to `~/yomeetnotes/meetings/<date>_<code>.md`.

**Pick a name speech recognition gets right.** Real words like *Jarvis* or *Nova* work best. "YoMeet" is often heard as "Umit" or "Yo meat". Avoid everyday words ("Friday", "Max"), or it will jump in whenever they come up. If it doesn't react, say the name clearly at the start of the sentence.

### Command line

```bash
npm start -- https://meet.google.com/abc-defg-hij
BOT_NAME=Nova npm start -- https://meet.google.com/abc-defg-hij
```
It uses a virtual display automatically when there's no screen. Press Ctrl+C to leave and write the notes.

## Configuration

Settings live in `.env`. The dashboard's **Settings** page edits the common ones. All of them are documented in [.env.example](.env.example).

| Setting | Default | What it does |
|---|---|---|
| `ELEVENLABS_API_KEY` | (none) | Required. Speech-to-text and text-to-speech. |
| `CLAUDE_CODE_OAUTH_TOKEN` | (none) | Claude login from `claude setup-token` (otherwise `~/.claude/.credentials.json` is used). |
| `BRAIN` | `claude-code` | `api` uses `ANTHROPIC_API_KEY` instead of Claude Code. |
| `BOT_NAME` | `YoMeet` | Default name and wake word (the dashboard can override it per meeting). |
| `WAKE_WORDS` | name + "claude" | Extra comma-separated wake words. |
| `ONE_ON_ONE` | `true` | Answer everything without the wake word when it's just you and the bot. |
| `FOLLOWUP_SEC` | `15` | How long follow-ups work without the wake word. |
| `LANGUAGE` | auto | Speech language, e.g. `en`, `id`. |
| `ELEVENLABS_VOICE_ID` | first premade voice | The bot's voice. |
| `SANDBOX` | `docker` | `none` runs without Docker (no file tools, web search only). |
| `WORKSPACE_SHELL` | `false` | Lets the bot run commands in its workspace (see Security). |
| `WORKSPACE` | `~/yomeetnotes` | The only folder the bot can see. |
| `VAD_THRESHOLD` / `SILENCE_MS` | `350` / `900` | Raise the first if background noise gets transcribed. Raise the second if people get cut off. |
| `DASHBOARD_PASSWORD`, `HOST`, `PORT` | (none), `127.0.0.1`, `8090` | Dashboard access (see Security). |
| `MAX_BOTS` | `2` | Bots running at once (each is a full Chrome, about 400 MB). |

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

Anyone in a meeting can talk to the bot. Treat what it can do like something you'd let your meeting guests do.

- **Sandbox.** The bot's Claude Code runs in a Docker container that only sees the workspace folder. By default it can read and write files there and search the web. Nothing else on your machine exists for it.
- **`WORKSPACE_SHELL=true`** also lets it run commands (bash, python) in the workspace. The container has internet access and holds your Claude login, so a malicious participant could try to talk the bot into sending that login somewhere. Claude is instructed never to do that. Still, only enable the shell if you trust the people in your calls.
- **Claude login.** Prefer `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) over mounting `~/.claude/.credentials.json`. It's a separate token you can revoke without touching your main login.
- **Dashboard.** It holds your keys and notes, and listens on `127.0.0.1` only.
  - To reach it remotely, use an SSH tunnel, a reverse proxy with authentication, or `DASHBOARD_PASSWORD`. `DASHBOARD_PASSWORD` turns on built-in basic auth. It's required for any non-loopback `HOST`, and you should use HTTPS with it.
  - Requests that change things need an `X-Yomeet: 1` header, which blocks cross-site form attacks.
- **Keys** are stored in `.env` with mode 600.

## Running the dashboard as a service

`sandbox/yomeet.service` is a systemd user unit. Edit the paths in it, then:
```bash
mkdir -p ~/.config/systemd/user && cp sandbox/yomeet.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now yomeet
loginctl enable-linger "$USER"      # keep running after logout
journalctl --user -u yomeet -f      # logs
```
Restarting it makes running bots leave and write their notes first.

## Updating and uninstalling

- **Update:**
  ```bash
  git pull && scripts/setup.sh && systemctl --user restart yomeet
  ```
  Leave out the last command if you don't run it as a service.
- **Uninstall:**
  1. Stop the service: `systemctl --user disable --now yomeet`
  2. Delete the repo folder, `~/.yomeet` (the bot's Google profile) and the Docker images `docker rmi $(docker images -q 'yomeet-sandbox')`.
  3. Your notes in `~/yomeetnotes` are kept until you delete them.

## Troubleshooting

| Problem | Fix |
|---|---|
| "You can't join this video call" | Meet refused a guest. Sign the bot in to Google (Settings → Google account). |
| It joins but never answers | With others in the call, start with its name. Check the live transcript in the dashboard to see what it heard. If the name is misheard, pick another, like *Nova*. |
| Nobody hears it | The host may have muted it. Ask it again after unmuting. The bot unmutes itself when it can. |
| Speaker shows as `Participant` | Captions didn't say who spoke (it turns captions on for its own view). Overlapping speech can also confuse it. |
| Background noise gets transcribed | Raise `VAD_THRESHOLD`. |
| People get cut off mid-sentence | Raise `SILENCE_MS`. |
| Joining broke after a Meet update | Look at `~/yomeetnotes/meetings/*.error.png`, which is what the page showed. Please open an issue. |
| Chrome won't start on Linux | `sudo npx playwright install-deps chromium` |
| `test:brain` fails | Check the Claude login and `docker info`. |

`scripts/setup.sh --check` reports what's missing without changing anything.

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

- `src/inject.js`: page script. Captures meeting audio, replaces the mic and camera, plays TTS and reports caption speaker names.
- `src/meet.ts`: launching Chrome, joining, admission, captions, mute handling, and end and alone detection.
- `src/vad.ts`: splits audio into utterances by energy level.
- `src/elevenlabs.ts`: Scribe STT and streaming TTS.
- `src/speakers.ts`: lines up caption updates with utterances to label who said what.
- `src/brain.ts`: Claude.
  - With Claude Code, one `claude -p` stream-json session stays open per meeting, and the answer is spoken sentence by sentence.
  - With `BRAIN=api`, it uses the Anthropic SDK.
  - Notes use a separate one-shot call.
- `src/sandbox.ts`: the Docker sandbox.
- `src/server.ts` and `web/index.html`: the dashboard.
- `src/login.ts`: the Google sign-in window.

## Notes and limits

- **Tell people it's recording.** The bot's camera tile says it's an AI notetaker, but in many places you legally need everyone's consent to record or transcribe a call.
- This automates the Google Meet web app. Google doesn't offer an official bot API for this, so use it for your own meetings and at your own risk.
- Speaker names are the names shown in Meet. When captions don't say who spoke, a line is labelled `Participant`.
- Meet's UI changes over time. Selectors prefer roles, aria-labels and visible text, but expect occasional breakage.

## Tests

- `npm run test:audio`: offline WebRTC loopback (fake mic → WebRTC → capture → VAD).
- `npm run test:voice`: ElevenLabs TTS → fake mic → WebRTC → capture → Scribe STT round trip.
- `npm run test:brain`: answers, memory, an outside-the-workspace attempt, and notes from the configured brain.
- `npm run test:meet -- <meet url>`: opens a Meet link and prints what the pre-join screen shows.
- `npm run test:captions`: with the signed-in profile, starts a throwaway meeting, speaks via TTS and prints caption speaker events.
- `npm run typecheck`

## Contributing

Issues and pull requests are welcome. [AGENTS.md](AGENTS.md) describes the layout and conventions (it's written for coding agents, but works for humans too). Keep `npm run typecheck` clean and the security defaults intact.

## License

MIT, see [LICENSE](LICENSE).
