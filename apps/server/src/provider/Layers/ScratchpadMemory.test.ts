/**
 * ScratchpadMemory tests.
 *
 * The module owns three responsibilities:
 *   1. Path math — `getScratchpadPath` produces a stable per-project path.
 *   2. IO — append-only writes and full-file reads.
 *   3. Replay — pure transformation from records → current state.
 *
 * Replay is the most testable surface (no fs), so it gets the most
 * coverage. IO and round-trip tests use a per-test temp HOME so the
 * real `~/.aris/` is never touched.
 */
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendScratchpadRecord,
  getScratchpadPath,
  newScratchpadRecord,
  readScratchpad,
  readScratchpadRecords,
  replayScratchpad,
  type ScratchpadRecord,
} from "./ScratchpadMemory.ts";

const SAMPLE_CWD = "/Users/test/Projects/sample-app";

describe("replayScratchpad", () => {
  it("returns empty string for an empty record array", () => {
    expect(replayScratchpad([])).toBe("");
  });

  it("set replaces prior state", () => {
    const records: ScratchpadRecord[] = [
      { id: "1", ts: "t1", action: "set", content: "first" },
      { id: "2", ts: "t2", action: "set", content: "second" },
    ];
    expect(replayScratchpad(records)).toBe("second");
  });

  it("append concatenates with a newline separator", () => {
    const records: ScratchpadRecord[] = [
      { id: "1", ts: "t1", action: "set", content: "line one" },
      { id: "2", ts: "t2", action: "append", content: "line two" },
      { id: "3", ts: "t3", action: "append", content: "line three" },
    ];
    expect(replayScratchpad(records)).toBe("line one\nline two\nline three");
  });

  it("append on empty state becomes the content (no leading newline)", () => {
    const records: ScratchpadRecord[] = [
      { id: "1", ts: "t1", action: "append", content: "kicks off the buffer" },
    ];
    expect(replayScratchpad(records)).toBe("kicks off the buffer");
  });

  it("clear resets state to empty string", () => {
    const records: ScratchpadRecord[] = [
      { id: "1", ts: "t1", action: "set", content: "filled" },
      { id: "2", ts: "t2", action: "clear" },
    ];
    expect(replayScratchpad(records)).toBe("");
  });

  it("set after clear starts a fresh buffer", () => {
    const records: ScratchpadRecord[] = [
      { id: "1", ts: "t1", action: "set", content: "old" },
      { id: "2", ts: "t2", action: "clear" },
      { id: "3", ts: "t3", action: "set", content: "new" },
    ];
    expect(replayScratchpad(records)).toBe("new");
  });

  it("append after clear starts a fresh buffer (no orphan newline)", () => {
    const records: ScratchpadRecord[] = [
      { id: "1", ts: "t1", action: "set", content: "old" },
      { id: "2", ts: "t2", action: "clear" },
      { id: "3", ts: "t3", action: "append", content: "new" },
    ];
    expect(replayScratchpad(records)).toBe("new");
  });
});

describe("newScratchpadRecord", () => {
  it("stamps id and ts on every record", () => {
    const r = newScratchpadRecord({ action: "set", content: "x" });
    expect(r.id).toMatch(/[0-9a-f-]{36}/);
    expect(r.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("preserves action and content for set", () => {
    const r = newScratchpadRecord({ action: "set", content: "hello" });
    expect(r.action).toBe("set");
    if (r.action === "set") expect(r.content).toBe("hello");
  });

  it("preserves action and content for append", () => {
    const r = newScratchpadRecord({ action: "append", content: "world" });
    expect(r.action).toBe("append");
    if (r.action === "append") expect(r.content).toBe("world");
  });

  it("clear records carry no content field", () => {
    const r = newScratchpadRecord({ action: "clear" });
    expect(r.action).toBe("clear");
    expect("content" in r).toBe(false);
  });
});

describe("getScratchpadPath", () => {
  it("derives a stable, per-project path under ~/.aris/projects/", () => {
    const p = getScratchpadPath("/Users/k/Projects/foo");
    expect(p).toMatch(/\.aris\/projects\/users__k__projects__foo\/scratchpad\.jsonl$/);
  });

  it("normalizes case so two cwds with different case yield the same path", () => {
    const a = getScratchpadPath("/Users/K/Projects/Foo");
    const b = getScratchpadPath("/users/k/projects/foo");
    expect(a).toBe(b);
  });
});

describe("ScratchpadMemory IO (round-trip)", () => {
  let originalHome: string | undefined;
  let tempHome: string;

  beforeEach(async () => {
    // Redirect HOME to a temp dir so we never touch the real ~/.aris/.
    originalHome = process.env["HOME"];
    tempHome = await fs.mkdtemp(join(tmpdir(), "scratchpad-test-"));
    process.env["HOME"] = tempHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it("readScratchpad returns empty string when no file exists yet", async () => {
    expect(await readScratchpad(SAMPLE_CWD)).toBe("");
    expect(await readScratchpadRecords(SAMPLE_CWD)).toEqual([]);
  });

  it("appendScratchpadRecord then readScratchpad round-trips a single set", async () => {
    await appendScratchpadRecord(SAMPLE_CWD, newScratchpadRecord({ action: "set", content: "hi" }));
    expect(await readScratchpad(SAMPLE_CWD)).toBe("hi");
  });

  it("multiple appends in sequence concatenate with newlines on read", async () => {
    await appendScratchpadRecord(SAMPLE_CWD, newScratchpadRecord({ action: "set", content: "a" }));
    await appendScratchpadRecord(
      SAMPLE_CWD,
      newScratchpadRecord({ action: "append", content: "b" }),
    );
    await appendScratchpadRecord(
      SAMPLE_CWD,
      newScratchpadRecord({ action: "append", content: "c" }),
    );
    expect(await readScratchpad(SAMPLE_CWD)).toBe("a\nb\nc");
  });

  it("clear written to disk shows as empty on next read", async () => {
    await appendScratchpadRecord(SAMPLE_CWD, newScratchpadRecord({ action: "set", content: "x" }));
    await appendScratchpadRecord(SAMPLE_CWD, newScratchpadRecord({ action: "clear" }));
    expect(await readScratchpad(SAMPLE_CWD)).toBe("");
  });

  it("readScratchpadRecords preserves file order", async () => {
    const first = newScratchpadRecord({ action: "set", content: "first" });
    const second = newScratchpadRecord({ action: "append", content: "second" });
    await appendScratchpadRecord(SAMPLE_CWD, first);
    await appendScratchpadRecord(SAMPLE_CWD, second);
    const out = await readScratchpadRecords(SAMPLE_CWD);
    expect(out).toHaveLength(2);
    expect(out[0]?.id).toBe(first.id);
    expect(out[1]?.id).toBe(second.id);
  });

  it("corrupt lines are dropped, valid lines around them survive", async () => {
    // Write a valid record first via the public API so the file exists.
    await appendScratchpadRecord(SAMPLE_CWD, newScratchpadRecord({ action: "set", content: "ok" }));
    // Now hand-poke a bad line and another good line directly.
    const path = getScratchpadPath(SAMPLE_CWD);
    await fs.appendFile(path, "this is not json\n");
    await appendScratchpadRecord(
      SAMPLE_CWD,
      newScratchpadRecord({ action: "append", content: "still here" }),
    );
    expect(await readScratchpad(SAMPLE_CWD)).toBe("ok\nstill here");
  });
});
