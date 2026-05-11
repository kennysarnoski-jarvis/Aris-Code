# Aris Skills

User-authored prompt templates Aris invokes via the `use_skill` tool — or you
trigger directly with a `/skillname` slash command in the composer. Same idea
as Claude Code's skills system: drop a markdown file in `.aris/skills/<name>/SKILL.md`,
Aris loads it on the next turn, and decides when to invoke it based on the
`when-to-use` field you author.

## Where skills live

- **Project-level**: `<your-project>/.aris/skills/<name>/SKILL.md` — checked
  into the repo, shared with collaborators.
- **User-level**: `~/.aris/skills/<name>/SKILL.md` — private to you, available
  across every project you open with Aris.
- Project-level overrides user-level when they share a name.

## File format

Markdown with optional YAML-style frontmatter:

```markdown
---
name: debug
description: Systematic debugging walkthrough
when-to-use: When the user is stuck or asks for help diagnosing a bug
argument-hint: <description of what's broken>
---

# Goal

Walk through this debugging workflow:

1. Restate the problem in your own words.
2. List 2-3 likely causes ordered by probability.
3. Identify the cheapest test that distinguishes them.
4. Run it. Then update the cause-list and loop.

User context: $ARGUMENTS
```

The body is what Aris reads when she invokes the skill.

## Frontmatter fields

All optional — the simplest valid SKILL.md is just markdown body with no
frontmatter at all (the directory name becomes the skill name, the body is the
prompt).

| Field                   | Purpose                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `name`                  | Canonical name the model invokes. Defaults to the directory name.                                     |
| `description`           | One-line summary, surfaced to the model alongside `when-to-use`.                                      |
| `when-to-use`           | **Load-bearing.** Free-text guidance the model reads to decide when to invoke this skill.             |
| `argument-hint`         | Free-text hint about what to pass for `$ARGUMENTS`. Surfaced in the tool description.                 |
| `arguments`             | Block list of named-arg keys, e.g. `[target, focus]`. Documentation; populates `$ARG_<NAME>`.         |
| `allowed-tools`         | Restrict Aris's tool set while executing this skill. Inline = soft prompt; fork = hard structural.    |
| `model`                 | Override the LLM model for this skill's run. Fork mode only.                                          |
| `effort`                | `high` / `low` / etc. → `enable_thinking` true/false on Qwen. Fork mode only.                         |
| `context`               | `inline` (default) appends to the current conversation. `fork` spawns a sub-agent in a fresh context. |
| `disableNonInteractive` | Reserved for future non-interactive flows.                                                            |

## Argument substitution

Two placeholder styles, both substituted at dispatch time:

- **`$ARGUMENTS`** — the entire args string, verbatim. Empty string when no args.
- **`$ARG_<NAME>`** — populated from `key=value` tokens in the args string.
  Example: invoking `use_skill("review", "target=auth.ts focus=session-tokens")`
  populates `$ARG_TARGET` and `$ARG_FOCUS`. Quoted values support spaces:
  `target="src/long path/file.ts"`.

## Slash commands

Type `/skillname args...` as the first thing in your composer message and
Aris dispatches the skill directly — no autonomous decision required from
the model. The rendered body becomes your message; the model responds to it
as if you'd typed the whole thing yourself.

```
/debug stuck on the websocket reconnect after the proxy change
/review target=src/auth.ts focus="session token storage"
```

If the slash name doesn't match a loaded skill, the message passes through
unchanged — so `/path/to/file.ts` and `/help me` (when there's no `path` or
`help` skill) work normally.

## Fork mode (sub-agent execution)

Set `context: fork` to run the skill as a fresh sub-agent. Behavior:

- New conversation row server-side — no parent history pollution.
- `allowed-tools` becomes a **hard** restriction (sub-agent literally doesn't
  have other tools registered).
- Per-skill `model:` and `effort:` overrides apply (only in fork mode).
- Sub-agent runs to completion; its final output flows back to the parent as
  the `use_skill` tool result.
- Slash-command dispatch always runs inline regardless of `context:` — the
  model needs to be the one to invoke `use_skill` for fork to fire.

Fork is overkill for most skills. Reach for it when you want isolation
(different model, different tool set, fresh context window).

## Live shell expansion

**Off by default for safety.** Enable with `ARIS_SHELL_EXPANSION=true` in your
environment.

When enabled, `` `command` `` substrings in the body run as subprocesses and
get replaced with stdout at dispatch time:

```markdown
---
name: ship-status
when-to-use: When the user asks about ship readiness
---

Branch: `git rev-parse --abbrev-ref HEAD`
Last commit: `git log -1 --format='%h %s'`
Disk space: `df -h .`

Plan a deploy of $ARGUMENTS.
```

The security model lives in `apps/server/src/provider/Layers/ArisSkillsShellExpansion.ts`:
allow-listed commands only (read-only/diagnostic-leaning), no shell
metacharacters, 5-second timeout, 4KB output cap, pinned cwd. Errors render
as `[error: <reason>]` placeholders in the body, never throw.

## Hot reload

Edits to SKILL.md files take effect on the next user message — no session
restart needed. The loader runs once per turn and just re-reads the
directory. Add or rename a skill while a session is live and Aris's
`use_skill` tool description updates within the next turn.

## Examples

See [hello/SKILL.md](./hello/SKILL.md) for a minimal working example.
