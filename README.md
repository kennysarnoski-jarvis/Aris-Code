# Aris Code

A desktop coding assistant with a 350,000-concept knowledge graph backing every answer.

Other AI coding tools install yesterday's deps. **Aris Code installs today's.**

## Why Aris Code

Every coding assistant — Cursor, Copilot, Claude Code, Codex, all of them — relies on the underlying LLM's training data. That training stops months ago. Ask any of them about a CVE published last week, the latest Next.js version, or a recent breaking change in a framework — they confidently give you stale answers.

Aris Code asks a knowledge graph instead.

- **350k+ concepts** indexed: CVEs, MITRE ATT&CK, OWASP cheatsheets, framework releases, security patterns, code structures, design patterns
- **Daily refresh** of CVE data straight from NVD — your `search_cve` results are current as of this morning
- **Trained Graph Attention Network** (GATv2, 6 layers, 16 heads) reranks results using subgraph propagation, not just embedding similarity
- **5-pass retrieval pipeline**: version-intent seeding → CVE-id direct lookup → AND-tsquery → OR-tsquery → pgvector HNSW semantic search → GAT rescore

When Aris invokes `search_knowledge`, `search_cve`, or `search_code` mid-conversation, the results land in her context grounded in current data. She cites the graph by name and weaves the findings into her response — not "here's what my training said in 2024."

## What Aris Does For You

Aris is a coding agent first. Drop her into a codebase and she can:

- **Write code that matches your conventions** — reads files before writing, matches existing patterns (indentation, naming, error handling, test style)
- **Debug across a codebase** — uses `grep` / `glob` to chase a bug through call sites, runs `bash` to reproduce locally, surfaces the actual error before guessing
- **Audit dependencies for security issues** — `"is my package.json vulnerable to anything?"` → she searches the knowledge graph for CVEs affecting your pinned versions, NOT what her training thinks the current state is
- **Install today's deps, not yesterday's** — `"set up Next.js"` invokes `search_knowledge` with version-intent detection, returns the _current_ major version + setup pattern from the framework_release graph entries
- **Plan + execute multi-step tasks** — tracks work in a per-project todo list (visible to you in the right sidebar), updates statuses as she completes steps, doesn't re-do completed work
- **Fan out big jobs** — spawns sub-agents for parallel tasks (auditing 4 directories simultaneously, writing tests for multiple modules, etc.) with isolated context windows so the parent doesn't blow its budget
- **Remember things about your project across sessions** — scratchpad for in-flight notes, todos for the task list, facts for things about _you_ (your name, your conventions, your preferences) that persist across every project you open
- **Hold conversations in million-token codebases** — auto-summarizes older parts of the conversation as you approach context limits, archives the full history, retrieves it on demand when relevant
- **Look up specific CVEs and security patterns** — `"is CVE-2024-3094 in my supply chain?"` hits the graph with a direct label lookup, returns the canonical entry with CVSS / CWE / affected products / patch status
- **Find reference implementations** — `"show me a Solidity reentrancy guard"` or `"how does Rust's Iterator trait actually look"` → searches the graph's code-bearing concepts and returns real implementations with context

What Aris **can't** do yet:

- **Vision** — Aris doesn't accept image attachments. Codex and Claude providers do; switch to one of them when you need to share a screenshot.
- **Long-running background jobs** — every action happens in-turn. No "go do this for an hour and come back."

## Capabilities

### Providers

| Provider                   | Models               | Notes                                                                                           |
| -------------------------- | -------------------- | ----------------------------------------------------------------------------------------------- |
| **Aris** (primary)         | V4 Pro · V4 Flash    | DeepSeek V4 wholesale, fronted by `youraris.com`, KG-enriched. Token-pay via your subscription. |
| **Codex**                  | All Codex CLI models | Wraps `codex app-server` (JSON-RPC). Bring your own ChatGPT auth.                               |
| **Claude**                 | All Anthropic models | Wraps the Claude Agent SDK. Bring your own Anthropic key.                                       |
| Cursor / OpenCode / Gemini | —                    | Coming soon                                                                                     |

