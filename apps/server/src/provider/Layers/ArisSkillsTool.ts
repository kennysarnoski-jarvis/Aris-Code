/**
 * ArisSkillsTool — register `use_skill` as an SDK tool the model can
 * invoke to expand a user-authored skill prompt.
 *
 * Pairs with `ArisSkillsLoader.ts`:
 *   1. Adapter calls `loadAllSkills(...)` per turn.
 *   2. Adapter calls `createUseSkillTool({ skills })` and adds the
 *      result to the SDK tools array (only when skills.length > 0).
 *   3. Model sees the tool's description (which carries the skills
 *      manifest), decides to call it, the SDK dispatches `execute`,
 *      we look up the skill body and return it as a string.
 *   4. Model reads the body and follows the instructions inline.
 *
 * Why register the tool ONLY when skills exist:
 *   The tool description embeds the manifest of available skill names
 *   and their `when-to-use` text. With zero skills, the description
 *   would either lie ("no skills available") or be confusing
 *   ("invoke this tool with a name from this empty list"). Cleaner to
 *   not advertise the tool at all when the user hasn't authored any.
 *
 * Why we expand the body server-side (not just return a pointer):
 *   Returning the expanded body as the tool result puts the skill's
 *   instructions into the model's input on the very next turn — no
 *   extra round-trip to fetch. The SDK's `execute` return value flows
 *   back as the tool message, and the model continues with that as
 *   context.
 *
 * Argument substitution:
 *   `$ARGUMENTS`     — replaced with the user-supplied `args` string
 *                      verbatim, or the empty string when omitted.
 *   `$ARG_<NAME>`    — when the args string contains `key=value` pairs
 *                      (whitespace-separated, quoted values supported),
 *                      each `$ARG_<KEY_UPPERCASE>` placeholder in the
 *                      body is replaced with the matching value. Tokens
 *                      that don't look like `key=value` are ignored at
 *                      the named-args level (they still appear in the
 *                      `$ARGUMENTS` substitution). Names must match
 *                      `[A-Za-z_][A-Za-z0-9_]*` — anything else is
 *                      silently skipped.
 *
 * Substitution order:
 *   Named `$ARG_<NAME>` placeholders are resolved first, then
 *   `$ARGUMENTS`. This keeps the args string from accidentally
 *   re-injecting `$ARG_*` tokens into the body when an author uses
 *   both placeholder styles in the same skill.
 *
 * Tool restrictions (32d):
 *   Skills that declare `allowed-tools` get a "Tool restrictions"
 *   prefix prepended to the dispatched body. This is soft enforcement
 *   — the model is asked to comply. Hard structural enforcement is a
 *   `context: fork` concern (32e): the sub-agent is constructed with
 *   only the allowed tools registered, which makes the constraint
 *   physical rather than persuasive.
 *
 * Fork-mode execution (32e):
 *   When a skill declares `context: fork`, the use_skill execute path
 *   delegates to an injected `ForkExecutor` callback instead of
 *   returning the rendered body. The executor is responsible for
 *   spawning a sub-agent, running it to completion, and returning the
 *   sub-agent's final output as the tool result string. The sub-agent
 *   typically gets a fresh aris-server conversation (no history
 *   pollution), the rendered body as its system instructions, and the
 *   parent's tool list filtered through `allowed-tools`.
 *
 *   The dependency-injection shape keeps this module decoupled from
 *   OpenAI / `@openai/agents` runtime concerns — the executor lives
 *   in `ArisAdapter` where the OpenAI client and tool factory are
 *   already in scope. Callers that don't configure a fork executor
 *   get a soft fallback: fork-requested skills run inline with a
 *   one-line warning in the result.
 *
 * Per-skill model + effort overrides (32f):
 *   A skill can declare `model:` and `effort:` to override the
 *   parent's selection for the duration of the skill. Both apply
 *   ONLY in fork mode — inline mode can't swap models mid-turn
 *   without breaking the parent's chat-completion request, so the
 *   inline path silently ignores them. (Authors who want overrides
 *   honored should set `context: fork`.) The fork executor reads
 *   these fields off `skill.frontmatter` directly; this module
 *   exports `mapEffortToEnableThinking` so the executor and any
 *   other caller (slash-command dispatch in 32h, etc.) interpret
 *   `effort:` consistently.
 *
 * Shell expansion (32g):
 *   Skills can include `` `command` `` substrings in the body to
 *   inject live data (current branch, recent commits, env info,
 *   etc.). When the caller passes a `shellExpansion` option with
 *   `enabled: true`, each backtick is resolved at dispatch time by
 *   spawning the command and substituting stdout. The full security
 *   model lives in `ArisSkillsShellExpansion.ts` — allow-list,
 *   metachar gate, timeout, output cap. Disabled by default; the
 *   user opts in via server settings. Both inline and fork modes
 *   honor expansion (fork uses the expanded body as the sub-agent's
 *   instructions, so live data ends up in the sub-agent's prompt).
 *
 * Slash-command dispatch (32h):
 *   When the user types `/skillname args...` as the first thing in
 *   their message, the adapter calls `rewriteSlashCommand` to detect
 *   it and rewrite the user message into the rendered skill body
 *   before sending to aris_server. The model sees the expanded
 *   prompt, not the slash. This mirrors Claude Code's slash-command
 *   pattern: pure prompt expansion, no autonomous decision required
 *   from the model.
 *
 *   Slash-invoked skills always run inline — `context: fork` is
 *   ignored at the slash-command surface. Fork only kicks in when
 *   the model autonomously invokes `use_skill` mid-conversation.
 *   Documented in the helper's docstring; reduces surprise.
 *
 * @module ArisSkillsTool
 */
