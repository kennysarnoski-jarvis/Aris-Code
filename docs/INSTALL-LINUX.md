# Installing & Using Aris Code on Linux

Short version: you cloned a developer build. That's why it works fine
but doesn't show up in your Apps menu / Activities / launcher. This
doc covers everything you need to know **after** running the install
script, including the daily-use workflow, how to make it launchable
from your desktop if you want, and how to update.

Tested on Ubuntu 22.04 / 24.04 and Debian 12. Other distros that use
`apt` should work; for Fedora / Arch / openSUSE the same logic applies
but you'll need the equivalent of `libgtk-3-0t64` etc. from your
package manager.

---

## What you have right now

Assuming you ran `scripts/install-linux.sh` (or the one-liner from the
README) and it finished without errors, here's what landed on your
machine:

- **`~/Aris-Code/`** — the source repo, cloned from
  github.com/kennysarnoski-jarvis/Aris-Code.
- **`~/.bun/`** — the Bun runtime (Bun is a Node.js-compatible
  JavaScript runtime; Aris Code uses it to run the server and bundle
  the web/desktop apps).
- **`~/.bashrc`** — got a line added so `bun` is in your PATH every
  time you open a new terminal.
- **`~/.aris/`** — empty for now. This is where Aris Code stores
  per-thread conversation archives, your saved facts, project todos,
  scratchpads, etc. Created on first use.
- Various **system packages** under `/usr/lib/...` — the Electron
  runtime libs (`libgtk-3-0t64`, `libatk-bridge2.0-0t64`,
  `libasound2t64`, etc.).

Nothing got installed into `/usr/local/bin` or anywhere global. The
only thing in your `$PATH` is `bun` (via `~/.bun/bin`).

---

## Why isn't it in my Apps menu?

Because there's no `.desktop` file pointing at it. `.desktop` files are
how GNOME, KDE, XFCE, etc. populate their app launchers — they're
small text files that say "this is the name, this is the icon, this
is what to run." Packaged Linux apps (`.deb`, `.rpm`, AppImage, Snap,
Flatpak) drop one of these into `/usr/share/applications/` or
`~/.local/share/applications/` as part of their install.

**Aris Code isn't packaged yet.** What you have is the developer
build — the same thing the maintainers use day-to-day. It runs via
`bun dev:desktop`, which starts a dev server + an Electron window
together. There's no installer, no system service, no menu entry.

You have two options from here:

1. **Just run it from the terminal** when you want it. This is what
   most developers do because they're in a terminal anyway. See the
   next section.
2. **Create a `.desktop` file yourself** so it shows up in your
   launcher like any other app. Five minutes of one-time setup. See
   the "Make it launchable from your Apps menu" section below.

A packaged AppImage / `.deb` build is on the roadmap but doesn't ship
yet.

---

## Daily use — launching Aris Code from a terminal

Open whatever terminal you normally use (GNOME Terminal, Konsole,
Alacritty, kitty, whatever).

```bash
cd ~/Aris-Code
bun dev:desktop
```

First launch takes about 30 seconds while Vite (the dev server) warms
up and Electron boots. Subsequent launches in the same session are
faster because Vite caches its build.

The Aris Code window appears as a regular X11/Wayland desktop window.
You can minimize it, alt-tab to it, put it on another workspace,
whatever — it's a real window, not a terminal app pretending to be a
window.

**Leave the terminal open.** Closing the terminal kills the dev
server, which kills Aris Code. If that's annoying, the `.desktop`
file approach (below) hides this.

To exit cleanly, close the Aris Code window OR hit `Ctrl+C` in the
terminal.

---

## Make it launchable from your Apps menu (optional)

This creates a `.desktop` file that points at a launcher script, so
Aris Code appears in your Apps menu / Activities / launcher just like
any installed app.

### Step 1 — Create the launcher script

```bash
mkdir -p ~/.local/bin
cat > ~/.local/bin/aris-code <<'EOF'
#!/usr/bin/env bash
# Launches Aris Code's dev build with logs written to ~/.aris/aris-code.log
# so closing the launcher terminal doesn't kill the app.
set -e
LOG="$HOME/.aris/aris-code.log"
mkdir -p "$(dirname "$LOG")"
cd "$HOME/Aris-Code"
# Source bashrc so bun's PATH is picked up even when the .desktop
# launcher runs outside a login shell.
source "$HOME/.bashrc" 2>/dev/null || true
exec bun dev:desktop >>"$LOG" 2>&1
EOF
chmod +x ~/.local/bin/aris-code
```

### Step 2 — Create the .desktop file

```bash
mkdir -p ~/.local/share/applications
cat > ~/.local/share/applications/aris-code.desktop <<'EOF'
[Desktop Entry]
Type=Application
Name=Aris Code
Comment=Desktop coding assistant (Aris / Codex / Claude)
Exec=/home/$USER/.local/bin/aris-code
Icon=utilities-terminal
Terminal=false
Categories=Development;IDE;
StartupNotify=true
EOF
sed -i "s|\$USER|$USER|" ~/.local/share/applications/aris-code.desktop
update-desktop-database ~/.local/share/applications 2>/dev/null || true
```

That last `sed` line substitutes your actual username for `$USER`
because some launchers don't expand environment variables in `Exec=`.

### Step 3 — Find it in your launcher

Open your Apps menu / Activities (`Super` key on most distros) and
type "Aris" — it should appear. Click to launch.

