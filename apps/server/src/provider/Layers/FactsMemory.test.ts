/**
 * FactsMemory tests.
 *
 * Same coverage shape as ScratchpadMemory.test.ts and
 * TodosMemory.test.ts:
 *   1. Pure replay rules (no fs, fast, deterministic).
 *   2. Render output format (grouping, separator handling).
 *   3. IO round-trip with a temp-dir FactsConfig so the real
 *      ~/.aris/ is never touched.
 *   4. Concurrency — concurrent upserts under withFactsWriteLock.
 *
 * Slice F.3 — No more HOME swapping. Each IO `describe` block
 * constructs a `FactsConfig` from a temp dir via `makeFactsConfig`
 * and passes it explicitly. If a test runner skips `beforeEach`, the
 * only consequence is an unused temp dir — the real facts file is
 * never resolved.
 */
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendFactsRecord,
  makeFactsConfig,
  newFactsRecord,
  readFacts,
  readFactsRecords,
  renderFacts,
  replayFacts,
  withFactsWriteLock,
  type Fact,
  type FactsConfig,
  type FactsRecord,
} from "./FactsMemory.ts";

describe("replayFacts", () => {
  it("returns empty array for an empty record stream", () => {
    expect(replayFacts([])).toEqual([]);
  });

  it("upsert sets a fact at (factType, label)", () => {
    const records: FactsRecord[] = [
      {
        id: "r1",
        ts: "t1",
        action: "upsert",
        factType: "user",
        label: "name",
        description: "User's preferred name",
        content: "Kenny",
      },
    ];
    expect(replayFacts(records)).toEqual([
      {
        factType: "user",
        label: "name",
        description: "User's preferred name",
        content: "Kenny",
      },
    ]);
  });

  it("upsert at an existing key overwrites description and content", () => {
    const records: FactsRecord[] = [
      {
        id: "r1",
        ts: "t1",
        action: "upsert",
        factType: "user",
        label: "name",
        description: "old",
        content: "old-value",
      },
      {
        id: "r2",
        ts: "t2",
        action: "upsert",
        factType: "user",
        label: "name",
        description: "new",
        content: "new-value",
      },
    ];
    expect(replayFacts(records)).toEqual([
      { factType: "user", label: "name", description: "new", content: "new-value" },
    ]);
  });

  it("delete removes the matching fact", () => {
    const records: FactsRecord[] = [
      {
        id: "r1",
        ts: "t1",
        action: "upsert",
        factType: "user",
        label: "a",
        description: "d",
        content: "c",
      },
      {
        id: "r2",
        ts: "t2",
        action: "upsert",
        factType: "user",
        label: "b",
        description: "d",
        content: "c",
      },
      { id: "r3", ts: "t3", action: "delete", factType: "user", label: "a" },
    ];
    expect(replayFacts(records)).toEqual([
      { factType: "user", label: "b", description: "d", content: "c" },
    ]);
  });

  it("delete on a missing key is a silent no-op", () => {
    const records: FactsRecord[] = [
      {
        id: "r1",
        ts: "t1",
        action: "upsert",
        factType: "user",
        label: "a",
        description: "d",
        content: "c",
      },
      { id: "r2", ts: "t2", action: "delete", factType: "user", label: "missing" },
    ];
    expect(replayFacts(records)).toEqual([
      { factType: "user", label: "a", description: "d", content: "c" },
    ]);
  });

  it("upsert after delete re-adds the fact", () => {
    const records: FactsRecord[] = [
      {
        id: "r1",
        ts: "t1",
        action: "upsert",
        factType: "user",
        label: "a",
        description: "d1",
        content: "c1",
      },
      { id: "r2", ts: "t2", action: "delete", factType: "user", label: "a" },
      {
        id: "r3",
        ts: "t3",
        action: "upsert",
        factType: "user",
        label: "a",
        description: "d2",
        content: "c2",
      },
    ];
    expect(replayFacts(records)).toEqual([
      { factType: "user", label: "a", description: "d2", content: "c2" },
    ]);
  });

  it("same label across different factTypes is treated as distinct facts", () => {
    const records: FactsRecord[] = [
      {
        id: "r1",
        ts: "t1",
        action: "upsert",
        factType: "user",
        label: "tone",
        description: "user-tone",
        content: "casual",
      },
      {
        id: "r2",
        ts: "t2",
        action: "upsert",
        factType: "feedback",
        label: "tone",
        description: "feedback-tone",
        content: "match user register",
      },
    ];
    const out = replayFacts(records);
    expect(out).toHaveLength(2);
    // Sort order: factType (feedback < user alphabetically), then label.
    expect(out[0]?.factType).toBe("feedback");
    expect(out[1]?.factType).toBe("user");
  });

  it("output is sorted (factType ASC, then label ASC) for deterministic rendering", () => {
    const records: FactsRecord[] = [
      {
        id: "r1",
        ts: "t1",
        action: "upsert",
        factType: "user",
        label: "z",
        description: "d",
        content: "c",
      },
      {
        id: "r2",
        ts: "t2",
        action: "upsert",
        factType: "feedback",
        label: "z",
        description: "d",
        content: "c",
      },
      {
        id: "r3",
        ts: "t3",
        action: "upsert",
        factType: "user",
        label: "a",
        description: "d",
        content: "c",
      },
      {
        id: "r4",
        ts: "t4",
        action: "upsert",
        factType: "feedback",
        label: "a",
        description: "d",
        content: "c",
      },
    ];
    const out = replayFacts(records);
    expect(out.map((f) => `${f.factType}:${f.label}`)).toEqual([
      "feedback:a",
      "feedback:z",
      "user:a",
      "user:z",
    ]);
  });
});

