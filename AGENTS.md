# AGENTS.md

Instructions for coding agents (Claude Code, Codex, etc.) installing, running or changing YoMeet. Humans: see README.md.

## What this is

A Google Meet bot.
- Playwright Chrome joins the call. ElevenLabs does speech-to-text and text-to-speech.
- Claude answers out loud, through Claude Code sandboxed in Docker, or through the Anthropic API.
- It writes Markdown notes to `~/yomeetnotes/meetings/`.
- A small dashboard (`npm run server`, port 8090) manages it.

TypeScript (ESM) is run directly with `tsx`. There is no build step.

## Install

Run the setup script. It is idempotent and safe to re-run:

```bash
scripts/setup.sh           # installs what it can, then reports; exit 0 = ready
scripts/setup.sh --check   # report only, install nothing
```

It handles:
- `npm install`
- Playwright Chromium (and its system libraries on Linux, via passwordless sudo if available)
- Xvfb on Linux
- `.env` from `.env.example`
- building the Docker sandbox image
- checking the ElevenLabs key and the Claude login
- a typecheck

It prints `TODO` lines for anything it couldn't do. Fix them and re-run until it exits 0.

### Steps that need the human

Don't try to work around these; ask the user:
1. **ElevenLabs API key.** It goes in `.env` as `ELEVENLABS_API_KEY` and needs text-to-speech and speech-to-text access.
2. **Claude login.** Ask the user to run `claude setup-token` themselves, since it needs a browser, and put the token in `.env` as `CLAUDE_CODE_OAUTH_TOKEN`. An existing `~/.claude/.credentials.json` also works. Alternatively, `BRAIN=api` with `ANTHROPIC_API_KEY`.
3. **Docker access.** If `docker info` fails, the user may need to be added to the `docker` group (`sudo usermod -aG docker $USER`), then log out and back in. Or set `SANDBOX=none`.
4. **Google sign-in for the bot.** Once the dashboard is running: Settings → Google account → Sign in to Google. The human signs in in the Chrome window that opens, on their screen or through VNC on a server, then presses Done. Never ask for or handle their Google password.
5. **Admitting the bot** into a meeting, in Meet.

Don't put secrets in files other than `.env`, and never commit `.env`. It's git-ignored.

## Run

```bash
npm run server                                  # dashboard on http://127.0.0.1:8090
npm start -- https://meet.google.com/abc-defg-hij   # or one bot from the command line
```

- **Servers without a display:** the dashboard uses Xvfb on `YOMEET_DISPLAY` (default `:99`), and `bin/yomeet` wraps itself in `xvfb-run`.
- **Remote dashboard:** either set `DASHBOARD_PASSWORD` (the server refuses non-loopback `HOST` without it), or put it behind a reverse proxy with auth.
- **Running as a service:** see `sandbox/yomeet.service` and the README.

## Verify

```bash
npm run typecheck
npm run test:audio      # offline: fake mic → WebRTC → capture → VAD (no keys needed)
npm run test:voice      # needs ELEVENLABS_API_KEY
npm run test:brain      # needs the Claude login; uses the sandbox
```
A real end-to-end test needs a human in a Meet call. Ask them to start a meeting, then join it with `npm start -- <link>` or the dashboard.

## Layout

| Path | What |
|---|---|
| `src/index.ts` | One bot: join → listen → wake word / 1-on-1 → answer → notes on exit |
| `src/meet.ts` | Chrome + Meet UI automation (join, admission, captions, leave) |
| `src/inject.js` | Page script: captures remote audio, fake mic/camera, TTS playback, caption speaker names |
| `src/vad.ts`, `src/elevenlabs.ts` | Utterance segmentation; ElevenLabs STT/TTS |
| `src/brain.ts` | Claude: warm `claude -p` stream-json session (or SDK); notes |
| `src/sandbox.ts`, `sandbox/Dockerfile` | Docker sandbox that only mounts the workspace |
| `src/speakers.ts` | Who-said-what from caption timing |
| `src/server.ts`, `web/index.html` | Dashboard API and UI (settings in `.env`, bots as child processes) |
| `src/login.ts` | Google sign-in window for the dashboard |
| `src/config.ts` | All settings (env vars, documented in `.env.example`) |

## Conventions

- Keep `npm run typecheck` clean.
- New settings:
  - add them to `src/config.ts` and `.env.example`;
  - if users should edit them, also add them to `FIELDS` in `src/server.ts`.
- Security defaults matter, because anyone in a call can talk to the bot:
  - keep `WORKSPACE_SHELL` off by default;
  - keep the sandbox mounting only the workspace;
  - keep the dashboard on loopback unless it's password-protected.
- Meet's DOM changes over time. Prefer roles, aria-labels and visible text over class names. When joining breaks, the bot saves `<notes dir>/<date>_<code>.error.png`.
