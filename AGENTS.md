# CLAUDE.md

This file is read by AI coding assistants (Claude Code, Codex, Cursor) when working in this repo. Human contributors: see `CONTRIBUTING.md` for the PR process and `README.md` for an overview.

## What is Aris Code?

Aris Code is a desktop coding assistant. The UI is an Electron app; the backend is a Node.js/Effect WebSocket server. The marquee provider is **Aris** — DeepSeek V4 wholesale, fronted by `youraris.com` and enriched at search time by a 350k-concept knowledge graph (security CVEs, MITRE ATT&CK, OWASP, framework releases, code patterns) that's reranked by a trained Graph Attention Network. Codex and Claude are also supported for users who'd rather bring their own model auth.

The GAT/KG layer is the differentiator — every other AI coding tool relies on the LLM's stale training data for things like "what's the current Next.js version" or "is CVE-2024-3094 in this dep tree." Aris asks the graph, gets a current answer, then has the model use it.

## Task Completion Requirements

- All of `bun fmt`, `bun lint`, and `bun typecheck` must pass before considering tasks completed.
- NEVER run `bun test`. Always use `bun run test` (runs Vitest).
- Default to small, surgical changes. Sweeping refactors are welcome when they reduce duplication, but call them out explicitly in the PR.

## Core Priorities

1. **Performance** — every turn lands on a paying user's bill. Keep latency low.
2. **Reliability** — partial streams, session restarts, reconnects, provider failures all need clean handling.
3. **Predictability** — the user shouldn't have to wonder what the system is doing.

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long-term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## Package Roles

- `apps/server` — Node.js WebSocket server. Wraps each provider (Codex app-server JSON-RPC, Claude SDK, DeepSeek via Aris cloud), manages session lifecycle, brokers tool calls.
- `apps/web` — React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `apps/desktop` — Electron shell that bundles server + web for distribution.
- `packages/contracts` — Effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. **Schema-only — no runtime logic.**
- `packages/shared` — Shared runtime utilities consumed by both server and web. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.

## Provider Architecture

Each provider lives under `apps/server/src/provider/Layers/`:

- **Aris (DeepSeek)** — `DeepSeekAdapter`, `DeepSeekAgentTools` (composer), individual tool families: `DeepSeekScratchpadTool`, `DeepSeekTodosTool`, `DeepSeekFactsTool`, `DeepSeekArchiveTools`, `DeepSeekSearchTools`, `DeepSeekAgentTool` (spawn_worker / coordinator), `DeepSeekSessionScratchpadTools`. Dispatch goes through `DeepSeekOpenAIClient` which speaks to `youraris.com/api/local/deepseek/v1/chat/completions` (trusted-caller proxy with bearer auth, balance gating, and 2.5x markup happens cloud-side).
- **Codex** — wraps `codex app-server` (JSON-RPC over stdio). See https://developers.openai.com/codex/sdk/#app-server.
- **Claude** — wraps the Claude Agent SDK directly.

The web app consumes orchestration domain events via WebSocket push on channel `orchestration.domainEvent`. Provider runtime activity is projected into orchestration events server-side so the UI doesn't have to know which provider produced what.

## The Knowledge Graph (Aris's moat)

The KG is a separate Postgres database (`arisllm`) hosted alongside the Aris cloud. It holds ~350k+ concepts (CVEs, security patterns, framework releases, code structures, MITRE ATT&CK techniques, OWASP cheatsheets) with bge-small embeddings and pgvector HNSW indexes. A trained GATv2Conv model reranks search results using subgraph propagation.

When Aris invokes `search_knowledge` / `search_cve` / `search_code`, the chain is:

1. **Pass -1** — version-intent seed (e.g. "latest Next.js" → `next_js_v%` direct lookup)
2. **Pass 0** — CVE-id regex match (e.g. "CVE-2024-3094" → `cve-2024-3094` direct lookup)
3. **Pass 1** — AND tsquery (tight match via GIN index on tsvector)
4. **Pass 2** — OR tsquery (broader fallback)
5. **Pass 3** — pgvector HNSW semantic search
6. **GAT rescore** — the trained model rebalances candidates using their subgraph topology

All of this happens cloud-side. The client only sees the final ranked results returned by the tool call.

## Reference Repos

- Open-source Codex: https://github.com/openai/codex
- Codex Monitor (Tauri, strong reference implementation): https://github.com/Dimillian/CodexMonitor

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.
