#!/usr/bin/env bash
# Foovox installer — macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/redfoo22/foovox/main/install.sh | bash
#
# Installs into ~/.foovox, checks what is missing, and tells you the exact
# command to fix anything it cannot do itself. It deliberately does not install
# Claude Code or sign you in: that is an account decision, and a script that
# quietly authenticates things on your behalf is not one you should pipe into
# bash.

set -euo pipefail

REPO="${FOOVOX_REPO:-https://github.com/redfoo22/foovox.git}"
DIR="${FOOVOX_DIR:-$HOME/.foovox}"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }
info() { printf '  \033[2m%s\033[0m\n' "$1"; }

bold ""
bold "Foovox — talk to Claude Code out loud, from your phone"
echo

# ---- prerequisites we cannot install for you -------------------------------
missing=0

need() {
  if command -v "$1" >/dev/null 2>&1; then ok "$1"; else bad "$1 missing — $2"; missing=1; fi
}

need git    "install Xcode command line tools, or: apt install git"
need node   "install Node 20+ from https://nodejs.org"
need python3 "install Python 3.10+ from https://python.org"

if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$major" -lt 20 ]; then bad "Node $major is too old; 20+ required"; missing=1; fi
fi

# ffmpeg is not optional: replies are sent as mp3, and without an encoder every
# reply is 16x larger and arrives slower than it can be spoken.
if command -v ffmpeg >/dev/null 2>&1; then
  ok "ffmpeg"
else
  bad "ffmpeg missing"
  if [ "$(uname)" = "Darwin" ]; then info "install with: brew install ffmpeg"
  else info "install with: sudo apt install ffmpeg"; fi
  missing=1
fi

if command -v claude >/dev/null 2>&1 || [ -x "$HOME/.local/bin/claude" ]; then
  ok "Claude Code"
else
  bad "Claude Code missing — install from https://claude.com/claude-code"
  missing=1
fi

if [ "$missing" -ne 0 ]; then
  echo
  bold "Install the missing pieces above, then run this again."
  exit 1
fi

# ---- fetch ------------------------------------------------------------------
echo
if [ -d "$DIR/.git" ]; then
  bold "Updating $DIR"
  git -C "$DIR" pull --ff-only
else
  bold "Cloning into $DIR"
  git clone --depth 1 "$REPO" "$DIR"
fi

cd "$DIR"

# ---- dependencies and models ------------------------------------------------
echo
bold "Installing dependencies and speech models"
info "First run downloads about 350 MB of speech models. This takes a few minutes."
node bin/foovox.mjs install

# ---- put `foovox` on PATH ---------------------------------------------------
LINK="/usr/local/bin/foovox"
if [ -w "$(dirname "$LINK")" ]; then
  ln -sf "$DIR/bin/foovox.mjs" "$LINK"
  chmod +x "$DIR/bin/foovox.mjs"
  ok "installed the foovox command"
else
  info "To put it on your PATH:  sudo ln -sf $DIR/bin/foovox.mjs $LINK"
fi

echo
bold "Installed. Next:"
echo
echo "    foovox setup"
echo
info "That checks your machine, starts the services, exposes it over Tailscale"
info "if you have it, and prints pairing codes to open on your phone."
