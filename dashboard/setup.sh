#!/bin/sh
# =============================================================================
# GetQualify. One command setup for a fresh machine.
#
#   sh setup.sh
#
# Zero npm dependencies, so there is nothing to install. This script just makes
# sure you have Node 18 or newer, a .env to hold your keys, and a data/ folder
# for runtime state, then tells you how to run the server. It is idempotent, so
# running it again is always safe.
# No em dashes anywhere in this codebase. Use commas or periods.
# =============================================================================

set -e

# Resolve the project root to the directory this script lives in, so the script
# works no matter where you call it from.
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT"

PORT_DEFAULT=8787

# ---- pretty output (degrade to plain text if the terminal has no color) -----
if [ -t 1 ]; then
  B=$(printf '\033[1m'); DIM=$(printf '\033[2m'); G=$(printf '\033[32m')
  Y=$(printf '\033[33m'); R=$(printf '\033[31m'); C=$(printf '\033[36m'); X=$(printf '\033[0m')
else
  B=''; DIM=''; G=''; Y=''; R=''; C=''; X=''
fi

say()  { printf '%s\n' "$1"; }
ok()   { printf '%s  ok  %s%s\n' "$G" "$X" "$1"; }
warn() { printf '%s warn %s%s\n' "$Y" "$X" "$1"; }
die()  { printf '%s fail %s%s\n' "$R" "$X" "$1"; exit 1; }

say ""
say "${B}${C}GetQualify${X}  setup"
say "${DIM}provider agnostic AI voice agents, one folder, zero dependencies${X}"
say ""

# ---- 1. Node present and version 18 or newer --------------------------------
if ! command -v node >/dev/null 2>&1; then
  die "Node.js is not installed. Install Node 18 or newer from https://nodejs.org then run this again."
fi

NODE_RAW=$(node -v)                       # e.g. v24.12.0
NODE_MAJOR=$(printf '%s' "$NODE_RAW" | sed 's/^v//' | cut -d. -f1)
case "$NODE_MAJOR" in
  ''|*[!0-9]*) die "Could not read your Node version ($NODE_RAW). Please install Node 18 or newer." ;;
esac
if [ "$NODE_MAJOR" -lt 18 ]; then
  die "Node $NODE_RAW found, but GetQualify needs Node 18 or newer. Please upgrade."
fi
ok "Node $NODE_RAW detected"

# ---- 2. .env (copy from template on first run) ------------------------------
ENV_FILLED=1
if [ -f .env ]; then
  ok ".env already present, leaving it untouched"
else
  if [ -f .env.example ]; then
    cp .env.example .env
    ENV_FILLED=0
    ok "created .env from .env.example"
  else
    warn "no .env and no .env.example found, you will need to create .env by hand"
    ENV_FILLED=0
  fi
fi

# ---- 3. data/ directory for runtime state -----------------------------------
if [ -d data ]; then
  ok "data/ already present"
else
  mkdir -p data
  ok "created data/ for runtime state"
fi
# Keep the directory tracked even though its contents are gitignored.
[ -f data/.gitkeep ] || : > data/.gitkeep

# ---- 4. read the port for the final hint ------------------------------------
PORT="$PORT_DEFAULT"
if [ -f .env ]; then
  ENV_PORT=$(grep -E '^[[:space:]]*PORT=' .env 2>/dev/null | tail -n 1 | cut -d= -f2 | tr -d '[:space:]')
  [ -n "$ENV_PORT" ] && PORT="$ENV_PORT"
fi

# ---- 5. tell the user what to do next ---------------------------------------
say ""
say "${G}Setup complete.${X} Install the pinned WebSocket dependency with pnpm install."
say ""

if [ "$ENV_FILLED" -eq 0 ]; then
  say "${Y}Before you run it, open ${B}.env${X}${Y} and fill in your keys:${X}"
  say "  ${B}RUMIK_API_KEY${X}            your Rumik silk TTS key (the voice)"
  say "  ${B}DEEPGRAM_API_KEY${X}         your Deepgram key (phone transcription)"
  say "  ${B}GROQ_API_KEY${X}             your Groq key (the brain)"
  say "  ${B}DOGRAH_BASE_URL${X}           HTTPS URL of your Dograh deployment"
  say "  ${B}DOGRAH_API_KEY${X}            dedicated Dograh organization API key"
  say "  ${B}DOGRAH_WORKFLOW_ID${X}        outbound Dograh workflow"
  say "  ${B}DOGRAH_TELEPHONY_CONFIG_ID${X} Dograh VoBiz configuration"
  say "  ${B}DOGRAH_PHONE_NUMBER_ID${X}    active VoBiz caller ID in Dograh"
  say "  ${DIM}Optional ElevenLabs, Sarvam, Claude, Zoom, Twilio keys are commented at the bottom.${X}"
  say "  ${DIM}Leave them blank to keep those providers as ready to wire stubs.${X}"
  say ""
fi

say "Then start the server:"
say ""
say "  ${B}node server.js${X}"
say ""
say "and open the console in your browser:"
say ""
say "  ${B}${C}http://localhost:${PORT}${X}"
say ""
say "${DIM}Create an account in the UI, or configure the optional TEST_USER_* bootstrap values in .env.${X}"
say ""
