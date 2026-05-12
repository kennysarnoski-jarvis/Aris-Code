# Installing Aris Code on Windows — Detailed Walkthrough

This is the **step-by-step beginner-friendly** guide. Every click,
every command, every "what should I see now" — all spelled out. If
you've never opened PowerShell before, you're in the right place.

The whole process takes about **30 to 45 minutes** including a reboot.
Most of that is waiting for downloads. Active typing time is maybe
5 minutes total.

> ⚡ **TL;DR for power users:** open admin PowerShell, run
> `iex (irm https://raw.githubusercontent.com/kennysarnoski-jarvis/Aris-Code/main/scripts/install-windows.ps1)`,
> follow the prompts. The rest of this doc is for folks who want the
> walkthrough.

---

## Before you start — check these three things

1. **You have Windows 10 (version 2004 or newer) or Windows 11.** If
   you're not sure, press `Windows key + R`, type `winver`, hit Enter.
   You'll see a popup showing your version. Anything from 2020 onward
   is fine.
2. **Your Windows user account has administrator rights.** If your
   computer is from work / school and managed by an IT department,
   you might not have admin. The install needs admin to enable a
   Windows feature called WSL2 — without admin, this won't work and
   you'll need to use a personal computer instead.
3. **Your Windows clock is set correctly.** Click the clock in the
   bottom-right corner of your screen — make sure the date and time
   look right. If the year shows something weird like 2020 or 2030,
   right-click the clock → "Adjust date and time" → turn ON "Set time
   automatically." Wrong clocks cause cryptic SSL/certificate errors
   later, so fix this NOW even if it looks fine.

---

## Step 1 — Open PowerShell as Administrator

This is the trickiest part because Windows has multiple ways to do it
and they look different on Windows 10 vs Windows 11. Pick whichever
works for you.

**Method A — keyboard shortcut (works everywhere):**

1. Hold down the **Windows key** and press **X** (the letter X).
2. A menu pops up from the bottom-left. Look for one of these:
   - **Terminal (Admin)** ← click this on Windows 11
   - **Windows PowerShell (Admin)** ← click this on Windows 10
3. A popup might ask "Do you want to allow this app to make changes
   to your device?" Click **Yes**.

**Method B — search and elevate:**

1. Press the **Windows key** to open the Start menu.
2. Type `powershell` (just start typing, the search box appears
   automatically).
3. You'll see "Windows PowerShell" highlighted in the search results.
   **DON'T just click it.** Instead:
   - On the right side of the search panel, look for "Run as
     administrator" and click that, OR
   - Hold **Ctrl + Shift** and press **Enter** at the same time.
4. UAC popup → click **Yes**.

**Method C — file explorer fallback:**

1. Open File Explorer (press **Windows key + E**).
2. In the address bar at the top, type `C:\Windows\System32\WindowsPowerShell\v1.0\` and hit Enter.
3. Find the file named `powershell.exe`.
4. Right-click it → "Run as administrator."
5. UAC popup → click **Yes**.

### How to confirm you're in admin PowerShell

After it opens, look at the **title bar at the top of the window**. It
should say something like:

```
Administrator: Windows PowerShell
```

or

```
Administrator: Windows Terminal
```

**If the title bar does NOT say "Administrator," close the window and
try again.** The install won't work without admin.

### Sanity check (optional but helpful)

In the PowerShell window, type this and press Enter:

```powershell
$PSVersionTable.PSVersion
```

You should see a table of numbers like `5.1.22621.xxxx`. If you get
"command not found" or similar, you're NOT in PowerShell — you opened
a different terminal by accident. Close it and try Method A again.

---

## Step 2 — Run the install command (first time)

In the admin PowerShell window, **type or paste this exact command**
and press Enter:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
```

You won't see any output. The command just told PowerShell "for this
window only, allow me to run downloaded scripts." It expires when you
close the window, so it's safe.

Then **type or paste this command** and press Enter:

```powershell
iex (irm https://raw.githubusercontent.com/kennysarnoski-jarvis/Aris-Code/main/scripts/install-windows.ps1)
```

### What happens next (Phase 1 — WSL2 install)

You should immediately see text starting to scroll past:

