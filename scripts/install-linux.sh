#!/usr/bin/env bash
#
# Aris Code — Linux / WSL2 installer
# ----------------------------------------------------------------------
# One-shot setup for Ubuntu / Debian (native or inside WSL2):
#   - apt update + Electron runtime libs + build toolchain
#   - Node.js 22 via NodeSource
#   - Bun (latest), wired into ~/.bashrc PATH
#   - node-gyp globally (lets node-pty compile its native binding)
#   - Clones github.com/kennysarnoski-jarvis/Aris-Code into ~/Aris-Code
#   - Runs `bun install` to fetch + build dependencies
#
# Idempotent — safe to re-run. Detects what's already installed and
# skips those steps. Bails with a useful error on first failure.
#
# Usage (one-liner):
#   curl -fsSL https://raw.githubusercontent.com/kennysarnoski-jarvis/Aris-Code/main/scripts/install-linux.sh | bash
#
# Or after cloning:
#   bash scripts/install-linux.sh
#
# After this script finishes, launch the app with:
#   cd ~/Aris-Code && bun dev:desktop
#

set -euo pipefail

# ── Colors / helpers ────────────────────────────────────────────────
GREEN="\033[0;32m"
YELLOW="\033[1;33m"
RED="\033[0;31m"
BLUE="\033[0;36m"
BOLD="\033[1m"
RESET="\033[0m"

step()    { echo -e "\n${BLUE}${BOLD}==>${RESET} ${BOLD}$1${RESET}"; }
ok()      { echo -e "    ${GREEN}✓${RESET} $1"; }
skip()    { echo -e "    ${YELLOW}↷${RESET} $1 (already installed)"; }
warn()    { echo -e "    ${YELLOW}!${RESET} $1"; }
die()     { echo -e "\n${RED}${BOLD}✗ ERROR:${RESET} ${RED}$1${RESET}\n" >&2; exit 1; }

# ── Pre-flight ──────────────────────────────────────────────────────
step "Pre-flight checks"

if [ "$(id -u)" -eq 0 ]; then
  die "Don't run this script as root. It uses sudo only where needed (apt + npm -g).\n         Run as your normal user — you'll be prompted for sudo password when needed."
fi

if ! command -v apt >/dev/null 2>&1; then
  die "This script supports Debian/Ubuntu (apt). For other distros, install equivalent packages manually — see README's Linux section."
fi

if ! command -v sudo >/dev/null 2>&1; then
  die "sudo is required but not installed. On a fresh container: 'apt install -y sudo' (as root) and add your user to the sudo group."
fi

UBUNTU_CODENAME="$(lsb_release -cs 2>/dev/null || echo unknown)"
ok "Detected Ubuntu/Debian release: ${UBUNTU_CODENAME}"

# Detect t64 package availability — Ubuntu 24.04+ renamed several
# Electron-runtime libs with the t64 suffix during the 64-bit time_t
# transition. Older Ubuntu/Debian still uses the un-suffixed names.
USE_T64_NAMES="false"
if apt-cache show libatk-bridge2.0-0t64 >/dev/null 2>&1; then
  USE_T64_NAMES="true"
  ok "Using t64-suffixed library names (Ubuntu 24.04+)"
else
  ok "Using legacy library names (pre-Ubuntu-24.04)"
fi

# ── apt: build toolchain + Electron runtime libs ────────────────────
step "Installing build toolchain + Electron runtime libraries (apt)"

if [ "$USE_T64_NAMES" = "true" ]; then
  APT_PACKAGES=(
    build-essential
    python3
    git
    curl
    unzip
    libnss3
    libatk-bridge2.0-0t64
    libgtk-3-0t64
    libgbm1
    libasound2t64
  )
else
  APT_PACKAGES=(
    build-essential
    python3
    git
    curl
    unzip
    libnss3
    libatk-bridge2.0-0
    libgtk-3-0
    libgbm1
    libasound2
  )
fi

sudo apt update
sudo apt install -y "${APT_PACKAGES[@]}"
ok "apt packages installed: ${APT_PACKAGES[*]}"

# ── Node.js 22 (NodeSource) ─────────────────────────────────────────
step "Installing Node.js 22"

