/**
 * ArisSkillsShellExpansion tests.
 *
 * Most cases use real spawn() against safe, deterministic commands
 * (`echo`, `pwd`, `printf`) so the security gates are exercised
 * end-to-end rather than mocked at the boundary. The validation-only
 * tests (allow-list, metachar gate) don't need to spawn at all and
 * just observe the error output.
 */
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { DEFAULT_ALLOWED_COMMANDS, expandShellSubstitutions } from "./ArisSkillsShellExpansion.ts";

// ---------------------------------------------------------------------------
// Disabled / no-op
// ---------------------------------------------------------------------------

describe("expandShellSubstitutions — disabled / no-op", () => {
  it("renders backticks verbatim when enabled is false", async () => {
    const out = await expandShellSubstitutions("Branch: `git rev-parse HEAD`", {
      enabled: false,
      cwd: process.cwd(),
    });
    expect(out.text).toBe("Branch: `git rev-parse HEAD`");
    expect(out.errors).toEqual([]);
  });

  it("returns the text unchanged when no backticks are present (even if enabled)", async () => {
    const out = await expandShellSubstitutions("plain text, nothing fancy", {
      enabled: true,
      cwd: process.cwd(),
    });
    expect(out.text).toBe("plain text, nothing fancy");
    expect(out.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Allow-list enforcement
// ---------------------------------------------------------------------------

describe("expandShellSubstitutions — allow-list", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aris-shell-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("blocks commands not in the allow-list", async () => {
    // `rm` is intentionally absent from DEFAULT_ALLOWED_COMMANDS.
    const out = await expandShellSubstitutions("delete: `rm -rf /tmp/anything`", {
      enabled: true,
      cwd: tmpDir,
    });
    expect(out.text).toContain("[error:");
    expect(out.text).toContain("not in the allow-list");
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]?.command).toBe("rm -rf /tmp/anything");
  });

  it("blocks sudo regardless of subcommand", async () => {
    const out = await expandShellSubstitutions("info: `sudo whoami`", {
      enabled: true,
      cwd: tmpDir,
    });
    expect(out.text).toContain("[error:");
    expect(out.errors[0]?.reason).toContain("not in the allow-list");
  });

  it("allows commands in the default list (echo)", async () => {
    const out = await expandShellSubstitutions("hello: `echo world`", {
      enabled: true,
      cwd: tmpDir,
    });
    expect(out.text).toBe("hello: world");
    expect(out.errors).toEqual([]);
  });

  it("respects a custom allow-list override", async () => {
    // Same allowlist as default but without echo. echo should now fail.
    const allow = new Set(DEFAULT_ALLOWED_COMMANDS);
    allow.delete("echo");
    const out = await expandShellSubstitutions("hello: `echo world`", {
      enabled: true,
      cwd: tmpDir,
      allowedCommands: allow,
    });
    expect(out.text).toContain("[error:");
    expect(out.errors[0]?.reason).toContain("not in the allow-list");
  });

  it("matches allow-list against argv[0]'s basename, not the full path", async () => {
    // /bin/echo and echo should both pass. We can't guarantee /bin/echo
    // exists portably, so this test asserts at the validation layer:
    // the validator strips the leading directory and matches "echo".
    // We exercise that by passing a path-like argv that platforms
    // generally support.
    const out = await expandShellSubstitutions("`/bin/echo hi`", {
      enabled: true,
      cwd: tmpDir,
    });
    // On systems with /bin/echo, this succeeds and outputs "hi".
    // On systems without it, it errors at spawn (still graceful) but
    // the validation step accepts it. Either way: no allow-list error
    // anywhere in the error list (and an empty list is fine too).
    for (const err of out.errors) {
      expect(err.reason).not.toContain("not in the allow-list");
    }
  });
});

// ---------------------------------------------------------------------------
// Metachar gate
// ---------------------------------------------------------------------------

describe("expandShellSubstitutions — metachar gate", () => {
  it.each([
    ["pipe", "`echo hi | cat`"],
    ["redirect-out", "`echo hi > /tmp/out`"],
    ["redirect-in", "`cat < /tmp/in`"],
    ["semicolon", "`echo hi; rm -rf /`"],
    ["background", "`sleep 100 &`"],
    ["env-var", "`echo $HOME`"],
    ["command-subst", "`echo $(whoami)`"],
    ["nested-backtick", "`echo \\`whoami\\``"],
    ["backslash", "`echo a\\b`"],
  ])("blocks %s", async (_label, body) => {
    const out = await expandShellSubstitutions(body, {
      enabled: true,
      cwd: process.cwd(),
    });
    expect(out.text).toContain("[error:");
    expect(out.errors[0]?.reason).toMatch(/metacharacter|denied pattern/);
  });

  it("blocks find -exec specifically (denied pattern)", async () => {
    const out = await expandShellSubstitutions("`find . -exec rm {} +`", {
      enabled: true,
      cwd: process.cwd(),
    });
    expect(out.text).toContain("[error:");
    expect(out.errors[0]?.reason).toContain("-exec");
  });

  it("rejects unbalanced quotes", async () => {
    const out = await expandShellSubstitutions(`\`echo "missing\``, {
      enabled: true,
      cwd: process.cwd(),
    });
    expect(out.text).toContain("[error:");
    expect(out.errors[0]?.reason).toContain("unbalanced quotes");
  });
});

// ---------------------------------------------------------------------------
// Live execution
// ---------------------------------------------------------------------------

describe("expandShellSubstitutions — live exec", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aris-shell-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("substitutes the stdout of a successful command", async () => {
    const out = await expandShellSubstitutions("now: `echo hello`!", {
      enabled: true,
      cwd: tmpDir,
    });
    expect(out.text).toBe("now: hello!");
  });

  it("trims trailing newlines from stdout", async () => {
    const out = await expandShellSubstitutions("[`echo trim`]", {
      enabled: true,
      cwd: tmpDir,
    });
    expect(out.text).toBe("[trim]");
  });

  it("supports quoted args containing spaces", async () => {
    const out = await expandShellSubstitutions(`[\`echo "a b c"\`]`, {
      enabled: true,
      cwd: tmpDir,
    });
    expect(out.text).toBe("[a b c]");
  });

  it("substitutes multiple backticks in order", async () => {
    const out = await expandShellSubstitutions("a=`echo one` b=`echo two`", {
      enabled: true,
      cwd: tmpDir,
    });
    expect(out.text).toBe("a=one b=two");
  });

  it("runs inside the supplied cwd", async () => {
    const out = await expandShellSubstitutions("here: `pwd`", {
      enabled: true,
      cwd: tmpDir,
    });
    // macOS resolves /tmp through /private/tmp; accept either form.
    const realTmp = await fs.realpath(tmpDir);
    expect([tmpDir, realTmp]).toContain(out.text.replace("here: ", ""));
  });

  it("reports nonzero exit codes as errors", async () => {
    // `cat` on a non-existent file exits 1.
    const out = await expandShellSubstitutions("`cat /tmp/this-file-should-not-exist-xyz123`", {
      enabled: true,
      cwd: tmpDir,
    });
    expect(out.text).toContain("[error:");
    expect(out.errors[0]?.reason).toMatch(/exited with code/);
  });
});