```
==> Pre-flight checks
    [OK] Running as Administrator
    [OK] Windows build 22621 supports WSL2

==> Phase 1 — Installing WSL2 and Ubuntu
    Running 'wsl --install' (downloads + enables WSL2 features)...
```

This phase takes **5 to 10 minutes** depending on your internet speed.
Windows is downloading a Linux kernel and the Ubuntu operating system.
You'll see lots of download progress bars. **Just wait.** Don't close
the window.

When Phase 1 finishes, you'll see a big yellow message:

```
═══════════════════════════════════════════════════════════════
  REBOOT REQUIRED
═══════════════════════════════════════════════════════════════

  WSL2 was just enabled. Reboot Windows, then re-run this same
  install command in a new admin PowerShell.
```

**This means: save anything important, close all your apps, and
reboot Windows now.** Click Start → power button → Restart.

---

## Step 3 — After reboot, finish setting up Ubuntu

When Windows comes back up:

1. **Open the Start menu**, type `Ubuntu`, click the Ubuntu app icon.
   A black terminal window opens, but THIS time it shows setup text:

   ```
   Installing, this may take a few minutes...
   Please create a default UNIX user account. The username does not
   need to match your Windows username.
   For more information visit: https://aka.ms/wslusers
   Enter new UNIX username:
   ```

2. **Type a username.** Rules:
   - All lowercase letters
   - No spaces or special characters (just letters and numbers)
   - Example: `kenny` or `mike` or `kevin23`
   - This does NOT need to match your Windows account name
   - **Remember this username** — you'll see it on every prompt later

3. Press Enter. It'll ask for a password:

   ```
   New password:
   ```

4. **Type a password.** ⚠️ **You won't see anything as you type —
   not even dots or asterisks.** This is normal for Linux. Just type
   it and press Enter.

5. It'll ask you to retype the password:

   ```
   Retype new password:
   ```

6. Type the same password again. Press Enter.

7. You should see:

   ```
   passwd: password updated successfully
   Installation successful!
   ```

   ...followed by a prompt that looks like:

   ```
   yourname@yourpc:~$
   ```

   That `$` at the end is the Linux prompt. You can type commands here
   later, but for now we'll go back to PowerShell.

8. **Leave this Ubuntu window open.** Don't close it. You can minimize
   it if you want.

---

## Step 4 — Run the install command (second time)

Go back to your **admin PowerShell window** (the one from Step 1). If
you closed it, re-open admin PowerShell using Method A from Step 1,
then run `Set-ExecutionPolicy -Scope Process Bypass -Force` again
first.

Now paste this same command as before:

```powershell
iex (irm https://raw.githubusercontent.com/kennysarnoski-jarvis/Aris-Code/main/scripts/install-windows.ps1)
```

### What happens next (Phase 2 — Aris Code install inside Ubuntu)

This time the script detects WSL is ready and runs the Linux installer
inside Ubuntu. You'll see a long stream of output as it:

1. Updates Ubuntu's package list (`apt update`)
2. Installs ~30 small packages (build tools, libraries) — you'll see
   a wall of `Get:` and `Setting up:` lines
3. Installs Node.js 22 (downloading ~30 MB)
4. Installs Bun (downloading ~15 MB)
5. Installs node-gyp via npm
6. Clones the Aris Code repository from GitHub
7. Runs `bun install` (this is the longest single step — downloads
   the Electron binary which is ~120 MB, compiles a native module)

**Total time for Phase 2: 10 to 20 minutes.** Your fan might spin up.
That's normal — compiling stuff.

You'll know it finished when you see:

```
═══════════════════════════════════════════════════════════════
  Aris Code is installed and ready to launch
═══════════════════════════════════════════════════════════════

  Launch from your Ubuntu terminal (Start menu → Ubuntu):

      cd ~/Aris-Code
      bun dev:desktop
```

---

## Step 5 — Launch Aris Code

1. Switch to your **Ubuntu window** (the one from Step 3) — or
   re-open it from Start menu → Ubuntu if you closed it.

2. At the `yourname@yourpc:~$` prompt, type:

   ```bash
   cd ~/Aris-Code
   ```

   Press Enter. The prompt should now show `~/Aris-Code$` at the end.

3. Type:

   ```bash
   bun dev:desktop
   ```

   Press Enter. You'll see a wall of text scroll past — Vite warming
   up, server starting, etc. **Wait 30 to 60 seconds on first launch.**

