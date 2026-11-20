#!/usr/bin/env bash
# YoMeet setup: installs and checks everything that can be done without a human.
# Safe to re-run. Usage: scripts/setup.sh [--check]   (--check = report only, install nothing)
# Exit code 0 = ready to run; 1 = something needs attention (see the "TODO" lines).
set -u
cd "$(dirname "$0")/.."
CHECK=0; [ "${1:-}" = "--check" ] && CHECK=1
OS=$(uname -s)
todo=0
ok()   { printf '  \033[32mok\033[0m    %s\n' "$*"; }
fix()  { printf '  \033[33mfix\033[0m   %s\n' "$*"; }
need() { printf '  \033[31mTODO\033[0m  %s\n' "$*"; todo=1; }
have() { command -v "$1" >/dev/null 2>&1; }
# sudo without a password prompt if possible (agents can't type passwords)
SUDO=""; if [ "$(id -u)" != 0 ]; then if sudo -n true 2>/dev/null; then SUDO="sudo -n"; else SUDO="NOSUDO"; fi; fi
apt_install() {
  if [ "$CHECK" = 1 ]; then need "install $* (apt)"; return; fi
  if [ "$SUDO" = NOSUDO ]; then need "run: sudo apt-get install -y $*"; return; fi
  fix "installing $* (apt)"; $SUDO apt-get update -qq && $SUDO apt-get install -y -qq "$@" >/dev/null && ok "$* installed"
}
# value of KEY in .env, without quotes or an inline "# comment"
envval() { [ -f .env ] && grep -E "^$1=" .env | tail -1 | cut -d= -f2- | sed -E 's/^"(.*)"$/\1/; s/[[:space:]]+#.*$//; s/[[:space:]]+$//' ; }

echo "== System"
if have node && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; then ok "node $(node -v)"
else need "install Node.js 20+ (e.g. https://nodejs.org or nvm: nvm install 22)"; fi
if [ "$OS" = Linux ]; then
  have xvfb-run && ok "xvfb-run" || apt_install xvfb
fi
if have docker; then
  if docker info >/dev/null 2>&1; then ok "docker"
  else need "docker is installed but not usable by $(whoami): sudo usermod -aG docker $(whoami), then log out and in (or start the docker service)"; fi
else need "install Docker (https://docs.docker.com/engine/install/), or set SANDBOX=none in .env to run without file tools"; fi

echo "== Project"
if have node; then
  if [ -d node_modules ] && [ "$CHECK" = 1 ]; then ok "node_modules present"
  elif [ "$CHECK" = 0 ]; then fix "npm install"; npm install --no-fund --no-audit --loglevel=error && ok "npm packages"
  else need "npm install"; fi
  if [ -d node_modules/playwright ]; then
    if node -e "require('fs').accessSync(require('playwright').chromium.executablePath())" 2>/dev/null; then ok "playwright chromium"
    elif [ "$CHECK" = 0 ]; then fix "installing chromium"; npx playwright install chromium >/dev/null && ok "playwright chromium"
    else need "npx playwright install chromium"; fi
    if [ "$OS" = Linux ] && [ "$CHECK" = 0 ]; then
      if [ "$SUDO" != NOSUDO ]; then $SUDO env PATH="$PATH" npx playwright install-deps chromium >/dev/null 2>&1 && ok "chromium system libraries" || need "run: sudo npx playwright install-deps chromium"
      else need "if Chrome fails to start, run: sudo npx playwright install-deps chromium"; fi
    fi
  fi
fi
if [ -f .env ]; then ok ".env exists"
elif [ "$CHECK" = 0 ]; then cp .env.example .env && chmod 600 .env && fix "created .env from .env.example"
else need "cp .env.example .env"; fi

echo "== Brain (Claude)"
BRAIN=$(envval BRAIN); BRAIN=${BRAIN:-claude-code}
SANDBOX=$(envval SANDBOX); SANDBOX=${SANDBOX:-docker}
if [ "$BRAIN" = api ]; then
  [ -n "$(envval ANTHROPIC_API_KEY)" ] && ok "ANTHROPIC_API_KEY set" || need "BRAIN=api needs ANTHROPIC_API_KEY in .env"
else
  if [ -n "$(envval CLAUDE_CODE_OAUTH_TOKEN)" ]; then ok "CLAUDE_CODE_OAUTH_TOKEN set"
  elif [ -f "$HOME/.claude/.credentials.json" ]; then ok "Claude Code login found (~/.claude/.credentials.json); a dedicated token is safer, see README"
  else need "HUMAN: run 'claude setup-token' (needs a browser) and put the token in .env as CLAUDE_CODE_OAUTH_TOKEN"; fi
  if [ "$SANDBOX" = none ]; then
    have claude && ok "claude CLI" || { [ "$CHECK" = 0 ] && fix "npm i -g @anthropic-ai/claude-code" && npm i -g @anthropic-ai/claude-code --loglevel=error >/dev/null && ok "claude CLI"; } || need "npm i -g @anthropic-ai/claude-code"
  elif docker info >/dev/null 2>&1 && [ -d node_modules ]; then
    if [ "$CHECK" = 0 ]; then npx tsx -e "import('./src/sandbox.ts').then((s) => s.ensureImage()).catch((e) => { console.error(e.message); process.exit(1); })" && ok "sandbox image" || need "sandbox image failed to build (see above)"
    else ok "docker ready (sandbox image builds on first run)"; fi
  fi
fi

echo "== Voice (ElevenLabs)"
KEY=$(envval ELEVENLABS_API_KEY)
if [ -z "$KEY" ]; then need "HUMAN: add ELEVENLABS_API_KEY to .env (https://elevenlabs.io/app/settings/api-keys; needs text-to-speech + speech-to-text)"
else
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID:-JBFqnCBsd6RMkjVDRZzb}?output_format=pcm_16000" \
    -H "xi-api-key: $KEY" -H 'content-type: application/json' -d '{"text":"ok","model_id":"eleven_flash_v2_5"}' 2>/dev/null)
  [ "$code" = 200 ] && ok "ElevenLabs key works" || need "ElevenLabs key rejected (HTTP $code): check it has text-to-speech and speech-to-text access"
fi

echo "== Checks"
if [ -d node_modules ]; then
  npx tsc --noEmit -p . && ok "typecheck" || need "typecheck failed"
fi

echo
if [ "$todo" = 0 ]; then
  echo "Ready. Start the dashboard:  npm run server   (http://127.0.0.1:8090)"
  echo "Then, in the dashboard: Settings → Google account → Sign in to Google (a human signs in once)."
else
  echo "Not ready yet: handle the TODO lines above, then re-run scripts/setup.sh."
fi
exit $todo
