/**
 * ArisAgentTemplatesLoader tests — frontmatter parser + disk discovery.
 *
 * Mirrors `ArisSkillsLoader.test.ts`'s shape. The frontmatter dialect
 * is shared (both loaders route through `parseMarkdownWithFrontmatter`)
 * so the parser-level cases here only exercise the agent-specific
 * typed projection (name, description, model, effort, allowed-tools,
 * max-turns). Generic parser behavior — quoted scalars, inline arrays,
 * block lists, malformed-close handling — is already covered by the
 * skills loader test suite.
 *
 * Strategy: write fixtures into a tmpdir, run the loader against it,
 * assert on the returned `AgentTemplate[]` shape. The parser-only
 * cases stay pure (string in → struct out) and don't touch disk.
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type AgentTemplate,
  type LoadAgentTemplatesOptions,
  loadAllAgentTemplates,
  parseAgentTemplateFile,
} from "./ArisAgentTemplatesLoader.ts";

// Helper used by the bundled-templates suite; hoisted to module scope
// so the lint rule (consistent-function-scoping) doesn't flag it.
const bundledTemplate = (name: string, body: string): AgentTemplate => ({
  name,
  source: "bundled",
  filePath: `<bundled:${name}>`,
  directory: `<bundled:${name}>`,
  frontmatter: { raw: Object.freeze({}) },
  body,
});

// ---------------------------------------------------------------------------
// parseAgentTemplateFile — agent-specific projection tests
// ---------------------------------------------------------------------------

describe("parseAgentTemplateFile", () => {
  it("parses an AGENT.md with full frontmatter (all known fields)", () => {
    const content = [
      "---",
      "name: code-reviewer",
      "description: Reviews code for quality, security, maintainability",
      "model: deepseek-v4-pro",
      "effort: high",
      "allowed-tools: [search_knowledge, search_cve]",
      "max-turns: 50",
      "---",
      "# Role",
      "You are a senior code reviewer.",
      "",
    ].join("\n");

    const parsed = parseAgentTemplateFile(content);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    expect(parsed.frontmatter.name).toBe("code-reviewer");
    expect(parsed.frontmatter.description).toBe(
      "Reviews code for quality, security, maintainability",
    );
    expect(parsed.frontmatter.model).toBe("deepseek-v4-pro");
    expect(parsed.frontmatter.effort).toBe("high");
    expect(parsed.frontmatter.allowedTools).toEqual(["search_knowledge", "search_cve"]);
    expect(parsed.frontmatter.maxTurns).toBe(50);
    expect(parsed.body).toBe("# Role\nYou are a senior code reviewer.");
  });

  it("treats an AGENT.md without frontmatter as body-only", () => {
    const content = "Just a system prompt with no routing config.";
    const parsed = parseAgentTemplateFile(content);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    expect(parsed.frontmatter.name).toBeUndefined();
    expect(parsed.frontmatter.model).toBeUndefined();
    expect(parsed.body).toBe(content.trim());
  });

  it("returns null when frontmatter is opened but never closed (shared parser behavior)", () => {
    const content = "---\nname: incomplete\nmodel: deepseek-v4-pro\n";
    expect(parseAgentTemplateFile(content)).toBeNull();
  });

  it("parses max-turns as a number (asInteger coercion from frontmatter string)", () => {
    // The hand-rolled frontmatter parser stores all scalars as strings —
    // `50` becomes the string "50". `asInteger` coerces at projection
    // time. This test pins both halves of that contract.
    const content = ["---", "name: deep-research", "max-turns: 120", "---", "body."].join("\n");
    const parsed = parseAgentTemplateFile(content);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    expect(parsed.frontmatter.maxTurns).toBe(120);
    // Sanity-check the raw side still holds the original string —
    // future fields that want non-integer numeric forms can read raw
    // directly rather than going through asInteger.
    expect(parsed.frontmatter.raw["max-turns"]).toBe("120");
  });

  it("ignores invalid max-turns values (asInteger returns undefined for non-integer)", () => {
    // Floats, non-digit strings, and partial input all fall through to
    // undefined rather than coercing to NaN. The template still loads —
    // just without a maxTurns override — so a typo doesn't kill the
    // whole template.
    const cases = ["1.5", "fifty", "50abc", "", "-"];
    for (const value of cases) {
      const content = ["---", "name: edge-case", `max-turns: ${value}`, "---", "body."].join("\n");
      const parsed = parseAgentTemplateFile(content);
      expect(parsed).not.toBeNull();
      if (!parsed) return;
      expect(parsed.frontmatter.maxTurns).toBeUndefined();
    }
  });

  it("accepts allowed-tools in the block-list form (shared parser dialect)", () => {
    const content = [
      "---",
      "name: doc-updater",
      "allowed-tools:",
      "  - read_file",
      "  - write_file",
      "  - glob",
      "---",
      "body.",
    ].join("\n");
    const parsed = parseAgentTemplateFile(content);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    expect(parsed.frontmatter.allowedTools).toEqual(["read_file", "write_file", "glob"]);
  });

  it("preserves unknown frontmatter keys on `raw` for forward-compat", () => {
    const content = [
      "---",
      "name: future-template",
      "experimental-knob: rollout-v2",
      "---",
      "body.",
    ].join("\n");
    const parsed = parseAgentTemplateFile(content);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    expect(parsed.frontmatter.raw["experimental-knob"]).toBe("rollout-v2");
  });

  it("leaves model as a loose string — validation happens at spawn_worker, not load", () => {
    // The loader stays loose so a typo'd model slug surfaces a clear
    // error at spawn_worker time (Zod enum rejection) rather than
    // silently dropping the template. Re-asserting the design choice
    // so a future "let's validate at load" refactor trips this test.
    const content = ["---", "name: t", "model: deepseek-v4-nonexistent", "---", "body."].join("\n");
    const parsed = parseAgentTemplateFile(content);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    expect(parsed.frontmatter.model).toBe("deepseek-v4-nonexistent");
  });
});

// ---------------------------------------------------------------------------
// loadAllAgentTemplates — disk discovery
// ---------------------------------------------------------------------------

describe("loadAllAgentTemplates", () => {
  let tmpRoot: string;
  let projectDir: string;
  let userHome: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aris-agents-"));
    projectDir = path.join(tmpRoot, "project");
    userHome = path.join(tmpRoot, "home");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(userHome, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  const writeTemplate = async (base: string, name: string, content: string): Promise<string> => {
    const dir = path.join(base, ".aris", "agents", name);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "AGENT.md");
    await fs.writeFile(filePath, content);
    return filePath;
  };

  const opts = (extra?: Partial<LoadAgentTemplatesOptions>): LoadAgentTemplatesOptions => ({
    workspaceRoot: projectDir,
    userHome,
    ...extra,
  });

  it("returns empty when no .aris/agents exists in either root", async () => {
    const result = await loadAllAgentTemplates(opts());
    expect(result.templates).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("discovers project templates", async () => {
    await writeTemplate(
      projectDir,
      "code-reviewer",
      "---\nname: code-reviewer\nmodel: deepseek-v4-pro\n---\n\nReview body.",
    );
    await writeTemplate(
      projectDir,
      "doc-updater",
      "---\nname: doc-updater\nmodel: deepseek-v4-flash\n---\n\nDocs body.",
    );
    const result = await loadAllAgentTemplates(opts());
    expect(result.errors).toEqual([]);
    expect(result.templates.map((t) => ({ name: t.name, source: t.source }))).toEqual([
      { name: "code-reviewer", source: "project" },
      { name: "doc-updater", source: "project" },
    ]);
  });

  it("discovers user templates", async () => {
    await writeTemplate(userHome, "planner", "---\nname: planner\neffort: max\n---\n\nPlan body.");
    const result = await loadAllAgentTemplates(opts());
    expect(result.errors).toEqual([]);
    expect(result.templates).toHaveLength(1);
    expect(result.templates[0]?.name).toBe("planner");
    expect(result.templates[0]?.source).toBe("user");
    expect(result.templates[0]?.frontmatter.effort).toBe("max");
  });

  it("project template wins when both roots define the same name", async () => {
    await writeTemplate(
      projectDir,
      "code-reviewer",
      "---\nname: code-reviewer\ndescription: project-version\n---\n\nProject body.",
    );
    await writeTemplate(
      userHome,
      "code-reviewer",
      "---\nname: code-reviewer\ndescription: user-version\n---\n\nUser body.",
    );
    const result = await loadAllAgentTemplates(opts());
    expect(result.errors).toEqual([]);
    expect(result.templates).toHaveLength(1);
    const template = result.templates[0]!;
    expect(template.source).toBe("project");
    expect(template.frontmatter.description).toBe("project-version");
    expect(template.body).toBe("Project body.");
  });

  it("falls back to the directory name when frontmatter has no `name:`", async () => {
    await writeTemplate(projectDir, "no-name-here", "Just a body, no frontmatter.");
    const result = await loadAllAgentTemplates(opts());
    expect(result.templates).toHaveLength(1);
    expect(result.templates[0]?.name).toBe("no-name-here");
  });

  it("skips a directory that doesn't contain AGENT.md", async () => {
    const orphanDir = path.join(projectDir, ".aris", "agents", "empty-dir");
    await fs.mkdir(orphanDir, { recursive: true });
    const result = await loadAllAgentTemplates(opts());
    expect(result.templates).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("reports a per-file error when frontmatter is malformed but doesn't block siblings", async () => {
    await writeTemplate(projectDir, "good", "---\nname: good\n---\n\nBody.");
    await writeTemplate(projectDir, "broken", "---\nname: broken\n(no closing delim)");
    const result = await loadAllAgentTemplates(opts());
    expect(result.templates).toHaveLength(1);
    expect(result.templates[0]?.name).toBe("good");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toMatch(/never closed/);
    expect(result.errors[0]?.source).toBe("project");
  });

  it("skips user-scope discovery when userHome is null", async () => {
    await writeTemplate(
      userHome,
      "planner",
      "---\nname: planner\n---\n\nWould be loaded if userHome wasn't null.",
    );
    const result = await loadAllAgentTemplates({
      workspaceRoot: projectDir,
      userHome: null,
    });
    expect(result.templates).toEqual([]);
  });

  it("skips project-scope discovery when workspaceRoot is undefined", async () => {
    await writeTemplate(userHome, "planner", "---\nname: planner\n---\n\nLoaded.");
    await writeTemplate(
      projectDir,
      "code-reviewer",
      "---\nname: code-reviewer\n---\n\nNot loaded — workspaceRoot is undefined.",
    );
    const result = await loadAllAgentTemplates({
      workspaceRoot: undefined,
      userHome,
    });
    expect(result.templates.map((t) => t.name)).toEqual(["planner"]);
  });

  // ── Bundled templates — lowest precedence ───────────────────────

  it("merges bundled templates at the lowest precedence", async () => {
    await writeTemplate(
      projectDir,
      "code-reviewer",
      "---\nname: code-reviewer\n---\n\nProject reviewer.",
    );
    const result = await loadAllAgentTemplates({
      workspaceRoot: projectDir,
      userHome,
      bundledTemplates: [
        bundledTemplate("code-reviewer", "Bundled reviewer — should be overridden."),
        bundledTemplate("starter-planner", "Bundled planner body."),
      ],
    });
    // Project code-reviewer wins; bundled code-reviewer is dropped;
    // bundled starter-planner surfaces because nobody else claimed
    // that name.
    expect(result.templates.map((t) => ({ name: t.name, source: t.source }))).toEqual([
      { name: "code-reviewer", source: "project" },
      { name: "starter-planner", source: "bundled" },
    ]);
    const reviewer = result.templates.find((t) => t.name === "code-reviewer")!;
    expect(reviewer.body).toBe("Project reviewer.");
  });

  it("user can override bundled even when project doesn't claim the name", async () => {
    await writeTemplate(
      userHome,
      "starter-planner",
      "---\nname: starter-planner\n---\n\nUser planner.",
    );
    const result = await loadAllAgentTemplates({
      workspaceRoot: projectDir,
      userHome,
      bundledTemplates: [bundledTemplate("starter-planner", "Bundled fallback.")],
    });
    expect(result.templates).toHaveLength(1);
    expect(result.templates[0]?.source).toBe("user");
    expect(result.templates[0]?.body).toBe("User planner.");
  });

  it("bundled templates surface when project and user are absent / empty", async () => {
    const result = await loadAllAgentTemplates({
      workspaceRoot: projectDir,
      userHome,
      bundledTemplates: [bundledTemplate("baseline-reviewer", "Bundled baseline body.")],
    });
    expect(result.templates.map((t) => t.name)).toEqual(["baseline-reviewer"]);
    expect(result.templates[0]?.source).toBe("bundled");
  });

  it("an empty bundledTemplates list (or undefined) is a no-op", async () => {
    const result = await loadAllAgentTemplates({
      workspaceRoot: projectDir,
      userHome,
      bundledTemplates: [],
    });
    expect(result.templates).toEqual([]);
    const result2 = await loadAllAgentTemplates({
      workspaceRoot: projectDir,
      userHome,
    });
    expect(result2.templates).toEqual([]);
  });
});
