/**
 * TodosMemory tests.
 *
 * Same coverage shape as ScratchpadMemory.test.ts:
 *   1. Pure replay rules (most coverage — no fs, fast, deterministic).
 *   2. `nextTodoId` allocation behavior across edge cases.
 *   3. `renderOpenTodos` output format.
 *   4. IO round-trip with a temp HOME so the real `~/.aris/` is never
 *      touched.
 */
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendTodosRecord,
  getTodosPath,
  newTodosRecord,
  nextTodoId,
  readTodos,
  readTodosRecords,
  renderOpenTodos,
  replayTodos,
  withTodosWriteLock,
  type Todo,
  type TodosRecord,
} from "./TodosMemory.ts";

const SAMPLE_CWD = "/Users/test/Projects/sample-todos";

describe("replayTodos", () => {
  it("returns empty array for an empty record stream", () => {
    expect(replayTodos([])).toEqual([]);
  });

  it("add appends a pending todo with the supplied id and text", () => {
    const records: TodosRecord[] = [
      { id: "r1", ts: "t1", action: "add", todoId: 1, text: "fix login" },
    ];
    expect(replayTodos(records)).toEqual([{ id: 1, text: "fix login", status: "pending" }]);
  });

  it("set_status patches the matching todo only", () => {
    const records: TodosRecord[] = [
      { id: "r1", ts: "t1", action: "add", todoId: 1, text: "a" },
      { id: "r2", ts: "t2", action: "add", todoId: 2, text: "b" },
      { id: "r3", ts: "t3", action: "set_status", todoId: 2, status: "in_progress" },
    ];
    expect(replayTodos(records)).toEqual([
      { id: 1, text: "a", status: "pending" },
      { id: 2, text: "b", status: "in_progress" },
    ]);
  });

  it("set_status on a missing todoId is a silent no-op", () => {
    const records: TodosRecord[] = [
      { id: "r1", ts: "t1", action: "add", todoId: 1, text: "a" },
      { id: "r2", ts: "t2", action: "set_status", todoId: 999, status: "completed" },
    ];
    expect(replayTodos(records)).toEqual([{ id: 1, text: "a", status: "pending" }]);
  });

  it("clear({ onlyCompleted: false }) wipes everything", () => {
    const records: TodosRecord[] = [
      { id: "r1", ts: "t1", action: "add", todoId: 1, text: "a" },
      { id: "r2", ts: "t2", action: "add", todoId: 2, text: "b" },
      { id: "r3", ts: "t3", action: "clear", onlyCompleted: false },
    ];
    expect(replayTodos(records)).toEqual([]);
  });

  it("clear({ onlyCompleted: true }) keeps open todos, drops completed", () => {
    const records: TodosRecord[] = [
      { id: "r1", ts: "t1", action: "add", todoId: 1, text: "open" },
      { id: "r2", ts: "t2", action: "add", todoId: 2, text: "done" },
      { id: "r3", ts: "t3", action: "set_status", todoId: 2, status: "completed" },
      { id: "r4", ts: "t4", action: "clear", onlyCompleted: true },
    ];
    expect(replayTodos(records)).toEqual([{ id: 1, text: "open", status: "pending" }]);
  });

  it("add with a duplicate todoId replaces the prior entry (defensive against hand-edits)", () => {
    const records: TodosRecord[] = [
      { id: "r1", ts: "t1", action: "add", todoId: 1, text: "old" },
      { id: "r2", ts: "t2", action: "set_status", todoId: 1, status: "in_progress" },
      { id: "r3", ts: "t3", action: "add", todoId: 1, text: "rewritten" },
    ];
    expect(replayTodos(records)).toEqual([{ id: 1, text: "rewritten", status: "pending" }]);
  });
});

describe("nextTodoId", () => {
  it("returns 1 for a fresh project", () => {
    expect(nextTodoId([])).toBe(1);
  });

  it("returns max(add.todoId) + 1 across the record stream", () => {
    const records: TodosRecord[] = [
      { id: "r1", ts: "t1", action: "add", todoId: 1, text: "a" },
      { id: "r2", ts: "t2", action: "add", todoId: 2, text: "b" },
      { id: "r3", ts: "t3", action: "add", todoId: 3, text: "c" },
    ];
    expect(nextTodoId(records)).toBe(4);
  });

  it("never recycles ids — clear all then add gets the next historical max + 1", () => {
    const records: TodosRecord[] = [
      { id: "r1", ts: "t1", action: "add", todoId: 1, text: "a" },
      { id: "r2", ts: "t2", action: "add", todoId: 2, text: "b" },
      { id: "r3", ts: "t3", action: "clear", onlyCompleted: false },
    ];
    expect(nextTodoId(records)).toBe(3);
  });

  it("ignores set_status and clear records when computing the max", () => {
    const records: TodosRecord[] = [
      { id: "r1", ts: "t1", action: "add", todoId: 5, text: "a" },
      { id: "r2", ts: "t2", action: "set_status", todoId: 5, status: "in_progress" },
      { id: "r3", ts: "t3", action: "clear", onlyCompleted: true },
    ];
    expect(nextTodoId(records)).toBe(6);
  });
});

