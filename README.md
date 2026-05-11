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
- **Install today's deps, not yesterday's** — `"set up Next.js"` invokes `search_knowledge` with version-intent detection, returns the *current* major version + setup pattern from the framework_release graph entries
- **Plan + execute multi-step tasks** — tracks work in a per-project todo list (visible to you in the right sidebar), updates statuses as she completes steps, doesn't re-do completed work
- **Fan out big jobs** — spawns sub-agents for parallel tasks (auditing 4 directories simultaneously, writing tests for multiple modules, etc.) with isolated context windows so the parent doesn't blow its budget
- **Remember things about your project across sessions** — scratchpad for in-flight notes, todos for the task list, facts for things about *you* (your name, your conventions, your preferences) that persist across every project you open
- **Hold conversations in million-token codebases** — auto-summarizes older parts of the conversation as you approach context limits, archives the full history, retrieves it on demand when relevant
- **Look up specific CVEs and security patterns** — `"is CVE-2024-3094 in my supply chain?"` hits the graph with a direct label lookup, returns the canonical entry with CVSS / CWE / affected products / patch status
- **Find reference implementations** — `"show me a Solidity reentrancy guard"` or `"how does Rust's Iterator trait actually look"` → searches the graph's code-bearing concepts and returns real implementations with context

What Aris **can't** do yet:

- **Vision** — Aris doesn't accept image attachments. Codex and Claude providers do; switch to one of them when you need to share a screenshot.
- **Long-running background jobs** — every action happens in-turn. No "go do this for an hour and come back."

## Capabilities

### Providers

| Provider | Models | Notes |
|---|---|---|
| **Aris** (primary) | V4 Pro · V4 Flash | DeepSeek V4 wholesale, fronted by `youraris.com`, KG-enriched. Token-pay via your subscription. |
| **Codex** | All Codex CLI models | Wraps `codex app-server` (JSON-RPC). Bring your own ChatGPT auth. |
| **Claude** | All Anthropic models | Wraps the Claude Agent SDK. Bring your own Anthropic key. |
| Cursor / OpenCode / Gemini | — | Coming soon |

### File and shell tools (all providers)

- `read_file` · `write_file` · `edit_file` — surgical file edits with automatic diff display
- `bash` — command execution, approval-gated for destructive ops
- `grep` · `glob` · `list_directory` — codebase navigation
- Configurable approval rules per workspace

### Project memory (Aris)

- **Scratchpad** — project-scoped freeform notes that persist across turns and threads
- **Todos** — project task list with `pending` / `in_progress` / `completed` states, surfaced live in the right sidebar
- **Facts** — user-global memory nodes (`{type, label, description, content}`) for things Aris should remember about *you* across every project (preferences, identity, working style)

### Rolling-window memory (Aris)

- Per-thread `.jsonl` archives in `~/.aris/projects/<key>/sessions/<thread>/`
- Auto-rollover at 920K tokens; older windows summarized and stored
- `list_archives` · `search_archives` · `read_archive_range` tools let Aris pull historical context on demand
- Conversations don't get truncated — they get *summarized and retrievable*

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
> **No prebuilt binaries yet.** Signed installers (Homebrew cask, winget, AUR, .dmg / .exe / AppImage) are planned but not yet shipped. For now, Aris Code runs from source — three commands on any platform. Watch [github.com/kennysarnoski-jarvis/Aris-Code/releases](https://github.com/kennysarnoski-jarvis/Aris-Code/releases) for the first packaged release.

### Prerequisites (all platforms)

- [Bun](https://bun.sh) ≥ 1.3 — `curl -fsSL https://bun.sh/install | bash`
- Node.js 22+ — install via [nvm](https://github.com/nvm-sh/nvm), [fnm](https://github.com/Schniz/fnm), or your distro's package manager
- Git

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

- **macOS** — works out of the box. First launch may take ~30s while Vite warms up. Bun installs to `~/.bun/bin/bun`; make sure that's on your `PATH`.
- **Linux** — works out of the box on most distros. If `bun dev:desktop` complains about missing libraries, install the Electron deps for your distro (e.g. on Debian/Ubuntu: `sudo apt install libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2`).
- **Windows** — recommend running via [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install) (Ubuntu inside Windows). Native Windows + PowerShell works but the Electron build chain can be flaky with paths containing spaces. Inside WSL2, follow the Linux instructions above.

If `bun dev:desktop` errors on first run, the most common fix is `rm -rf node_modules && bun install` (deps got corrupted somewhere). If that doesn't fix it, open an issue with the full error output.

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
