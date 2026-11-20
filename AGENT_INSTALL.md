# Installing YoMeet: runbook for AI agents

You are a coding agent (Claude Code, Codex, Cursor, …) and the user asked you to install YoMeet. Follow these steps in order. Do everything you can yourself. Stop and ask the user only at the steps marked **🙋 Human**. When you are done, give the user the report in step 9.

The user can start this with a prompt like:

> Install YoMeet from https://github.com/prima101112/yomeet. Follow its AGENT_INSTALL.md.

## Ground rules

- **Secrets go only in `.env`** (mode 600, git-ignored). Never commit them, print them, or paste them into logs or chat.
- **Never ask for, type, or handle the user's Google password.** The human signs the bot in to Google themselves (step 6).
- **Keep the safe defaults**: the Docker sandbox on, `WORKSPACE_SHELL=false`, and the dashboard on `127.0.0.1`. Only change these if the user explicitly asks, and tell them what it means (README → Security).
- Don't use `sudo` interactively. If something needs root and passwordless sudo isn't available, give the user the exact command to run.

## 1. Get the code

```bash
git clone https://github.com/prima101112/yomeet.git ~/yomeet && cd ~/yomeet
```
If the user wants a different folder, use that. If the folder already exists, run `git pull` in it instead.

## 2. Run the setup script

```bash
scripts/setup.sh
```
It's idempotent, so re-run it as often as you like. It handles these and prints `ok`, `fix` or `TODO` for each:
- Node 20+
- Xvfb
- Docker
- `npm install` and Playwright Chromium (with its system libraries)
- `.env`
- the sandbox image
- the Claude login and the ElevenLabs key
- a typecheck

Exit code 0 means ready.

## 3. Fix the TODO lines

| TODO says | What you do |
|---|---|
| install Node.js 20+ | Install it (e.g. `nvm install 22`), or ask the user. |
| install xvfb / run `sudo apt-get install …` | Run it if you have passwordless sudo, otherwise give the user the command. |
| install Docker | Point the user to https://docs.docker.com/engine/install/. If they don't want Docker, set `SANDBOX=none` in `.env`, which removes the bot's file tools and leaves it web search only. |
| docker is installed but not usable | 🙋 Human: `sudo usermod -aG docker $USER`, then log out and back in. |
| HUMAN: … `claude setup-token` | 🙋 Human, see step 4. |
| HUMAN: add `ELEVENLABS_API_KEY` | 🙋 Human, see step 4. |
| ElevenLabs key rejected | 🙋 Human: the key needs **Text to Speech** and **Speech to Text** access. |
| sandbox image failed / typecheck failed | Read the error output and fix it. |

## 4. 🙋 Human: keys

Ask for both in one message:

1. **ElevenLabs API key.** Create one at https://elevenlabs.io/app/settings/api-keys with *Text to Speech* and *Speech to Text* access. The free tier works for testing.
2. **Claude login.** Ask them to run `claude setup-token` in a terminal on this machine. It opens a browser, then prints a long-lived token.
   - If Claude Code is already logged in here (`~/.claude/.credentials.json` exists), this step is optional. A dedicated token is still safer.
   - Using an Anthropic API key instead: set `BRAIN=api` and `ANTHROPIC_API_KEY`.

Prefer that the user writes the keys into `.env` themselves:
```
ELEVENLABS_API_KEY=...
CLAUDE_CODE_OAUTH_TOKEN=...
```
If they paste a key to you instead, write it into `.env` with a file edit, without echoing it back. Then re-run `scripts/setup.sh` until it exits 0.

Optional: ask what the bot should be called. The default is set by `BOT_NAME` in `.env`, and the dashboard can pick a name per meeting. Real words like *Jarvis* or *Nova* are recognized best.

## 5. Start the dashboard

To try it out:
```bash
npm run server        # http://127.0.0.1:8090
```

