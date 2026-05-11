/**
 * ArisSkillsLoader tests — frontmatter parser + disk discovery.
 *
 * Strategy: write fixtures into a tmpdir, run the loader against it,
 * assert on the returned `Skill[]` shape. The parser-only cases stay
 * pure (string in → struct out) and don't touch disk.
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type LoadSkillsOptions,
  type Skill,
  loadAllSkills,
  parseSkillFile,
} from "./ArisSkillsLoader.ts";

// Helper used by the bundled-skills suite; hoisted to module scope so
// the lint rule (consistent-function-scoping) doesn't flag it.
const bundledSkill = (name: string, body: string): Skill => ({
  name,
  source: "bundled",
  filePath: `<bundled:${name}>`,
  directory: `<bundled:${name}>`,
  frontmatter: { raw: Object.freeze({}) },
  body,
});

// ---------------------------------------------------------------------------
// parseSkillFile — pure parser tests
// ---------------------------------------------------------------------------

describe("parseSkillFile", () => {
  it("parses a SKILL.md with full frontmatter", () => {
    const content = [
      "---",
      "name: debug",
      "description: Systematic debugging workflow",
      "when-to-use: When the user is stuck or asks for help diagnosing",
      "argument-hint: <description of what's broken>",
      "allowed-tools: [read_file, edit_file, bash]",
      "model: gpt-5.4",
      "effort: high",
      "context: inline",
      "disableNonInteractive: false",
      "---",
      "# Goal",
      "Walk through the debugging workflow.",
      "",
    ].join("\n");

    const parsed = parseSkillFile(content);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    expect(parsed.frontmatter.name).toBe("debug");
    expect(parsed.frontmatter.description).toBe("Systematic debugging workflow");
    expect(parsed.frontmatter.whenToUse).toBe("When the user is stuck or asks for help diagnosing");
    expect(parsed.frontmatter.argumentHint).toBe("<description of what's broken>");
    expect(parsed.frontmatter.allowedTools).toEqual(["read_file", "edit_file", "bash"]);
    expect(parsed.frontmatter.model).toBe("gpt-5.4");
    expect(parsed.frontmatter.effort).toBe("high");
    expect(parsed.frontmatter.context).toBe("inline");
    expect(parsed.frontmatter.disableNonInteractive).toBe(false);
    expect(parsed.body).toBe("# Goal\nWalk through the debugging workflow.");
  });

  it("treats a file without frontmatter as body-only", () => {
    const content = "Just plain markdown\n\nNo frontmatter at all.";
    const parsed = parseSkillFile(content);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    expect(parsed.frontmatter.name).toBeUndefined();
    expect(parsed.body).toBe(content.trim());
  });

  it("returns null when frontmatter is opened but never closed", () => {
    const content = "---\nname: stuck\ndescription: oops, no closing delim\n";
    expect(parseSkillFile(content)).toBeNull();
  });

  it("parses block-list arrays alongside inline arrays", () => {
    const content = [
      "---",
      "name: review",
      "allowed-tools:",
      "  - read_file",
      "  - grep",
      "paths: [src/, packages/contracts]",
      "---",
      "Body.",
    ].join("\n");
    const parsed = parseSkillFile(content);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    expect(parsed.frontmatter.allowedTools).toEqual(["read_file", "grep"]);
    expect(parsed.frontmatter.paths).toEqual(["src/", "packages/contracts"]);
  });

  it("strips quotes from scalar values", () => {
    const content = [
      "---",
      'name: "quoted-name"',
      "description: 'single-quoted'",
      "---",
      "Body.",
    ].join("\n");
    const parsed = parseSkillFile(content);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    expect(parsed.frontmatter.name).toBe("quoted-name");
    expect(parsed.frontmatter.description).toBe("single-quoted");
  });

  it("handles inline arrays with embedded commas in quoted items", () => {
    const content = ["---", 'allowed-tools: [a, "b, c", d]', "---", ""].join("\n");
    const parsed = parseSkillFile(content);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    expect(parsed.frontmatter.allowedTools).toEqual(["a", "b, c", "d"]);
  });

  it("recognizes boolean true/false (and yes/no) regardless of case", () => {
    const content = ["---", "disableNonInteractive: TRUE", "---", ""].join("\n");
    const parsed = parseSkillFile(content);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    expect(parsed.frontmatter.disableNonInteractive).toBe(true);
  });

  it("ignores comments and blank lines inside frontmatter", () => {
    const content = [
      "---",
      "# this is a comment",
      "",
      "name: explain",
      "# another",
      "description: teach a concept",
      "---",
      "body",
    ].join("\n");
    const parsed = parseSkillFile(content);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    expect(parsed.frontmatter.name).toBe("explain");
    expect(parsed.frontmatter.description).toBe("teach a concept");
  });

  it("rejects invalid context values without erroring", () => {
    const content = ["---", "context: weird", "---", "body"].join("\n");
    const parsed = parseSkillFile(content);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    expect(parsed.frontmatter.context).toBeUndefined();
    // raw still preserves the original value for forward-compat audits.
    expect(parsed.frontmatter.raw["context"]).toBe("weird");
  });

  it("preserves unknown frontmatter keys on `raw`", () => {
    const content = ["---", "name: future-skill", "future-knob: experimental", "---", "body"].join(
      "\n",
    );
    const parsed = parseSkillFile(content);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    expect(parsed.frontmatter.raw["future-knob"]).toBe("experimental");
  });

  it("parses the `arguments` block list into a string array (32c)", () => {
    const content = [
      "---",
      "name: review",
      "arguments:",
      "  - target",
      "  - focus",
      "---",
      "body",
    ].join("\n");
    const parsed = parseSkillFile(content);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    expect(parsed.frontmatter.arguments).toEqual(["target", "focus"]);
  });

  it("parses the `arguments` inline array form (32c)", () => {
    const content = ["---", "name: review", "arguments: [target, focus]", "---", "body"].join("\n");
    const parsed = parseSkillFile(content);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    expect(parsed.frontmatter.arguments).toEqual(["target", "focus"]);
  });
});

// ---------------------------------------------------------------------------
// loadAllSkills — disk discovery
// ---------------------------------------------------------------------------

describe("loadAllSkills", () => {
  let tmpRoot: string;
  let projectDir: string;
  let userHome: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aris-skills-"));
    projectDir = path.join(tmpRoot, "project");
    userHome = path.join(tmpRoot, "home");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(userHome, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  const writeSkill = async (base: string, name: string, content: string): Promise<string> => {
    const dir = path.join(base, ".aris", "skills", name);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "SKILL.md");
    await fs.writeFile(filePath, content);
    return filePath;
  };

  const opts = (extra?: Partial<LoadSkillsOptions>): LoadSkillsOptions => ({
    workspaceRoot: projectDir,
    userHome,
    ...extra,
  });

  it("returns empty when no .aris/skills exists in either root", async () => {
    const result = await loadAllSkills(opts());
    expect(result.skills).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("discovers project skills", async () => {
    await writeSkill(
      projectDir,
      "debug",
      "---\nname: debug\ndescription: debug helper\n---\n\nBody.",
    );
    await writeSkill(projectDir, "review", "---\nname: review\n---\n\nReview the code.");
    const result = await loadAllSkills(opts());
    expect(result.errors).toEqual([]);
    expect(result.skills.map((s) => ({ name: s.name, source: s.source }))).toEqual([
      { name: "debug", source: "project" },
      { name: "review", source: "project" },
    ]);
  });

  it("discovers user skills", async () => {
    await writeSkill(userHome, "explain", "---\nname: explain\n---\n\nExplain a concept.");
    const result = await loadAllSkills(opts());
    expect(result.errors).toEqual([]);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]?.name).toBe("explain");
    expect(result.skills[0]?.source).toBe("user");
  });

  it("project skill wins when both roots define the same name", async () => {
    await writeSkill(
      projectDir,
      "debug",
      "---\nname: debug\ndescription: project-version\n---\n\nProject body.",
    );
    await writeSkill(
      userHome,
      "debug",
      "---\nname: debug\ndescription: user-version\n---\n\nUser body.",
    );
    const result = await loadAllSkills(opts());
    expect(result.errors).toEqual([]);
    expect(result.skills).toHaveLength(1);
    const skill = result.skills[0]!;
    expect(skill.source).toBe("project");
    expect(skill.frontmatter.description).toBe("project-version");
    expect(skill.body).toBe("Project body.");
  });

  it("falls back to the directory name when frontmatter has no `name:`", async () => {
    await writeSkill(projectDir, "no-name-here", "Just a body, no frontmatter.");
    const result = await loadAllSkills(opts());
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]?.name).toBe("no-name-here");
  });

  it("skips a directory that doesn't contain SKILL.md", async () => {
    const orphanDir = path.join(projectDir, ".aris", "skills", "empty-dir");
    await fs.mkdir(orphanDir, { recursive: true });
    const result = await loadAllSkills(opts());
    expect(result.skills).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("reports a per-file error when frontmatter is malformed but doesn't block siblings", async () => {
    await writeSkill(projectDir, "good", "---\nname: good\n---\n\nBody.");
    await writeSkill(projectDir, "broken", "---\nname: broken\n(no closing delim)");
    const result = await loadAllSkills(opts());
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]?.name).toBe("good");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toMatch(/never closed/);
    expect(result.errors[0]?.source).toBe("project");
  });

  it("skips user-scope discovery when userHome is null", async () => {
    await writeSkill(
      userHome,
      "explain",
      "---\nname: explain\n---\n\nWould be loaded if userHome wasn't null.",
    );
    const result = await loadAllSkills({
      workspaceRoot: projectDir,
      userHome: null,
    });
    expect(result.skills).toEqual([]);
  });

  it("skips project-scope discovery when workspaceRoot is undefined", async () => {
    await writeSkill(userHome, "explain", "---\nname: explain\n---\n\nLoaded.");
    await writeSkill(
      projectDir,
      "debug",
      "---\nname: debug\n---\n\nNot loaded — workspaceRoot is undefined.",
    );
    const result = await loadAllSkills({
      workspaceRoot: undefined,
      userHome,
    });
    expect(result.skills.map((s) => s.name)).toEqual(["explain"]);
  });

  // ── 32j — bundled skills ─────────────────────────────────────────

  it("merges bundled skills at the lowest precedence", async () => {
    await writeSkill(projectDir, "debug", "---\nname: debug\n---\n\nProject debug.");
    const result = await loadAllSkills({
      workspaceRoot: projectDir,
      userHome,
      bundledSkills: [
        bundledSkill("debug", "Bundled debug — should be overridden."),
        bundledSkill("changelog", "Bundled changelog body."),
      ],
    });
    // Project debug wins; bundled debug is dropped; bundled changelog
    // surfaces because nobody else claimed that name.
    expect(result.skills.map((s) => ({ name: s.name, source: s.source }))).toEqual([
      { name: "debug", source: "project" },
      { name: "changelog", source: "bundled" },
    ]);
    const debug = result.skills.find((s) => s.name === "debug")!;
    expect(debug.body).toBe("Project debug.");
  });

  it("user can override bundled even when project doesn't claim the name", async () => {
    await writeSkill(userHome, "changelog", "---\nname: changelog\n---\n\nUser changelog.");
    const result = await loadAllSkills({
      workspaceRoot: projectDir,
      userHome,
      bundledSkills: [bundledSkill("changelog", "Bundled fallback.")],
    });
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]?.source).toBe("user");
    expect(result.skills[0]?.body).toBe("User changelog.");
  });

  it("bundled skills surface when project and user are absent / empty", async () => {
    const result = await loadAllSkills({
      workspaceRoot: projectDir,
      userHome,
      bundledSkills: [bundledSkill("help", "Bundled help body.")],
    });
    expect(result.skills.map((s) => s.name)).toEqual(["help"]);
    expect(result.skills[0]?.source).toBe("bundled");
  });

  it("an empty bundledSkills list (or undefined) is a no-op", async () => {
    const result = await loadAllSkills({
      workspaceRoot: projectDir,
      userHome,
      bundledSkills: [],
    });
    expect(result.skills).toEqual([]);
    const result2 = await loadAllSkills({
      workspaceRoot: projectDir,
      userHome,
    });
    expect(result2.skills).toEqual([]);
  });
});