Logs go to `~/.aris/aris-code.log` if anything goes wrong.

### Adding a real icon (optional)

The launcher above uses the generic `utilities-terminal` icon because
the repo doesn't ship a freedesktop-compliant icon at a standard path
yet. To use the Aris Code icon:

```bash
# The repo ships icons in apps/desktop/assets/
cp ~/Aris-Code/apps/desktop/assets/icon-256.png ~/.local/share/icons/aris-code.png 2>/dev/null || true
# Then edit the .desktop file: change Icon=utilities-terminal to Icon=aris-code
sed -i 's|Icon=utilities-terminal|Icon=aris-code|' ~/.local/share/applications/aris-code.desktop
```

If `apps/desktop/assets/icon-256.png` doesn't exist on your build,
look around `apps/desktop/assets/` for whatever icon shape your distro
prefers (PNG is safest; SVG works on most modern launchers).

---

## Updating to the latest version

When new changes land in the repo (vision support, new providers,
bug fixes), you pull and rebuild:

```bash
cd ~/Aris-Code
git pull origin main
bun install
bun run build:desktop
```

Then relaunch with `bun dev:desktop` (or click your Apps-menu entry
if you set one up).

The `bun install` step is usually a no-op but defensive — if a new
dependency landed you'll hit module-not-found errors without it.

The `build:desktop` step is the load-bearing one for server-side
changes. The dev runner only auto-rebuilds the desktop shell and web
UI; the server bundle at `apps/server/dist/bin.mjs` only refreshes
when you explicitly build.

---

## First-launch setup (sign-in)

Once the Aris Code window is open:

1. Click **Settings** (gear icon, usually bottom-left).
2. Find the **Aris** provider card at the top of the providers
   section.
3. Paste your subscription key from
   [youraris.com](https://youraris.com) into the "Subscription key"
   field.
4. The card flips to "Activated" with your remaining balance.
5. Open a project folder via the project picker, start a new thread,
   and send your first message.

The Codex and Claude provider cards work similarly if you'd rather
bring your own model auth — they ask for OpenAI / Anthropic API keys
respectively.

---

## Troubleshooting

### `bun: command not found`

Your current terminal session was opened before the installer added
bun to your PATH. Either open a new terminal, or run
`source ~/.bashrc` in this one. If `~/.bun/bin/bun` doesn't exist
at all, the install failed mid-way — re-run `scripts/install-linux.sh`.

### Window opens but is blank / white

Vite is still warming up. Wait 30 seconds. If it's still blank after a
minute, kill it (`Ctrl+C` in the terminal) and re-run `bun dev:desktop`
— sometimes the dev server and Electron race on first launch.

### `Error: Cannot find module '@t3tools/server/...'` or similar

Your `bun install` is stale relative to the current source. From
`~/Aris-Code` run:

```bash
bun install
bun run build:desktop
```

### Vision (image uploads) doesn't work

Make sure you ran `bun run build:desktop` after pulling. The vision
fix is in the server bundle; without rebuilding, the prebuilt
`apps/server/dist/bin.mjs` is the old code and Aris will silently
reject image attachments.

### "libGL.so.1: cannot open shared object file"

Missing OpenGL libs. On Ubuntu/Debian:

```bash
sudo apt install libgl1 libegl1 libgles2
```

### "GTK / GDK / libgbm" related errors

The Electron runtime libs are missing for your distro version. On
Ubuntu 24.04+ you need the `t64` versions:

```bash
sudo apt install libgtk-3-0t64 libatk-bridge2.0-0t64 libasound2t64
```

On Ubuntu 22.04 and Debian 11, drop the `t64` suffix:

```bash
sudo apt install libgtk-3-0 libatk-bridge2.0-0 libasound2
```

### Wayland-specific window issues

If you're on a Wayland session and the window is glitchy, try forcing
X11 for Aris Code only:

```bash
GDK_BACKEND=x11 bun dev:desktop
```

(If you used the `.desktop` launcher, add this to the `Exec=` line
or to your `~/.local/bin/aris-code` script before the `exec bun` line.)

### "Permission denied" writing to `~/.aris/`

Check your home directory isn't read-only (NFS mounts, encrypted
homes that aren't unlocked, etc.). Aris Code needs to write to
`~/.aris/` for conversation archives, facts, todos, and scratchpads.

### Something else

[Open an issue on GitHub](https://github.com/kennysarnoski-jarvis/Aris-Code/issues)
with:

- Your distro and version (`lsb_release -a` or `cat /etc/os-release`)
- Your desktop environment (GNOME, KDE, XFCE, etc.) and whether
  you're on X11 or Wayland (`echo $XDG_SESSION_TYPE`)
- The exact error message
- Which step you were on

---

## Uninstalling

If you want to remove Aris Code completely:

```bash
rm -rf ~/Aris-Code            # source repo
rm -rf ~/.aris                # conversation archives, facts, todos
rm -rf ~/.bun                 # Bun runtime (only if you're not using
                              # Bun for anything else)
rm -f  ~/.local/bin/aris-code                            # launcher
rm -f  ~/.local/share/applications/aris-code.desktop     # Apps entry
rm -f  ~/.local/share/icons/aris-code.png                # icon
```

You'll also have a line in `~/.bashrc` adding bun to your PATH — feel
free to delete it manually if you removed `~/.bun`. The system
packages (`libgtk-3-0t64` etc.) are shared with other Electron apps;
leave them.