To keep it running (Linux, systemd user service):
```bash
sed -e "s#%h/yomeet#$PWD#" -e "s#/usr/bin/node#$(which node)#" \
    -e "s#^Environment=PATH=.*#Environment=PATH=$(dirname "$(which node)"):/usr/local/bin:/usr/bin:/bin#" \
    sandbox/yomeet.service > ~/.config/systemd/user/yomeet.service
systemctl --user daemon-reload && systemctl --user enable --now yomeet
loginctl enable-linger "$USER"     # keeps it running after logout (may need sudo)
```
Run `mkdir -p ~/.config/systemd/user` first if needed.

Check it's up: `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8090/` should print `200`.

**On a remote server**, the dashboard is only on loopback. Tell the user to open it through an SSH tunnel: `ssh -L 8090:127.0.0.1:8090 <user>@<server>`, then visit http://127.0.0.1:8090. Don't expose it publicly. If they insist, they must set `DASHBOARD_PASSWORD`, use HTTPS, and set `HOST` (the server refuses a non-loopback `HOST` without a password).

## 6. 🙋 Human: sign the bot in to Google

Without a Google account, Meet usually refuses the bot ("You can't join this video call"). Recommend a separate Gmail just for the bot.

**On a desktop** (macOS, or Linux with a screen):
1. The user opens the dashboard and goes to **Settings → Google account → Sign in to Google**.
2. A Chrome window opens on their screen. They sign in there and press **Done** in the dashboard.

**On a headless Linux server**, the window opens on the virtual display `:99`, so the user needs a VNC view of it:
1. Open the sign-in window yourself: `curl -s -X POST -H 'X-Yomeet: 1' http://127.0.0.1:8090/api/google/login`
2. Start a VNC server on that display, bound to localhost (`sudo apt-get install -y x11vnc` if needed):
   ```bash
   x11vnc -display :99 -localhost -forever -shared -bg -o /tmp/x11vnc.log
   ```
3. 🙋 Tell the user to:
   - run `ssh -L 5900:127.0.0.1:5900 <user>@<server>` on their computer;
   - connect a VNC viewer to `127.0.0.1:5900`;
   - sign in to Google in the Chrome window there;
   - then tell you they're done.
4. Finish: `curl -s -X POST -H 'X-Yomeet: 1' http://127.0.0.1:8090/api/google/done`. It returns `{"result":{"signedIn":true,...}}` on success. Then stop x11vnc: `pkill x11vnc`.

(If they already run noVNC, set `VNC_URL` in `.env` to its URL and the dashboard links to it.)

## 7. Verify

```bash
npm run test:audio    # offline WebRTC → capture → VAD; prints LOOPBACK_OK
npm run test:voice    # ElevenLabs TTS → WebRTC → Scribe STT round trip
npm run test:brain    # Claude answers, memory, sandbox escape attempt, notes
```
All three should pass. If `test:brain` fails, re-check the Claude login (step 4) and `docker info`.

## 8. 🙋 Human: first call

Ask the user to start a Google Meet and give you the link (or paste it into the dashboard themselves). Then join:
```bash
curl -s -X POST -H 'X-Yomeet: 1' -H 'content-type: application/json' \
  -d '{"url":"https://meet.google.com/abc-defg-hij","name":"Jarvis"}' http://127.0.0.1:8090/api/bots
```
- The user admits the bot in Meet.
- Alone with it, they can just talk. With others in the call, they start with its name: *"Jarvis, what's on the agenda?"*
- A chime means it heard them.
- When they end the call, notes appear in `~/yomeetnotes/meetings/`.

If it doesn't join, look for `~/yomeetnotes/meetings/*.error.png` (a screenshot of what Meet showed) and the bot log in the dashboard.

## 9. Report to the user

Tell them, briefly:
- where it's installed and how to open the dashboard (local URL or SSH tunnel command);
- whether it runs as a service (`journalctl --user -u yomeet -f` for logs);
- the bot's name, and how to talk to it (its name first in group calls; no name needed 1-on-1);
- that notes go to `~/yomeetnotes/meetings/`, and `claude --add-dir ~/yomeetnotes` lets their own Claude Code use them;
- anything left undone (e.g. Google sign-in skipped).

Remind them to tell people in their calls that the bot transcribes.
