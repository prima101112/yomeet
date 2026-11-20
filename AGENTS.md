# AGENTS.md

Instructions for coding agents (Claude Code, Codex, etc.) working on YoMeet. Installing it for someone? Follow [AGENT_INSTALL.md](AGENT_INSTALL.md). Humans: see README.md.

## What this is

A Google Meet bot.
- Playwright Chrome joins the call. ElevenLabs does speech-to-text and text-to-speech.
- Claude answers out loud, through Claude Code sandboxed in Docker, or through the Anthropic API.
- It writes Markdown notes to `~/yomeetnotes/meetings/`.
- A small dashboard (`npm run server`, port 8090) manages it.

TypeScript (ESM) is run directly with `tsx`. There is no build step.

## Install

**To install YoMeet for a user, follow [AGENT_INSTALL.md](AGENT_INSTALL.md) step by step.** It covers the setup script, the keys and the Google sign-in that need the human, starting the dashboard, verifying, and what to report back.

In short: `scripts/setup.sh` installs and checks everything it can (exit 0 = ready; `--check` = report only). Fix its `TODO` lines and re-run it. Lines starting with `HUMAN:` need the user.

Never ask for or handle the user's Google password. Don't put secrets anywhere but `.env`, and never commit `.env` (it's git-ignored).

## Run

```bash
npm run server                                  # dashboard on http://127.0.0.1:8090
npm start -- https://meet.google.com/abc-defg-hij   # or one bot from the command line
```

- **Displays:**
  - On Linux the dashboard runs bots on a private Xvfb display, `YOMEET_DISPLAY` (default `:99`). The Google sign-in window uses the desktop when `$DISPLAY` is set.
  - On macOS everything uses the normal screen.
  - `bin/yomeet` wraps itself in `xvfb-run` when there's no display.
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
| `scripts/setup.sh` | Idempotent installer/checker used by AGENT_INSTALL.md |

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