### File and shell tools (all providers)

- `read_file` · `write_file` · `edit_file` — surgical file edits with automatic diff display
- `bash` — command execution, approval-gated for destructive ops
- `grep` · `glob` · `list_directory` — codebase navigation
- Configurable approval rules per workspace

### Project memory (Aris)

- **Scratchpad** — project-scoped freeform notes that persist across turns and threads
- **Todos** — project task list with `pending` / `in_progress` / `completed` states, surfaced live in the right sidebar
- **Facts** — user-global memory nodes (`{type, label, description, content}`) for things Aris should remember about _you_ across every project (preferences, identity, working style)

### Rolling-window memory (Aris)

- Per-thread `.jsonl` archives in `~/.aris/projects/<key>/sessions/<thread>/`
- Auto-rollover at 920K tokens; older windows summarized and stored
- `list_archives` · `search_archives` · `read_archive_range` tools let Aris pull historical context on demand
- Conversations don't get truncated — they get _summarized and retrievable_

### Multi-agent coordinator mode (Aris)

- `spawn_worker` — Aris can fan out subtasks to isolated sub-agents
- Workers run with their own context window, full tool catalog, and `escalate(reason)` exit signal
- Per-session shared scratchpad — workers read each other's findings
- Live observability in the right sidebar: per-worker status, tool calls, output bytes, elapsed time

### Knowledge graph search (Aris — the moat)

- `search_knowledge` — security / architecture / framework / algorithm / protocol concepts. Reach for it on "how do I…", "what are the tradeoffs of…" questions.
- `search_cve` — specific CVEs, GitHub Security Advisories, package vulnerabilities. Pass 0 of the pipeline does direct label lookup, so `"CVE-2024-3094"` returns the actual CVE, not a similar-vector neighbor.
- `search_code` — structs, enums, traits, interfaces, smart contracts, code examples. Returns reference implementations.
- All three are autonomously invoked — Aris decides when the graph is the right tool.

### Cost transparency (Aris)

