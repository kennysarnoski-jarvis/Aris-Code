/**
 * ArisCommandsLoader tests — frontmatter parser + disk discovery.
 *
 * Mirrors the structure of ArisSkillsLoader.test.ts. Commands are flat
 * `<name>.md` files under `.aris/commands/`; the filename (sans `.md`)
 * is the canonical name.
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type Command,
  type LoadCommandsOptions,
  loadAllCommands,
  parseCommandFile,
} from "./ArisCommandsLoader.ts";

const bundledCommand = (name: string, body: string): Command => ({
  name,
  source: "bundled",
  filePath: `<bundled:${name}>`,
  frontmatter: { raw: Object.freeze({}) },
  body,
});

// ---------------------------------------------------------------------------
// parseCommandFile — pure parser tests
// ---------------------------------------------------------------------------

describe("parseCommandFile", () => {
  it("parses a command file with full frontmatter", () => {
    const content = [
      "---",
      "description: Enforce test-driven development workflow",
      "argument-hint: <feature or bug to TDD>",
      "arguments:",
      "  - target",
      "  - focus",
      "---",
      "# TDD Command",
      "",
      "Run the TDD workflow.",
    ].join("\n");

    const parsed = parseCommandFile(content);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    expect(parsed.frontmatter.description).toBe("Enforce test-driven development workflow");
    expect(parsed.frontmatter.argumentHint).toBe("<feature or bug to TDD>");
    expect(parsed.frontmatter.arguments).toEqual(["target", "focus"]);
    expect(parsed.body).toBe("# TDD Command\n\nRun the TDD workflow.");
  });

  it("treats a file without frontmatter as body-only", () => {
    const content = "Just plain workflow text\n\nNo frontmatter.";
    const parsed = parseCommandFile(content);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    expect(parsed.frontmatter.description).toBeUndefined();
    expect(parsed.body).toBe(content.trim());
  });

  it("returns null when frontmatter is opened but never closed", () => {
    const content = "---\ndescription: oops\n";
    expect(parseCommandFile(content)).toBeNull();
  });

  it("preserves unknown frontmatter keys on `raw`", () => {
    const content = [
      "---",
      "description: future-command",
      "origin: ECC",
      "custom-knob: experimental",
      "---",
      "body",
    ].join("\n");
    const parsed = parseCommandFile(content);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    expect(parsed.frontmatter.raw["origin"]).toBe("ECC");
    expect(parsed.frontmatter.raw["custom-knob"]).toBe("experimental");
  });

  it("ignores frontmatter `name` (filename is canonical)", () => {
    const content = [
      "---",
      "name: ignored-name",
      "description: only description gets typed",
      "---",
      "body",
    ].join("\n");
    const parsed = parseCommandFile(content);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    // typed view doesn't surface `name`
    expect((parsed.frontmatter as { name?: string }).name).toBeUndefined();
    // raw still preserves it
    expect(parsed.frontmatter.raw["name"]).toBe("ignored-name");
  });
});

// ---------------------------------------------------------------------------
// loadAllCommands — disk discovery
// ---------------------------------------------------------------------------

describe("loadAllCommands", () => {
  let tmpRoot: string;
  let projectDir: string;
  let userHome: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aris-commands-"));
    projectDir = path.join(tmpRoot, "project");
    userHome = path.join(tmpRoot, "home");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(userHome, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  const writeCommand = async (base: string, name: string, content: string): Promise<string> => {
    const dir = path.join(base, ".aris", "commands");
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${name}.md`);
    await fs.writeFile(filePath, content);
    return filePath;
  };

  const opts = (extra?: Partial<LoadCommandsOptions>): LoadCommandsOptions => ({
    workspaceRoot: projectDir,
    userHome,
    ...extra,
  });

  it("returns empty when no .aris/commands exists in either root", async () => {
    const result = await loadAllCommands(opts());
    expect(result.commands).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("discovers project commands by filename", async () => {
    await writeCommand(projectDir, "tdd", "---\ndescription: TDD workflow\n---\n\nRun TDD.");
    await writeCommand(projectDir, "plan", "---\ndescription: Plan a feature\n---\n\nPlan it.");
    const result = await loadAllCommands(opts());
    expect(result.errors).toEqual([]);
    expect(result.commands.map((c) => ({ name: c.name, source: c.source }))).toEqual([
      { name: "plan", source: "project" },
      { name: "tdd", source: "project" },
    ]);
  });

  it("discovers user commands", async () => {
    await writeCommand(userHome, "checkpoint", "---\ndescription: Save state\n---\n\nCheckpoint.");
    const result = await loadAllCommands(opts());
    expect(result.errors).toEqual([]);
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]?.name).toBe("checkpoint");
    expect(result.commands[0]?.source).toBe("user");
  });

  it("project command wins when both roots define the same name", async () => {
    await writeCommand(
      projectDir,
      "tdd",
      "---\ndescription: project-version\n---\n\nProject body.",
    );
    await writeCommand(userHome, "tdd", "---\ndescription: user-version\n---\n\nUser body.");
    const result = await loadAllCommands(opts());
    expect(result.errors).toEqual([]);
    expect(result.commands).toHaveLength(1);
    const cmd = result.commands[0]!;
    expect(cmd.source).toBe("project");
    expect(cmd.frontmatter.description).toBe("project-version");
    expect(cmd.body).toBe("Project body.");
  });

  it("user wins over bundled, project wins over both", async () => {
    await writeCommand(projectDir, "tdd", "---\ndescription: project\n---\n\nProject body.");
    await writeCommand(userHome, "tdd", "---\ndescription: user\n---\n\nUser body.");
    const bundled = [
      bundledCommand("tdd", "Bundled body."),
      bundledCommand("only-bundled", "Only."),
    ];
    const result = await loadAllCommands(opts({ bundledCommands: bundled }));
    expect(result.errors).toEqual([]);
    const byName = new Map(result.commands.map((c) => [c.name, c]));
    expect(byName.get("tdd")?.source).toBe("project");
    expect(byName.get("tdd")?.body).toBe("Project body.");
    expect(byName.get("only-bundled")?.source).toBe("bundled");
    expect(byName.get("only-bundled")?.body).toBe("Only.");
  });

  it("ignores non-.md files in the commands directory", async () => {
    const dir = path.join(projectDir, ".aris", "commands");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "README.txt"), "ignore me");
    await fs.writeFile(path.join(dir, "tdd.md"), "---\ndescription: TDD\n---\n\nBody.");
    const result = await loadAllCommands(opts());
    expect(result.errors).toEqual([]);
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]?.name).toBe("tdd");
  });

  it("ignores directories inside .aris/commands", async () => {
    const dir = path.join(projectDir, ".aris", "commands");
    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(path.join(dir, "subdir.md"), { recursive: true }); // ends in .md but is a dir
    await fs.writeFile(path.join(dir, "tdd.md"), "---\ndescription: TDD\n---\n\nBody.");
    const result = await loadAllCommands(opts());
    expect(result.errors).toEqual([]);
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]?.name).toBe("tdd");
  });

  it("reports a per-file error for unclosed frontmatter without dropping siblings", async () => {
    await writeCommand(projectDir, "broken", "---\ndescription: oops\n");
    await writeCommand(projectDir, "ok", "---\ndescription: fine\n---\n\nFine body.");
    const result = await loadAllCommands(opts());
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]?.name).toBe("ok");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toContain("broken.md");
  });

  it("uses filename as canonical name even when frontmatter declares `name`", async () => {
    await writeCommand(
      projectDir,
      "tdd",
      "---\nname: should-be-ignored\ndescription: TDD\n---\n\nBody.",
    );
    const result = await loadAllCommands(opts());
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]?.name).toBe("tdd");
  });

  it("skips user discovery when userHome is null", async () => {
    await writeCommand(userHome, "checkpoint", "---\ndescription: save\n---\n\nBody.");
    const result = await loadAllCommands({ workspaceRoot: projectDir, userHome: null });
    expect(result.commands).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("skips project discovery when workspaceRoot is undefined", async () => {
    await writeCommand(projectDir, "tdd", "---\ndescription: TDD\n---\n\nBody.");
    const result = await loadAllCommands({ workspaceRoot: undefined, userHome });
    expect(result.commands).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("commands are returned sorted by name", async () => {
    await writeCommand(projectDir, "zebra", "---\ndescription: z\n---\n\nz");
    await writeCommand(projectDir, "alpha", "---\ndescription: a\n---\n\na");
    await writeCommand(projectDir, "mango", "---\ndescription: m\n---\n\nm");
    const result = await loadAllCommands(opts());
    expect(result.commands.map((c) => c.name)).toEqual(["alpha", "mango", "zebra"]);
  });
});