import { tool } from "@openai/agents";
import { z } from "zod";

import type { Skill } from "./ArisSkillsLoader.ts";
import {
  type ShellExpansionOptions,
  type ShellExpansionResult,
  expandShellSubstitutions,
} from "./ArisSkillsShellExpansion.ts";

/**
 * Input passed to a `ForkExecutor` when a `context: fork` skill is
 * dispatched. Includes the already-rendered body (restrictions +
 * substitutions applied) so the executor doesn't need to re-render —
 * its job is purely "spawn sub-agent, run, return string".
 */
export interface ForkExecutorInput {
  readonly skill: Skill;
  /**
   * Body after `renderSkillForDispatch` — restrictions prefix,
   * `$ARGUMENTS`, and `$ARG_<NAME>` already resolved. The executor
   * typically sets this as the sub-agent's system instructions.
   */
  readonly renderedBody: string;
  /** The original `args` string the model passed, in case the executor wants it. */
  readonly args: string | undefined;
}

/**
 * Callback contract for fork-mode dispatch. Returns the sub-agent's
 * final output as a string — that string flows back to the parent
 * agent as the `use_skill` tool result.
 *
 * Errors should be returned as a descriptive string rather than
 * thrown, so the parent agent can read them as tool-message text and
 * decide what to do (try again, ask the user, escalate, etc.).
 */
export type ForkExecutor = (input: ForkExecutorInput) => Promise<string>;

export interface CreateUseSkillToolOptions {
  /** Loaded skills, after project-precedence resolution. */
  readonly skills: ReadonlyArray<Skill>;
  /**
   * Optional sub-agent dispatcher. When a skill declares
   * `context: fork`, the use_skill tool delegates to this callback
   * instead of returning the rendered body. When omitted, fork
   * skills fall back to inline behavior with a one-line warning
   * prefix so the dispatch never silently breaks.
   */
  readonly forkExecutor?: ForkExecutor;
  /**
   * Optional shell-expansion config (32g). When provided AND
   * `enabled: true`, backtick substrings in the rendered body
   * resolve to live shell stdout before the body is returned (or
   * before it's handed to the fork executor). When omitted or
   * `enabled: false`, backticks render verbatim. The security
   * model lives in `ArisSkillsShellExpansion.ts`.
   */
  readonly shellExpansion?: ShellExpansionOptions;
}

/**
 * Tokenize an args string into a `key=value` map.
 *
 *   "target=auth.ts focus='session tokens'"
 *     → { TARGET: "auth.ts", FOCUS: "session tokens" }
 *
 * Whitespace separates tokens at the top level; single or double
 * quotes group the value side. Tokens that don't match the
 * `key=value` shape are silently skipped — those still surface in
 * the `$ARGUMENTS` substitution, just not as named args.
 *
 * Keys are upper-cased on insertion so the body uses `$ARG_TARGET`
 * regardless of whether the author wrote `target=` or `TARGET=`.
 * Keys must match `/^[A-Za-z_][A-Za-z0-9_]*$/` — anything else is
 * ignored. Empty values (`key=`) are accepted and produce empty
 * substitutions; absent keys are not substituted at all.
 *
 * Exported for testing.
 */