- **Live balance pill** in the chat header, color-coded (healthy → warning → critical)
- **Low-balance banner** above the composer when you drop below $0.50
- **Cloud-side hard cutoff** at $0 — server returns HTTP 402, no surprise overdrafts
- **Atomic billing** — Stripe top-ups during long turns are preserved (no race losses)
- Top up at [youraris.com](https://youraris.com)

### UI features

- Live tool execution with collapsible reasoning blocks
- Coordinator activity panel (workers + session scratchpad)
- Project todos panel
- File diff viewer
- Approval popups for sensitive operations (file writes, bash commands)
- Multi-environment support (local + remote)
- Per-provider settings cards with custom model slug support

## Get Aris Code

> [!NOTE]
> **No prebuilt binaries yet.** Signed installers (Homebrew cask, winget, AUR, .dmg / .exe / AppImage) are planned but not yet shipped. For now, Aris Code runs from source. Watch [github.com/kennysarnoski-jarvis/Aris-Code/releases](https://github.com/kennysarnoski-jarvis/Aris-Code/releases) for the first packaged release.

### Quick install (recommended)

One command per OS. The scripts are idempotent — safe to re-run if anything goes wrong.

**Linux / Ubuntu / WSL2 (inside Ubuntu):**

```bash
curl -fsSL https://raw.githubusercontent.com/kennysarnoski-jarvis/Aris-Code/main/scripts/install-linux.sh | bash
```

Handles: apt deps (auto-detects t64 vs legacy library names for Ubuntu 24.04+), build toolchain, Node.js 22, Bun, node-gyp, repo clone into `~/Aris-Code`, and `bun install`. Takes ~5-10 minutes including the Electron binary download.

> **First time on Linux, or wondering why it's not in your Apps menu?** Read the [Linux install & usage guide](./docs/INSTALL-LINUX.md) — covers daily-use workflow, an optional `.desktop` launcher so Aris Code shows up in your launcher like a regular app, updating between releases, and distro-specific troubleshooting.

**Windows (admin PowerShell):**

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
iex (irm https://raw.githubusercontent.com/kennysarnoski-jarvis/Aris-Code/main/scripts/install-windows.ps1)
```

Handles: WSL2 install + Ubuntu distro install + (after a reboot) bootstraps the Linux script inside WSL2. Two manual touchpoints you'll be guided through: (1) reboot after WSL2 enables, (2) one-time Ubuntu username/password (Ubuntu's first launch is interactive). Total time ~30-45 min including the reboot.

> **First time on Windows?** Read the [step-by-step Windows install walkthrough](./docs/INSTALL-WINDOWS.md) — covers every click from opening admin PowerShell to pasting your subscription key, including how to handle the reboot and one-time Ubuntu setup. ~30 min total, 5 min of active clicking.

**macOS:**

No script yet — Mac install is short enough that the [manual steps](#manual-install) below are quicker than scripting it. `xcode-select --install` then [clone + bun install](#manual-install).

When the install finishes, launch with:

```bash
cd ~/Aris-Code
bun dev:desktop
```

(On Windows, run that from inside Ubuntu — the window appears on your Windows desktop via WSLg.)

---

### Manual install

If you'd rather drive each step yourself, or you're on a distro / OS the script doesn't cover:

> [!IMPORTANT]
> **STOP — install these three things first or nothing will work.** Skip ahead and you'll hit `command not found: bun` or `Cannot find package`. Run all three steps below in order, then verify each one prints a version, _before_ you `git clone`.

### Step 1 — Install Bun (≥ 1.3)

```bash
curl -fsSL https://bun.sh/install | bash
```

After install, **close and reopen your terminal** (or `source ~/.zshrc` on macOS / `source ~/.bashrc` on Linux) so `~/.bun/bin` lands on your `PATH`.

Verify:

```bash
bun --version    # → 1.3.x or higher
```

If you still see `command not found: bun` after reopening the terminal, the installer printed a `PATH` line near the end of its output — copy that line into your shell rc file and reopen the terminal again.

### Step 2 — Install Node.js (22 or newer)

Pick one of these (any of them works):

- **[nvm](https://github.com/nvm-sh/nvm)** — `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash`, reopen terminal, then `nvm install 22 && nvm use 22`
- **[fnm](https://github.com/Schniz/fnm)** — `curl -fsSL https://fnm.vercel.app/install | bash`, reopen terminal, then `fnm install 22 && fnm use 22`
- **Direct installer** — download the 22 LTS installer from [nodejs.org](https://nodejs.org/)
- **Linux package manager** — `sudo apt install nodejs npm` (Debian/Ubuntu), `sudo dnf install nodejs` (Fedora), `sudo pacman -S nodejs npm` (Arch)

Verify:

```bash
node --version   # → v22.x.x or higher
```

### Step 3 — Make sure Git is installed

Most systems have it. Verify first:

```bash
git --version
```

If missing:

- **macOS** — `xcode-select --install` (bundles git plus the C compiler you'll need later — see Platform notes below)
- **Linux** — `sudo apt install git` (Debian/Ubuntu), `sudo dnf install git` (Fedora), `sudo pacman -S git` (Arch)
- **Windows** — install [Git for Windows](https://git-scm.com/download/win), or use the git bundled with WSL2's Ubuntu

---

Got all three? `bun --version`, `node --version`, and `git --version` all print without error? Good — now you can clone the repo.

### Clone and run

```bash
git clone https://github.com/kennysarnoski-jarvis/Aris-Code.git
cd Aris-Code
bun install
bun dev:desktop
```

That's it. The Electron app launches with hot reload — file changes in `apps/web/` rebuild and refresh automatically; changes in `apps/server/` or the Electron main process restart on save.

**Subsequent launches** — once the repo's cloned and deps are installed, you only need:

```bash
cd path/to/Aris-Code
bun dev:desktop
```

### Platform notes

Aris Code pulls in two native modules during install: `electron` (downloads a ~120MB platform binary) and `node-pty` (compiles a small C++ binding for the terminal pane). Both are pre-trusted in `package.json`, so Bun runs their install scripts automatically — but you need the right OS-level toolchain on disk for the compile step to succeed.

#### macOS

Install [Xcode Command Line Tools](https://developer.apple.com/xcode/) first — that provides `git` and the C/C++ compiler `node-pty` needs:

```bash
xcode-select --install
```

Then the standard flow works:

```bash
git clone https://github.com/kennysarnoski-jarvis/Aris-Code.git
cd Aris-Code
bun install     # downloads Electron, compiles node-pty
bun dev:desktop
```

First launch takes ~30s while Vite warms up. Make sure `~/.bun/bin` is on your `PATH` (the Bun installer prints the exact line to add to your shell rc).

#### Linux

You need three things beyond Bun + Node:

**1. Build toolchain + unzip** (for the `node-pty` native compile and the Bun installer)

| Distro          | Command                                                                       |
| --------------- | ----------------------------------------------------------------------------- |
| Debian / Ubuntu | `sudo apt install build-essential python3 unzip`                              |
| Fedora / RHEL   | `sudo dnf groupinstall "Development Tools" && sudo dnf install python3 unzip` |
| Arch            | `sudo pacman -S base-devel python unzip`                                      |

**2. Electron runtime libraries** (Electron loads these at launch)

| Distro                  | Command                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------ |
| Ubuntu **24.04+**       | `sudo apt install libnss3 libatk-bridge2.0-0t64 libgtk-3-0t64 libgbm1 libasound2t64` |
| Ubuntu / Debian (older) | `sudo apt install libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2`          |
| Fedora / RHEL           | `sudo dnf install nss atk gtk3 mesa-libgbm alsa-lib`                                 |
| Arch                    | `sudo pacman -S nss atk gtk3 libgbm alsa-lib`                                        |

> [!NOTE]
> Ubuntu 24.04+ renamed several libraries with a `t64` suffix during the 64-bit time_t transition. Old names (`libatk-bridge2.0-0`, `libgtk-3-0`, `libasound2`) still appear as transition stubs but apt won't auto-install them — you'll see "no installation candidate." Use the t64 names instead.

**3. Node.js 22** (the `node-gyp` step below needs `npm`, which comes with Node)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

**4. node-gyp globally** (lets `node-pty` compile its native binding during `bun install`)

```bash
sudo npm install -g node-gyp
```

If Electron fails to launch with a `cannot open shared object file` error, the message names the exact `.so` it can't find — search your package manager for it.

**5. A display server** — Wayland or X11. On a headless server `bun dev:desktop` has nothing to draw to and will fail. Run from a desktop session, use X11 forwarding over SSH (`ssh -X`), or run inside WSL2 on Windows (WSLg handles it).

Then:

```bash
git clone https://github.com/kennysarnoski-jarvis/Aris-Code.git
cd Aris-Code
bun install
bun dev:desktop
```

#### Windows

The painless path is **WSL2** with Ubuntu (Linux running inside Windows). Native Windows + PowerShell is technically possible but requires Visual Studio Build Tools for `node-pty` to compile and the Electron dev chain handles paths-with-spaces poorly — we don't recommend it.

**One-time WSL2 setup:**

1. Install WSL2 + Ubuntu — open PowerShell as admin, run `wsl --install` ([Microsoft's guide](https://learn.microsoft.com/en-us/windows/wsl/install)). Reboot when prompted.
2. **Windows 11 users**: WSLg (the GUI bridge that lets Linux apps draw windows on Windows) ships by default — Electron just works inside WSL2. Skip to step 3.
3. **Windows 10 users**: WSLg isn't installed by default. Follow [Microsoft's WSL2 GUI guide](https://learn.microsoft.com/en-us/windows/wsl/tutorials/gui-apps) to enable it. Without WSLg, the Electron window has nowhere to render.
4. Open your WSL2 Ubuntu terminal and follow the **Linux** instructions above (install the build toolchain + Electron runtime libs, then `git clone` + `bun install` + `bun dev:desktop`).

### Troubleshooting

- **`bun install` fails on a native module** (`node-pty` or `electron`) — the build toolchain for your OS is the usual cause. Re-check the Platform notes for your OS.
- **`bun dev:desktop` exits ~immediately on first run** — usually a stale partial install. Reset with `rm -rf node_modules apps/*/node_modules packages/*/node_modules && bun install`.
- **`Electron failed to install correctly`** at launch — `electron` wasn't trusted by Bun at install time. Your `package.json` should list `electron` in `trustedDependencies`; if it doesn't, you're on an older clone — pull latest from `main` and re-run `bun install`.
- **Still stuck** — open an [issue](https://github.com/kennysarnoski-jarvis/Aris-Code/issues) with your OS, Bun version (`bun --version`), Node version (`node --version`), and the full error output.

## Sign in

Aris Code is the client; **[youraris.com](https://youraris.com)** is the cloud that hosts the knowledge graph, runs the GAT model, and brokers DeepSeek dispatch.

1. Create an account at [youraris.com](https://youraris.com) and grab a subscription key (`sk_live_…`)
2. Open Aris Code → Settings → Aris provider card → **Paste your subscription key** → Activate
3. Top up your token wallet via the Stripe checkout in the dashboard
4. Pick the **Aris** provider from the model picker, start a chat

For Codex / Claude, install their CLIs and authenticate separately — Aris Code wraps them but doesn't proxy auth for those providers.

## Limitations

- **Aris (DeepSeek) doesn't support vision yet** — image input doesn't work for Aris-provider threads. Codex and Claude both handle images natively, so switch providers if you need to attach a screenshot.
- **First sign-in requires a youraris.com subscription** for the Aris provider. Codex/Claude work fully offline-from-our-cloud with their own auth.
- Markdown rendering of complex tables and diagrams is mature; some niche ANSI escape sequences in tool output may render imperfectly.

## Develop

Requires [Bun](https://bun.sh) ≥ 1.3 and Node 22+.

```bash
bun install
bun dev              # web + server in dev mode
bun dev:desktop      # Electron shell with hot reload
bun typecheck        # all packages
bun lint             # oxlint
bun fmt              # oxfmt
bun run test         # vitest (NEVER use `bun test` directly)
```

Build a desktop bundle:

```bash
bun build:desktop    # produces .dmg / .exe / AppImage in apps/desktop/release/
```

Architecture notes for AI coding agents: see [`CLAUDE.md`](./CLAUDE.md).

## Contributing

PRs welcome. Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) before opening one. Security issues: see the [security disclosure section](./CONTRIBUTING.md#security-disclosure).

## License

[MIT](./LICENSE) — Copyright © 2026 T3 Tools Inc. and Kenny Sarnoski.

Aris Code is a hard fork of [T3 Code](https://github.com/pingdotgg/t3code) by [Ping Labs](https://ping.gg). The original T3 Code is the foundation of the Electron shell, WebSocket transport, Codex/Claude provider wrappers, and the React UI primitives. Aris Code adds the Aris (DeepSeek-keyed) provider, the cloud-side knowledge graph + GAT search layer, the rolling-window memory architecture, the project memory tools (scratchpad / todos / facts), and the multi-agent coordinator mode.

If you want the original Codex-only experience, go with T3 Code. If you want a coding assistant grounded in current data, you're in the right place.