describe("renderFacts", () => {
  it("returns empty string for an empty list", () => {
    expect(renderFacts([])).toBe("");
  });

  it("groups by factType with `## user` then `## feedback` headers", () => {
    const facts: Fact[] = [
      { factType: "user", label: "name", description: "preferred name", content: "Kenny" },
      {
        factType: "feedback",
        label: "no_patches",
        description: "only architecturally correct fixes",
        content: "no patch / band-aid language",
      },
    ];
    const out = renderFacts(facts);
    expect(out).toContain("## user");
    expect(out).toContain("## feedback");
    expect(out.indexOf("## user")).toBeLessThan(out.indexOf("## feedback"));
  });

  it("uses `label — description` when content equals description (no duplication)", () => {
    const facts: Fact[] = [
      { factType: "user", label: "name", description: "Kenny", content: "Kenny" },
    ];
    expect(renderFacts(facts)).toBe("## user\n- name — Kenny");
  });

  it("uses `label — description | content` when content adds info", () => {
    const facts: Fact[] = [
      {
        factType: "feedback",
        label: "no_patches",
        description: "only architecturally correct fixes",
        content: "no patch/band-aid in proposals",
      },
    ];
    expect(renderFacts(facts)).toBe(
      "## feedback\n- no_patches — only architecturally correct fixes | no patch/band-aid in proposals",
    );
  });

  it("skips a group if it has no facts (single-type list)", () => {
    const facts: Fact[] = [{ factType: "user", label: "x", description: "y", content: "z" }];
    const out = renderFacts(facts);
    expect(out).toContain("## user");
    expect(out).not.toContain("## feedback");
  });
});