export function parseNamedArgs(args: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!args) return result;

  // Tokenize: walk the string char-by-char, respect quoted regions,
  // emit a token at each unquoted whitespace boundary. Hand-rolled
  // for the same reason the frontmatter parser is — predictable
  // edge-case behavior the author can mentally model.
  const tokens: string[] = [];
  let buf = "";
  let inQuote: '"' | "'" | null = null;
  for (const ch of args) {
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      else buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (buf) {
        tokens.push(buf);
        buf = "";
      }
      continue;
    }
    buf += ch;
  }
  if (buf) tokens.push(buf);

  const keyShape = /^[A-Za-z_][A-Za-z0-9_]*$/;
  for (const token of tokens) {
    const eq = token.indexOf("=");
    if (eq <= 0) continue; // no equals, or starts with '='
    const key = token.slice(0, eq);
    const value = token.slice(eq + 1);
    if (!keyShape.test(key)) continue;
    result[key.toUpperCase()] = value;
  }
  return result;
}

/**
 * Map a skill's `effort:` frontmatter value to an explicit
 * `enable_thinking` boolean for Aris's chat-template kwargs.
 *
 * For Aris/Qwen3.6, "effort" doesn't have a graduated scale the way
 * OpenAI's `reasoning_effort` does — the underlying knob is binary
 * (`enable_thinking: true | false`). We coerce common literals into
 * the binary:
 *
 *   high | medium | thinking | on | yes | true   → true
 *   low  | minimal | off      | no | false       → false
 *   anything else (or undefined)                  → undefined
 *
 * `undefined` means "don't override" — the request goes out without
 * a `chat_template_kwargs.enable_thinking` field and the server
 * applies its default. Treating unknown values as undefined avoids
 * surprising authors with a silent default — a typo in the skill
 * frontmatter just no-ops, no crash.
 *
 * Exported for testing.
 */
export function mapEffortToEnableThinking(effort: string | undefined): boolean | undefined {
  if (!effort) return undefined;
  const normalized = effort.trim().toLowerCase();
  switch (normalized) {
    case "high":
    case "medium":
    case "thinking":
    case "on":
    case "yes":
    case "true":
      return true;
    case "low":
    case "minimal":
    case "off":
    case "no":
    case "false":
      return false;
    default:
      return undefined;
  }
}

/**
 * Build the prompt-side restriction notice for a skill that declares
 * `allowed-tools`. Prepended to the dispatched body in
 * `renderSkillForDispatch`. Soft-enforcement: the model is the actor
 * being asked to comply. Hard enforcement requires `context: fork`
 * (32e), where the sub-agent is constructed with only the allowed
 * tools registered — that path makes the constraint structural.
 *
 * Inline mode can't enforce structurally because the agent's tools
 * array is fixed at Agent construction time and the SDK doesn't
 * expose a per-tool-call gating hook. We document this honestly in
 * the body so the user knows what they're getting.
 *
 * Exported for testing.
 */
export function formatToolRestrictions(allowedTools: ReadonlyArray<string>): string {
  return [
    "## Tool restrictions for this skill",
    "",
    "While completing this skill, restrict yourself to the following tools only:",
    ...allowedTools.map((t) => `- ${t}`),
    "",
    "Do not call any other tools for this task — the skill author has scoped it " +
      "to a minimal toolset on purpose. If you genuinely need a tool that isn't " +
      "in this list, stop and explain to the user why; don't reach for it silently.",
  ].join("\n");
}

/**
 * Render a fully dispatched skill: tool-restriction prefix (when the
 * skill declares `allowed-tools`), then the expanded body.
 *
 * This is the function the `use_skill` execute callback uses — it
 * combines the placeholder-substitution work of `expandSkillBody`
 * with the soft-enforcement prefix from `formatToolRestrictions`.
 *
 * Kept as a separate function (rather than baked into the execute
 * closure) so 32e's fork-mode dispatcher can reuse the rendering
 * pipeline — the rendered body is the system message handed to the
 * sub-agent, restrictions and all.
 */