4. **The Aris Code window should appear on your Windows desktop**,
   looking like any other Windows app. If it doesn't:
   - Check your Windows taskbar at the bottom — sometimes the window
     opens minimized or behind other windows.
   - If you're on Windows 10 and the window doesn't appear, you might
     be missing WSLg (the GUI bridge). See Troubleshooting below.

5. **Keep the Ubuntu terminal window open** while you use Aris Code.
   Closing it will close the app.

---

## Step 6 — Get your subscription key

1. Open your web browser, go to **[youraris.com](https://youraris.com)**.
2. Click "Sign up" or "Sign in" (top right).
3. Create an account or log in.
4. Once logged in, find your **subscription key**. It looks like:
   ```
   sk_live_abc123def456...
   ```
   (a long string starting with `sk_live_`).
5. Copy that key (Ctrl+C).

---

## Step 7 — Activate the key in Aris Code

1. In the Aris Code app window, look for a **gear icon** (Settings) —
   usually top-right or in a sidebar.
2. Click the gear → **Settings** opens.
3. Find the **Aris provider card** (the one with Aris's branding).
4. There's a text field labeled something like "Subscription key" or
   "Paste your key here."
5. Click that field, paste your key (Ctrl+V), click **Activate**.
6. After a moment, you should see a **balance indicator** appear in
   the chat header at the top — usually shows your account email and
   current balance (e.g. `$10.00`).

You're in. Pick **Aris** from the model picker in the chat composer,
type your first message, hit send. You're now talking to Aris with the
knowledge graph + web search + memory all wired up.

---

## Troubleshooting

### "command not found: Set-ExecutionPolicy" or similar

You're not in PowerShell — you accidentally opened Command Prompt
(cmd.exe) or Git Bash. Close that window, follow Step 1 again
carefully, and confirm by running `$PSVersionTable.PSVersion`.

### PowerShell shows a `>` prompt and just sits there

That's PowerShell's continuation prompt — it thinks you typed an
unfinished command (usually because a quote got pasted weirdly).
Press **Ctrl+C** to bail out, then re-type the command manually
instead of pasting.

### "The date in the certificate is invalid or has expired"

Your Windows clock is wrong. Right-click the taskbar clock → "Adjust
date and time" → turn ON "Set time automatically" → click "Sync now."
Close PowerShell, open a NEW admin PowerShell, try again.

### "WSL has no installed distributions"

Means WSL is installed but Ubuntu isn't. Run these two commands in
admin PowerShell, then re-run the install command:

```powershell
wsl --list --online
wsl --install Ubuntu
```

### Ubuntu opens but never asks for username/password — just shows `root@`

Means a previous install partially completed. In admin PowerShell:

```powershell
wsl --unregister Ubuntu
wsl --install Ubuntu
```

Then re-run the Aris Code install command.

### `bun dev:desktop` runs but no window appears (Windows 10 only)

You're missing WSLg (the GUI bridge that lets Linux apps draw windows
on Windows). Windows 11 has it built in; Windows 10 needs manual
setup. Follow Microsoft's guide:
[Run Linux GUI apps with WSL](https://learn.microsoft.com/en-us/windows/wsl/tutorials/gui-apps)

### "Permission denied" or "chmod failed" errors

You're trying to work inside `/mnt/c/...` (your Windows C drive). Move
your work to `~/` (your Linux home directory) instead:

```bash
cd ~
```

Then continue from there.

### Install ran but I'm not sure if it finished

Open Ubuntu terminal, run:

```bash
cd ~/Aris-Code && ls
```

If you see folders like `apps/`, `packages/`, `scripts/`, `node_modules/`,
the install succeeded. Run `bun dev:desktop` from there.

### Something else is broken

[Open an issue on GitHub](https://github.com/kennysarnoski-jarvis/Aris-Code/issues)
with:
- Your Windows version (run `winver`)
- The full error message you saw
- Which step you were on

---

## What happens next time you want to use Aris Code?

No more install needed. Just:

1. Open **Start menu → Ubuntu**
2. Type:
   ```bash
   cd ~/Aris-Code
   bun dev:desktop
   ```
3. Window appears, you're in.

To update Aris Code with the latest changes:

```bash
cd ~/Aris-Code
git pull
bun install
bun dev:desktop
```