describe("renderOpenTodos", () => {
  it("returns empty string when there are no todos at all", () => {
    expect(renderOpenTodos([])).toBe("");
  });

  it("returns empty string when every todo is completed (filtered out)", () => {
    const todos: Todo[] = [
      { id: 1, text: "a", status: "completed" },
      { id: 2, text: "b", status: "completed" },
    ];
    expect(renderOpenTodos(todos)).toBe("");
  });

  it("formats each open todo as `[id] [status] text` on its own line", () => {
    const todos: Todo[] = [
      { id: 1, text: "fix login", status: "pending" },
      { id: 2, text: "refactor auth", status: "in_progress" },
    ];
    expect(renderOpenTodos(todos)).toBe("[1] [pending] fix login\n[2] [in_progress] refactor auth");
  });

  it("hides completed todos but preserves pending + in_progress", () => {
    const todos: Todo[] = [
      { id: 1, text: "still open", status: "pending" },
      { id: 2, text: "in flight", status: "in_progress" },
      { id: 3, text: "done", status: "completed" },
    ];
    expect(renderOpenTodos(todos)).toBe("[1] [pending] still open\n[2] [in_progress] in flight");
  });
});

describe("newTodosRecord", () => {
  it("stamps id and ts on every record", () => {
    const r = newTodosRecord({ action: "add", todoId: 1, text: "x" });
    expect(r.id).toMatch(/[0-9a-f-]{36}/);
    expect(r.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("preserves payload for add", () => {
    const r = newTodosRecord({ action: "add", todoId: 7, text: "lunch" });
    expect(r.action).toBe("add");
    if (r.action === "add") {
      expect(r.todoId).toBe(7);
      expect(r.text).toBe("lunch");
    }
  });

  it("preserves payload for set_status", () => {
    const r = newTodosRecord({ action: "set_status", todoId: 3, status: "completed" });
    expect(r.action).toBe("set_status");
    if (r.action === "set_status") {
      expect(r.todoId).toBe(3);
      expect(r.status).toBe("completed");
    }
  });

  it("preserves payload for clear", () => {
    const r = newTodosRecord({ action: "clear", onlyCompleted: true });
    expect(r.action).toBe("clear");
    if (r.action === "clear") expect(r.onlyCompleted).toBe(true);
  });
});

describe("getTodosPath", () => {
  it("derives a stable per-project path under ~/.aris/projects/", () => {
    const p = getTodosPath("/Users/k/Projects/foo");
    expect(p).toMatch(/\.aris\/projects\/users__k__projects__foo\/todos\.jsonl$/);
  });
});

describe("TodosMemory IO (round-trip)", () => {
  let originalHome: string | undefined;
  let tempHome: string;

  beforeEach(async () => {
    originalHome = process.env["HOME"];
    tempHome = await fs.mkdtemp(join(tmpdir(), "todos-test-"));
    process.env["HOME"] = tempHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it("readTodos returns empty array when no file exists yet", async () => {
    expect(await readTodos(SAMPLE_CWD)).toEqual([]);
    expect(await readTodosRecords(SAMPLE_CWD)).toEqual([]);
  });

  it("add then read round-trips a single pending todo", async () => {
    await appendTodosRecord(SAMPLE_CWD, newTodosRecord({ action: "add", todoId: 1, text: "test" }));
    const todos = await readTodos(SAMPLE_CWD);
    expect(todos).toEqual([{ id: 1, text: "test", status: "pending" }]);
  });

  it("status transitions persist across reads", async () => {
    await appendTodosRecord(SAMPLE_CWD, newTodosRecord({ action: "add", todoId: 1, text: "x" }));
    await appendTodosRecord(
      SAMPLE_CWD,
      newTodosRecord({ action: "set_status", todoId: 1, status: "in_progress" }),
    );
    await appendTodosRecord(
      SAMPLE_CWD,
      newTodosRecord({ action: "set_status", todoId: 1, status: "completed" }),
    );
    expect(await readTodos(SAMPLE_CWD)).toEqual([{ id: 1, text: "x", status: "completed" }]);
  });

  it("clear({ onlyCompleted: true }) survives a round-trip", async () => {
    await appendTodosRecord(SAMPLE_CWD, newTodosRecord({ action: "add", todoId: 1, text: "open" }));
    await appendTodosRecord(SAMPLE_CWD, newTodosRecord({ action: "add", todoId: 2, text: "done" }));
    await appendTodosRecord(
      SAMPLE_CWD,
      newTodosRecord({ action: "set_status", todoId: 2, status: "completed" }),
    );
    await appendTodosRecord(SAMPLE_CWD, newTodosRecord({ action: "clear", onlyCompleted: true }));
    expect(await readTodos(SAMPLE_CWD)).toEqual([{ id: 1, text: "open", status: "pending" }]);
  });

  it("nextTodoId reflects the on-disk record stream", async () => {
    await appendTodosRecord(SAMPLE_CWD, newTodosRecord({ action: "add", todoId: 1, text: "a" }));
    await appendTodosRecord(SAMPLE_CWD, newTodosRecord({ action: "add", todoId: 2, text: "b" }));
    const records = await readTodosRecords(SAMPLE_CWD);
    expect(nextTodoId(records)).toBe(3);
  });

  it("corrupt lines are dropped, valid lines around them survive", async () => {
    await appendTodosRecord(SAMPLE_CWD, newTodosRecord({ action: "add", todoId: 1, text: "ok" }));
    const path = getTodosPath(SAMPLE_CWD);
    await fs.appendFile(path, "garbage not json\n");
    await appendTodosRecord(
      SAMPLE_CWD,
      newTodosRecord({ action: "add", todoId: 2, text: "still here" }),
    );
    expect(await readTodos(SAMPLE_CWD)).toEqual([
      { id: 1, text: "ok", status: "pending" },
      { id: 2, text: "still here", status: "pending" },
    ]);
  });
});

describe("withTodosWriteLock — concurrent add path", () => {
  let originalHome: string | undefined;
  let tempHome: string;

  beforeEach(async () => {
    originalHome = process.env["HOME"];
    tempHome = await fs.mkdtemp(join(tmpdir(), "todos-lock-test-"));
    process.env["HOME"] = tempHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  // Regression: the OpenAI Agents SDK fires concurrent tool calls when
  // the model emits multiple in one turn. Without a per-project lock,
  // N parallel adds all read the same prior records, all compute the
  // same `nextTodoId`, and all write duplicate todoIds — replay then
  // collapses to a single todo. With the lock, each add sees the
  // prior add's appended record and gets a fresh monotonic id.
  it("serializes 7 parallel adds so each gets a distinct monotonic todoId", async () => {
    const texts = ["a", "b", "c", "d", "e", "f", "g"];
    const addOne = (text: string) =>
      withTodosWriteLock(SAMPLE_CWD, async () => {
        const records = await readTodosRecords(SAMPLE_CWD);
        const newId = nextTodoId(records);
        await appendTodosRecord(SAMPLE_CWD, newTodosRecord({ action: "add", todoId: newId, text }));
        return newId;
      });
    const ids = await Promise.all(texts.map(addOne));
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const todos = await readTodos(SAMPLE_CWD);
    expect(todos).toHaveLength(7);
    expect(todos.map((t) => t.text)).toEqual(texts);
  });

  it("different projects don't block each other (independent locks)", async () => {
    const cwdA = "/Users/test/Projects/proj-a";
    const cwdB = "/Users/test/Projects/proj-b";
    // Interleave adds across two projects; each should get id 1
    // (independent histories, independent locks).
    const [idA1, idB1, idA2, idB2] = await Promise.all([
      withTodosWriteLock(cwdA, async () => {
        const records = await readTodosRecords(cwdA);
        const id = nextTodoId(records);
        await appendTodosRecord(cwdA, newTodosRecord({ action: "add", todoId: id, text: "A1" }));
        return id;
      }),
      withTodosWriteLock(cwdB, async () => {
        const records = await readTodosRecords(cwdB);
        const id = nextTodoId(records);
        await appendTodosRecord(cwdB, newTodosRecord({ action: "add", todoId: id, text: "B1" }));
        return id;
      }),
      withTodosWriteLock(cwdA, async () => {
        const records = await readTodosRecords(cwdA);
        const id = nextTodoId(records);
        await appendTodosRecord(cwdA, newTodosRecord({ action: "add", todoId: id, text: "A2" }));
        return id;
      }),
      withTodosWriteLock(cwdB, async () => {
        const records = await readTodosRecords(cwdB);
        const id = nextTodoId(records);
        await appendTodosRecord(cwdB, newTodosRecord({ action: "add", todoId: id, text: "B2" }));
        return id;
      }),
    ]);
    expect(idA1).toBe(1);
    expect(idA2).toBe(2);
    expect(idB1).toBe(1);
    expect(idB2).toBe(2);
    expect(await readTodos(cwdA)).toEqual([
      { id: 1, text: "A1", status: "pending" },
      { id: 2, text: "A2", status: "pending" },
    ]);
    expect(await readTodos(cwdB)).toEqual([
      { id: 1, text: "B1", status: "pending" },
      { id: 2, text: "B2", status: "pending" },
    ]);
  });

  it("a rejected write doesn't poison subsequent locked writes for the same project", async () => {
    const failing = withTodosWriteLock(SAMPLE_CWD, async () => {
      throw new Error("boom");
    }).catch((e) => e); // swallow so the test doesn't fail on this rejection itself
    await failing;
    // Next call should still proceed and get id 1 from a clean state.
    const id = await withTodosWriteLock(SAMPLE_CWD, async () => {
      const records = await readTodosRecords(SAMPLE_CWD);
      const newId = nextTodoId(records);
      await appendTodosRecord(
        SAMPLE_CWD,
        newTodosRecord({ action: "add", todoId: newId, text: "after-failure" }),
      );
      return newId;
    });
    expect(id).toBe(1);
    expect(await readTodos(SAMPLE_CWD)).toEqual([
      { id: 1, text: "after-failure", status: "pending" },
    ]);
  });
});