export function renderSkillForDispatch(
  body: string,
  args: string | undefined,
  allowedTools: ReadonlyArray<string> | undefined,
): string {
  const sections: string[] = [];
  if (allowedTools && allowedTools.length > 0) {
    sections.push(formatToolRestrictions(allowedTools));
  }
  sections.push(expandSkillBody(body, args));
  return sections.join("\n\n");
}

/**
 * Substitute placeholders in a skill body with the supplied argument
 * string. Two placeholder styles:
 *
 *   `$ARGUMENTS`   — the entire args string verbatim. Missing args
 *                    become the empty string. Skills should be
 *                    authored to read OK either way (e.g. by placing
 *                    `$ARGUMENTS` after a colon: "Focus: $ARGUMENTS").
 *
 *   `$ARG_<NAME>`  — the value for `name` from `parseNamedArgs(args)`.
 *                    Placeholder is matched case-sensitively in the
 *                    body but the named-arg lookup is upper-cased on
 *                    insertion, so `$ARG_TARGET` matches both
 *                    `target=...` and `TARGET=...` from the model.
 *
 * Named substitutions run first so the args string can't accidentally
 * inject `$ARG_*` tokens into the body via the `$ARGUMENTS` pass.
 *
 * Exported for testing — the loader is the home of pure parsing and
 * this is the home of pure expansion. Both stay disk-free for tests.
 */
export function expandSkillBody(body: string, args: string | undefined): string {
  const value = args ?? "";
  const named = parseNamedArgs(value);

  let result = body;
  // Named first. Iterate the parsed map so we only replace placeholders
  // for keys the model actually supplied — unsupplied `$ARG_X` tokens
  // are left in place rather than being silently emptied, which makes
  // missing-arg bugs more diagnosable than a silent stripped substring.
  for (const [key, replacement] of Object.entries(named)) {
    result = result.split(`$ARG_${key}`).join(replacement);
  }
  // Then the full-string placeholder. Global split/join avoids regex
  // escape gymnastics and replaces every occurrence.
  result = result.split("$ARGUMENTS").join(value);
  return result;
}

/**
 * Build the description string the model reads to decide when to
 * invoke `use_skill`. Bakes the manifest of available skills into the
 * description so the model doesn't need a separate listing call —
 * keeps the dispatch path one round-trip.
 *
 * Format (deliberately compact):
 *
 *   Invoke a user-authored workflow skill. ...
 *
 *   Available skills:
 *     - debug — When the user is stuck or asks for help diagnosing
 *     - test  — When the user asks for tests or coverage
 *
 *   Call with `name` (one of the above) and optional `args` string.
 */