describe("newFactsRecord", () => {
  it("stamps id and ts on every record", () => {
    const r = newFactsRecord({
      action: "upsert",
      factType: "user",
      label: "x",
      description: "d",
      content: "c",
    });
    expect(r.id).toMatch(/[0-9a-f-]{36}/);
    expect(r.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("preserves payload for upsert", () => {
    const r = newFactsRecord({
      action: "upsert",
      factType: "feedback",
      label: "tone",
      description: "casual",
      content: "match register",
    });
    expect(r.action).toBe("upsert");
    if (r.action === "upsert") {
      expect(r.factType).toBe("feedback");
      expect(r.label).toBe("tone");
      expect(r.description).toBe("casual");
      expect(r.content).toBe("match register");
    }
  });

  it("preserves payload for delete (no description/content)", () => {
    const r = newFactsRecord({ action: "delete", factType: "user", label: "x" });
    expect(r.action).toBe("delete");
    if (r.action === "delete") {
      expect(r.factType).toBe("user");
      expect(r.label).toBe("x");
    }
    // No description/content on delete records.
    expect("description" in r).toBe(false);
    expect("content" in r).toBe(false);
  });
});

describe("makeFactsConfig", () => {
  it("derives a stable user-global path under ~/.aris/ (NOT under projects/)", () => {
    const cfg = makeFactsConfig("/home/testuser");
    expect(cfg.factsPath).toMatch(/\.aris\/facts\.jsonl$/);
    expect(cfg.factsPath).not.toContain("projects/");
    expect(cfg.arisHomeDir).toMatch(/\.aris$/);
  });

  it("falls back to real homedir() when no override is passed", () => {
    const cfg = makeFactsConfig();
    // The path should exist and contain .aris/ — even if the dir
    // doesn't exist yet, the path string should be well-formed.
    expect(cfg.factsPath).toContain(".aris");
    expect(cfg.arisHomeDir).toContain(".aris");
  });
});

describe("FactsMemory IO (round-trip)", () => {
  let tempHome: string;
  let config: FactsConfig;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(join(tmpdir(), "facts-test-"));
    config = makeFactsConfig(tempHome);
  });

  afterEach(async () => {
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it("readFacts returns empty array when no file exists yet", async () => {
    expect(await readFacts(config)).toEqual([]);
    expect(await readFactsRecords(config)).toEqual([]);
  });

  it("upsert then read round-trips a single fact", async () => {
    await appendFactsRecord(
      config,
      newFactsRecord({
        action: "upsert",
        factType: "user",
        label: "name",
        description: "preferred name",
        content: "Kenny",
      }),
    );
    expect(await readFacts(config)).toEqual([
      { factType: "user", label: "name", description: "preferred name", content: "Kenny" },
    ]);
  });

  it("upsert overwrites earlier upsert at the same key (round-trip)", async () => {
    await appendFactsRecord(
      config,
      newFactsRecord({
        action: "upsert",
        factType: "user",
        label: "name",
        description: "old",
        content: "old",
      }),
    );
    await appendFactsRecord(
      config,
      newFactsRecord({
        action: "upsert",
        factType: "user",
        label: "name",
        description: "new",
        content: "new",
      }),
    );
    expect(await readFacts(config)).toEqual([
      { factType: "user", label: "name", description: "new", content: "new" },
    ]);
  });

  it("delete written to disk removes the fact on next read", async () => {
    await appendFactsRecord(
      config,
      newFactsRecord({
        action: "upsert",
        factType: "user",
        label: "x",
        description: "d",
        content: "c",
      }),
    );
    await appendFactsRecord(
      config,
      newFactsRecord({ action: "delete", factType: "user", label: "x" }),
    );
    expect(await readFacts(config)).toEqual([]);
  });

  it("corrupt lines are dropped, valid lines around them survive", async () => {
    await appendFactsRecord(
      config,
      newFactsRecord({
        action: "upsert",
        factType: "user",
        label: "ok1",
        description: "d",
        content: "c",
      }),
    );
    await fs.appendFile(config.factsPath, "garbage not json\n");
    await appendFactsRecord(
      config,
      newFactsRecord({
        action: "upsert",
        factType: "user",
        label: "ok2",
        description: "d",
        content: "c",
      }),
    );
    const facts = await readFacts(config);
    expect(facts.map((f) => f.label).sort()).toEqual(["ok1", "ok2"]);
  });

  it("rejects invalid factType values during parse (`type=project` is dropped)", async () => {
    await fs.mkdir(config.arisHomeDir, { recursive: true });
    await fs.writeFile(
      config.factsPath,
      JSON.stringify({
        id: "r1",
        ts: "t1",
        action: "upsert",
        factType: "project",
        label: "entry",
        description: "d",
        content: "c",
      }) +
        "\n" +
        JSON.stringify({
          id: "r2",
          ts: "t2",
          action: "upsert",
          factType: "user",
          label: "name",
          description: "d",
          content: "Kenny",
        }) +
        "\n",
    );
    const facts = await readFacts(config);
    // The "project" record is dropped (invalid factType), only the
    // "user" record survives.
    expect(facts).toEqual([
      { factType: "user", label: "name", description: "d", content: "Kenny" },
    ]);
  });
});

describe("withFactsWriteLock — concurrent upsert path", () => {
  let tempHome: string;
  let config: FactsConfig;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(join(tmpdir(), "facts-lock-test-"));
    config = makeFactsConfig(tempHome);
  });

  afterEach(async () => {
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it("serializes concurrent upserts to distinct labels — all land", async () => {
    const labels = ["a", "b", "c", "d", "e"];
    await Promise.all(
      labels.map((label) =>
        withFactsWriteLock(config, async () => {
          await appendFactsRecord(
            config,
            newFactsRecord({
              action: "upsert",
              factType: "user",
              label,
              description: `desc-${label}`,
              content: `content-${label}`,
            }),
          );
        }),
      ),
    );
    const facts = await readFacts(config);
    expect(facts.map((f) => f.label).sort()).toEqual(labels);
  });

  it("a rejected write doesn't poison subsequent locked writes", async () => {
    const failing = withFactsWriteLock(config, async () => {
      throw new Error("boom");
    }).catch((e) => e);
    await failing;
    await withFactsWriteLock(config, async () => {
      await appendFactsRecord(
        config,
        newFactsRecord({
          action: "upsert",
          factType: "user",
          label: "after",
          description: "d",
          content: "c",
        }),
      );
    });
    const facts = await readFacts(config);
    expect(facts).toEqual([{ factType: "user", label: "after", description: "d", content: "c" }]);
  });
});
