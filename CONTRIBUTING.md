# Contributing to Aris Code

Aris Code is a small project maintained by a solo developer. Contributions are welcome, but please read this whole file before opening an issue or PR — it'll save us both time.

## Read This First

This project is still early. Scope, quality, and direction are tightly controlled.

You can absolutely open issues and PRs, but please do so knowing:

- Small, focused bug fixes / reliability / perf improvements have a high acceptance rate
- Large feature PRs, opinionated rewrites, and drive-by scope expansions almost certainly get closed
- The Aris cloud (`youraris.com`) is run by the maintainer; client-side changes that depend on new cloud endpoints need a heads-up issue first so we can coordinate

## What We're Most Likely To Accept

- Small, focused bug fixes
- Reliability improvements (connection handling, retry logic, state management)
- Performance improvements with concrete benchmarks
- Tightly scoped maintenance work (dep upgrades, lint cleanups, etc.)
- Documentation fixes — typos, broken links, clearer phrasing
- New provider integrations that mirror the existing `Codex` / `Claude` adapter pattern

## What We're Least Likely To Accept

- Large PRs (anything > ~500 lines, especially with multiple unrelated changes)
- Drive-by feature additions without prior discussion
- Opinionated rewrites of working code
- Anything that expands product scope without an issue accepted first
- Cloud-side feature requests for `youraris.com` (open an issue for those)

If you open a 1,000+ line PR full of new features without prior issue discussion, it'll probably be closed quickly.

## If You Still Want To Open A PR

- Keep it small
- Explain exactly what changed
- Explain exactly why the change should exist
- Don't mix unrelated fixes
- If the PR touches UI, include before/after screenshots
- If the change depends on motion, timing, transitions, or interaction, include a short video
- Run `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` locally first — CI will block on these anyway

## Issues First (for anything non-trivial)

If you're thinking about a non-trivial change, open an issue first.

That still doesn't guarantee acceptance, but it lets you avoid wasting hours on something we'd reject. Faster for both sides.

## Local Setup

Requires [Bun](https://bun.sh) ≥ 1.3 and Node 22+.

```bash
bun install
bun dev              # web + server in dev mode
bun dev:desktop      # Electron shell with hot reload
bun typecheck
bun lint
bun fmt
bun run test         # NEVER `bun test` directly — use `bun run test` for vitest
```

Read [`CLAUDE.md`](./CLAUDE.md) for the architecture overview before making non-trivial changes — it's written for both human contributors and AI coding assistants.

## Security Disclosure

**Do not file public GitHub issues for security vulnerabilities.**

If you've found a security issue:

- Aris Code client / desktop app / web UI vulnerabilities → email **kennysarnoski@gmail.com** (subject line should start with `[SECURITY] Aris Code:`)
- `youraris.com` cloud vulnerabilities → same email, subject line starts with `[SECURITY] Cloud:`

What to include:

- A clear description of the issue
- Reproduction steps (or a proof-of-concept)
- Your assessment of impact (RCE? Auth bypass? Information disclosure? Etc.)
- Whether you've already disclosed it elsewhere

You'll get an acknowledgment within 72 hours. We'll work on a fix and coordinate disclosure timing with you — typically 90 days, faster for actively-exploited issues.

We don't have a formal bug bounty program yet, but we're happy to publicly credit reporters in release notes (unless you prefer anonymity).

## Be Realistic

Opening a PR does not create an obligation on our side.

We may close it. We may ignore it. We may ask you to shrink it. We may reimplement the idea ourselves later.

If you're fine with that, proceed.