NEED_NODE_INSTALL="true"
if command -v node >/dev/null 2>&1; then
  CURRENT_NODE_MAJOR="$(node -v | sed -E 's/^v([0-9]+)\..*/\1/')"
  if [ "$CURRENT_NODE_MAJOR" -ge 22 ]; then
    skip "Node.js v$(node -v | sed 's/^v//') already meets the >=22 requirement"
    NEED_NODE_INSTALL="false"
  else
    warn "Node.js v$(node -v | sed 's/^v//') is too old; installing v22 over it"
  fi
fi

if [ "$NEED_NODE_INSTALL" = "true" ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt install -y nodejs
  ok "Node.js installed: $(node -v)"
fi

# ── Bun ─────────────────────────────────────────────────────────────
step "Installing Bun"

# Bun goes to ~/.bun/bin/bun. We add that to PATH for this script's
# remaining steps, then make sure ~/.bashrc has the export so future
# terminals pick it up too. The official installer SHOULD do this but
# isn't always reliable across environments — we belt + suspenders it.
if [ -x "$HOME/.bun/bin/bun" ]; then
  skip "Bun already installed at ~/.bun/bin/bun"
else
  curl -fsSL https://bun.sh/install | bash >/dev/null
  if [ ! -x "$HOME/.bun/bin/bun" ]; then
    die "Bun install completed but ~/.bun/bin/bun isn't there. Re-run, or check https://bun.sh for manual install steps."
  fi
  ok "Bun installed at ~/.bun/bin/bun"
fi

# Ensure PATH is set in ~/.bashrc (idempotent — only adds if missing)
BUN_PATH_LINE='export PATH=$PATH:$HOME/.bun/bin'
if ! grep -Fq "$BUN_PATH_LINE" "$HOME/.bashrc" 2>/dev/null; then
  echo "$BUN_PATH_LINE" >> "$HOME/.bashrc"
  ok "Added bun to PATH in ~/.bashrc"
else
  skip "~/.bashrc already exports bun's PATH"
fi

# Make bun available for the rest of THIS script (a fresh terminal
# will pick it up from ~/.bashrc next time).
export PATH="$PATH:$HOME/.bun/bin"

if ! command -v bun >/dev/null 2>&1; then
  die "Bun installed but still not on PATH for this script. Open a new terminal and re-run."
fi
ok "Bun version: $(bun --version)"

# ── node-gyp (global) ───────────────────────────────────────────────
step "Installing node-gyp globally"

# node-pty's postinstall shells out to `node-gyp` to compile its
# native binding. Without this, bun install fails with
# 'node-gyp: command not found' during node-pty's build script.
if command -v node-gyp >/dev/null 2>&1; then
  skip "node-gyp already on PATH"
else
  sudo npm install -g node-gyp
  ok "node-gyp installed: $(node-gyp --version 2>&1 | head -1)"
fi

# ── Clone the repo ──────────────────────────────────────────────────
step "Cloning Aris Code into ~/Aris-Code"

ARIS_DIR="$HOME/Aris-Code"
if [ -d "$ARIS_DIR/.git" ]; then
  skip "~/Aris-Code already exists; pulling latest"
  ( cd "$ARIS_DIR" && git pull --ff-only )
else
  git clone https://github.com/kennysarnoski-jarvis/Aris-Code.git "$ARIS_DIR"
  ok "Cloned into $ARIS_DIR"
fi

# ── Install dependencies ────────────────────────────────────────────
step "Running bun install (this is the slow one — Electron binary downloads here)"

cd "$ARIS_DIR"
bun install
ok "bun install completed"

# ── Done ────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}═══════════════════════════════════════════════════════════════${RESET}"
echo -e "${GREEN}${BOLD}  ✓ Aris Code is installed and ready to launch${RESET}"
echo -e "${GREEN}${BOLD}═══════════════════════════════════════════════════════════════${RESET}"
echo ""
echo -e "  Open a ${BOLD}new${RESET} terminal (so bun's PATH refreshes) and run:"
echo ""
echo -e "      ${BOLD}cd ~/Aris-Code${RESET}"
echo -e "      ${BOLD}bun dev:desktop${RESET}"
echo ""
echo -e "  First launch takes ~30s while Vite warms up. The Aris Code window"
echo -e "  appears as a regular desktop window (via WSLg on Windows, X11 / Wayland"
echo -e "  on native Linux)."
echo ""
echo -e "  Sign-in path: open Settings → Aris provider card → paste your"
echo -e "  subscription key from ${BOLD}https://youraris.com${RESET}."
echo ""
