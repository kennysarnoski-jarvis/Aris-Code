/**
 * ArisCommandsTool — register `use_command` as an SDK tool the model
 * can invoke to expand a user-authored command body.
 *
 * Pairs with `ArisCommandsLoader.ts`. The flow mirrors `use_skill`:
 *   1. Adapter calls `loadAllCommands(...)` per turn.
 *   2. Adapter calls `createUseCommandTool({ commands })` and adds the
 *      result to the SDK tools array (only when commands.length > 0).
 *   3. Model sees the tool's description (which carries the commands
 *      manifest), decides to call it, the SDK dispatches `execute`,
 *      we look up the command body and return it as a string.
 *   4. Model reads the body and follows the instructions inline.
 *
 * Why commands are model-invokable (in addition to user-only slash dispatch):
 *   The user pushed back on the earlier "user-only" framing. Right call:
 *   if `use_skill` lets the model autonomously invoke a skill when the
 *   user's intent matches, the same logic applies to commands. Aris's
 *   conceptual split stays the same — skills are richer (fork mode,
 *   model+effort overrides, allowed-tools), commands are the lightweight
 *   surface — but BOTH surfaces are accessible to user AND model.
 *
 * Differences vs `use_skill`:
 *   - No fork mode (commands don't have `context: fork`).
 *   - No `allowed-tools` enforcement (commands don't declare those).
 *   - No model/effort overrides (commands don't have those fields).
 *   - The description framing emphasizes "command" semantics and uses
 *     `description` instead of `when-to-use` (commands don't have a
 *     dedicated when-to-use field; their `description` carries the
 *     same role).
 *
 * Same as `use_skill`:
 *   - `$ARGUMENTS` and `$ARG_<NAME>` substitution via the shared
 *     `expandSkillBody` helper. Authors don't need to learn two
 *     placeholder dialects.
 *   - Optional shell expansion in the body when enabled at the
 *     adapter level (off by default).
 *   - The `execute` callback returns the rendered body as a string —
 *     no separate framing prefix, because the model already knows it
 *     invoked the tool deliberately (unlike slash dispatch, which
 *     rewrites the user message and needs explicit framing).
 *
 * @module ArisCommandsTool
 */
import { tool } from "@openai/agents";
import { z } from "zod";

import type { Command } from "./ArisCommandsLoader.ts";
import { expandSkillBody } from "./ArisSkillsTool.ts";
import {
  type ShellExpansionOptions,
  type ShellExpansionResult,
  expandShellSubstitutions,
} from "./ArisSkillsShellExpansion.ts";

export interface CreateUseCommandToolOptions {
  /** Loaded commands, after project-precedence resolution. */
  readonly commands: ReadonlyArray<Command>;
  /**
   * Optional shell-expansion config (same as `use_skill`). When
   * provided AND `enabled: true`, backtick substrings in the rendered
   * body are resolved at execute time. Off-by-default for safety.
   */
  readonly shellExpansion?: ShellExpansionOptions;
}

/**
 * Build the description string the model reads to decide when to
 * invoke `use_command`. Bakes the available commands manifest into
 * the description so the model doesn't need a separate listing call.
 */
function buildDescription(commands: ReadonlyArray<Command>): string {
  const manifestLines: string[] = [];
  for (const cmd of commands) {
    const desc = cmd.frontmatter.description ?? "(no description)";
    manifestLines.push(`  - ${cmd.name} — ${desc}`);
  }

  // Argument hints surface separately for the commands that declared one.
  const hintLines: string[] = [];
  for (const cmd of commands) {
    if (cmd.frontmatter.argumentHint) {
      hintLines.push(`  - ${cmd.name}: ${cmd.frontmatter.argumentHint}`);
    }
  }

  // Named-arg lists for commands that declared structured arguments.
  const namedArgLines: string[] = [];
  for (const cmd of commands) {
    const argsList = cmd.frontmatter.arguments;
    if (argsList && argsList.length > 0) {
      namedArgLines.push(`  - ${cmd.name}: ${argsList.join(", ")}`);
    }
  }

  const sections: string[] = [
    "Invoke a user-authored slash command. Each command is a markdown " +
      "workflow the user wrote in `.aris/commands/<name>.md` describing " +
      "a structured task (build fixing, plan generation, code review, " +
      "etc.). Call this tool with the command name when the user's " +
      "current intent matches the command's purpose — same logic as " +
      "`use_skill`, just a different surface of user-authored workflows.",
    "",
    "Available commands:",
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
    "Call with `name` set to one of the command names above. The optional `args` " +
      "string is forwarded to the command in two ways:",
    "  • verbatim: any `$ARGUMENTS` placeholder in the body is replaced with the full string.",
    "  • named: `key=value` tokens (whitespace-separated, quotes supported) populate " +
      '`$ARG_<KEY_UPPERCASE>` placeholders. Example: `target=auth.ts focus="session tokens"`.',
  );
  return sections.join("\n");
}

/**
 * Build the `use_command` SDK tool. Returns `null` when no commands
 * are loaded — callers should use `?? []` or a conditional spread to
 * omit the tool from the agent's array in that case.
 *
 * The `execute` is a pure lookup-then-expand: no side effects beyond
 * the optional shell expansion. Commands are baked into the closure at
 * creation time; hot-reload requires rebuilding the tool (cheap — done
 * once per turn).
 */
export function createUseCommandTool(opts: CreateUseCommandToolOptions) {
  if (opts.commands.length === 0) return null;

  // Build a name→Command map for O(1) lookup at execute time.
  const byName = new Map<string, Command>();
  for (const cmd of opts.commands) {
    byName.set(cmd.name, cmd);
  }

  const description = buildDescription(opts.commands);

  return tool({
    name: "use_command",
    description,
    parameters: z.object({
      name: z
        .string()
        .describe("Command name. Must match one of the names listed in this tool's description."),
      args: z
        .string()
        .nullable()
        .describe(
          "Optional argument string. Replaces `$ARGUMENTS` in the command body verbatim. " +
            "May also include `key=value` tokens (whitespace-separated, single or double " +
            "quotes group values containing spaces) — each token populates the matching " +
            "`$ARG_<KEY_UPPERCASE>` placeholder. Pass null when the command takes no args.",
        ),
    }),
    async execute({ name, args }) {
      const command = byName.get(name);
      if (!command) {
        const available = [...byName.keys()].toSorted().join(", ");
        return `Error: unknown command '${name}'. Available commands: ${available || "(none)"}`;
      }

      let renderedBody = expandSkillBody(command.body, args ?? undefined);

      // Shell expansion (same semantics as use_skill). Runs AFTER
      // placeholder substitution so `$ARGUMENTS` can compose with
      // live backtick commands. Errors surface as `[error: ...]`
      // placeholders in the body — never thrown — so a single bad
      // backtick can't kill the whole dispatch.
      if (opts.shellExpansion?.enabled) {
        const expanded: ShellExpansionResult = await expandShellSubstitutions(
          renderedBody,
          opts.shellExpansion,
        );
        renderedBody = expanded.text;
      }

      return renderedBody;
    },
  });
}