function buildDescription(skills: ReadonlyArray<Skill>): string {
  const manifestLines: string[] = [];
  for (const skill of skills) {
    const when = skill.frontmatter.whenToUse ?? skill.frontmatter.description ?? "(no description)";
    manifestLines.push(`  - ${skill.name} — ${when}`);
  }
  // Argument hints (free-text guidance) surface alongside the manifest
  // so the model knows what to pass for each skill that declared one.
  const hintLines: string[] = [];
  for (const skill of skills) {
    if (skill.frontmatter.argumentHint) {
      hintLines.push(`  - ${skill.name}: ${skill.frontmatter.argumentHint}`);
    }
  }
  // Named-arg lists (structured) surface separately. When a skill
  // declares `arguments: [target, focus]`, we tell the model the
  // exact keys it should pass via `key=value` tokens.
  const namedArgLines: string[] = [];
  for (const skill of skills) {
    const argsList = skill.frontmatter.arguments;
    if (argsList && argsList.length > 0) {
      namedArgLines.push(`  - ${skill.name}: ${argsList.join(", ")}`);
    }
  }

  const sections: string[] = [
    "Invoke a user-authored workflow skill. Each skill is a markdown " +
      "prompt the user wrote in `.aris/skills/<name>/SKILL.md` " +
      "describing a structured task (debugging, code review, brainstorming, etc.). " +
      "Call this tool with the skill name to receive its instructions, then " +
      "follow them inline as part of your response.",
    "",
    "Available skills:",
    manifestLines.join("\n"),
  ];
  if (hintLines.length > 0) {
    sections.push("", "Argument hints:", hintLines.join("\n"));
  }
  if (namedArgLines.length > 0) {
    sections.push(
      "",
      "Named arguments (pass via `key=value` tokens in `args`):",
      namedArgLines.join("\n"),
    );
  }
  sections.push(
    "",
    "Call with `name` set to one of the skill names above. The optional `args` " +
      "string is forwarded to the skill in two ways:",
    "  • verbatim: any `$ARGUMENTS` placeholder in the body is replaced with the full string.",
    "  • named: `key=value` tokens (whitespace-separated, quotes supported) populate " +
      '`$ARG_<KEY_UPPERCASE>` placeholders. Example: `target=auth.ts focus="session tokens"`.',
  );
  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Slash-command rewriting (32h)
// ---------------------------------------------------------------------------

export interface RewriteSlashCommandOptions {
  /** Raw user message text. */
  readonly text: string;
  /** Loaded skills, after project-precedence resolution. */
  readonly skills: ReadonlyArray<Skill>;
  /**
   * Optional shell-expansion config — same shape as the use_skill
   * tool. When present and `enabled: true`, the rewritten body has
   * `` `commands` `` resolved before it's returned. Off-by-default
   * matches the rest of the dispatch surface.
   */
  readonly shellExpansion?: ShellExpansionOptions;
}

export interface RewriteSlashCommandResult {
  /** Canonical name of the skill that matched the slash prefix. */
  readonly skillName: string;
  /** Args portion of the original message (whitespace after the skill name). */
  readonly args: string;
  /** Rewritten user message — the rendered skill body, ready to send to the model. */
  readonly text: string;
}

/**
 * Detect a `/skillname args...` prefix on the user's message and
 * rewrite the message into the rendered skill body.
 *
 *   "/debug stuck on websocket"   →   <rendered debug body with $ARGUMENTS="stuck on websocket">
 *
 * Returns `null` when the message either doesn't start with a slash
 * OR starts with a slash but the name doesn't match a loaded skill
 * (so a literal "/path/to/file" or "/help me" passes through
 * unchanged when there's no `path` or `help` skill — we don't
 * hijack arbitrary slashes).
 *
 * Recognized syntax:
 *   `/<name>`                — name only, args are empty
 *   `/<name> <args...>`      — name + free-form args (rest of message)
 *   `/<name>\n<args...>`     — same, multi-line args allowed
 *
 * Behavior matches `use_skill` for the inline path:
 *   - Tool-restriction prefix prepended when `allowed-tools` is set.
 *   - `$ARGUMENTS` and `$ARG_<NAME>` substitution applied.
 *   - Shell expansion applied when configured.
 *   - `context: fork` is ignored — slash-command dispatch is
 *     intentionally inline. The model sees the expanded prompt as
 *     the user's input and continues normally.
 */
export async function rewriteSlashCommand(
  opts: RewriteSlashCommandOptions,
): Promise<RewriteSlashCommandResult | null> {
  // Match "/" + name token + optional whitespace + remainder. The
  // name token greedily consumes non-whitespace, which means
  // `/debug-stuck-on-ws` would treat the whole hyphenated string as
  // the skill name. Skill names are usually short and not hyphen-
  // heavy, so this is fine in practice; if it bites we can tighten
  // the name pattern to `[A-Za-z0-9_-]+` later.
  const match = /^\/(\S+)(?:[ \t]+([\s\S]*))?$/.exec(opts.text);
  if (!match) return null;

  const skillName = match[1]!;
  const args = (match[2] ?? "").trim();
  const skill = opts.skills.find((s) => s.name === skillName);
  if (!skill) return null;

  let rendered = renderSkillForDispatch(
    skill.body,
    args.length > 0 ? args : undefined,
    skill.frontmatter.allowedTools,
  );
  if (opts.shellExpansion?.enabled) {
    const expanded = await expandShellSubstitutions(rendered, opts.shellExpansion);
    rendered = expanded.text;
  }

  // Slice 32h refinement — frame the rendered body as a directive,
  // not a definition. Without this prefix, skill bodies that read
  // like documentation (which most do — "## When the user asks for
  // X, run Y") confuse the model into describing the skill rather
  // than executing it. The framing makes the intent unambiguous:
  // the user invoked this skill and expects the workflow to run.
  const argsLine = args.length > 0 ? ` with arguments: ${args}` : "";
  const framedText =
    `The user invoked the \`/${skillName}\` skill${argsLine}. ` +
    `Execute the workflow below now — don't describe it, run it. ` +
    `Follow the body's instructions step by step, calling tools as needed.\n\n` +
    `---\n\n` +
    rendered;

  return { skillName, args, text: framedText };
}

/**
 * Build the `use_skill` SDK tool. Returns `null` when no skills are
 * loaded — callers should use `?? []` or a conditional spread to omit
 * the tool from the agent's array in that case.
 *
 * The tool's `execute` is a pure lookup-then-expand: no side effects,
 * no I/O. Skills are baked into the closure at creation time, which
 * means a hot-reload would require rebuilding the tool — fine for
 * 32b (load-once-per-session) and a clean integration point for 32i
 * (file-watcher-driven reload).
 */
export function createUseSkillTool(opts: CreateUseSkillToolOptions) {
  if (opts.skills.length === 0) return null;

  // Build a name→Skill map for O(1) lookup at execute time. Re-built
  // on every createUseSkillTool call which is fine — skills are
  // typically a small set (< 20) and this is a per-turn operation.
  const byName = new Map<string, Skill>();
  for (const skill of opts.skills) {
    byName.set(skill.name, skill);
  }

  // The skill name parameter is described as a free-form string rather
  // than a Zod enum so the SDK doesn't auto-reject calls with a name
  // not in the current manifest — we'd rather return a clear "unknown
  // skill" error message the model can act on (try a different name,
  // ask the user, etc.) than have the SDK fail-closed before our code
  // runs.
  const description = buildDescription(opts.skills);

  return tool({
    name: "use_skill",
    description,
    parameters: z.object({
      name: z
        .string()
        .describe("Skill name. Must match one of the names listed in this tool's description."),
      args: z
        .string()
        .nullable()
        .describe(
          "Optional argument string. Replaces `$ARGUMENTS` in the skill body verbatim. " +
            "May also include `key=value` tokens (whitespace-separated, single or double " +
            "quotes group values containing spaces) — each token populates the matching " +
            "`$ARG_<KEY_UPPERCASE>` placeholder. Pass null when the skill takes no args.",
        ),
    }),
    async execute({ name, args }) {
      const skill = byName.get(name);
      if (!skill) {
        const available = [...byName.keys()].toSorted().join(", ");
        return `Error: unknown skill '${name}'. Available skills: ${available || "(none)"}`;
      }
      let renderedBody = renderSkillForDispatch(
        skill.body,
        args ?? undefined,
        skill.frontmatter.allowedTools,
      );

      // Slice 32g — shell expansion. Runs AFTER placeholder
      // substitution so authors can compose `$ARGUMENTS` and live
      // commands in the same skill (e.g. "Compare $ARG_TARGET to
      // `git rev-parse HEAD`"). Errors surface as `[error: ...]`
      // placeholders in the body — never thrown — so a single bad
      // backtick can't kill the whole dispatch.
      if (opts.shellExpansion?.enabled) {
        const expanded: ShellExpansionResult = await expandShellSubstitutions(
          renderedBody,
          opts.shellExpansion,
        );
        renderedBody = expanded.text;
      }

      // Slice 32e — fork-mode dispatch. Hand off to the injected
      // executor; soft-fall-back to inline rendering with a warning
      // when no executor is configured (e.g. running from a context
      // that doesn't have an OpenAI client wired up).
      if (skill.frontmatter.context === "fork") {
        if (!opts.forkExecutor) {
          return (
            `[fork mode unavailable for skill '${name}', falling back to inline]\n\n` + renderedBody
          );
        }
        try {
          return await opts.forkExecutor({
            skill,
            renderedBody,
            args: args ?? undefined,
          });
        } catch (err) {
          // Convert thrown errors to a tool-result string so the
          // parent agent can read them and react. Throwing here
          // would mark the tool call as failed at the SDK level,
          // which is harsher than the model needs — a
          // "skill X failed: <reason>" string lets it carry on.
          const detail = err instanceof Error ? err.message : String(err);
          return `Error: skill '${name}' fork execution failed: ${detail}`;
        }
      }

      return renderedBody;
    },
  });
}
