/**
 * HookBus tests — pure unit tests against the bus, no adapter wiring.
 *
 * Coverage:
 *   1.  register + count per event
 *   2.  clear() empties every event
 *   3.  Dispatch ordering — ascending priority across all events
 *   4.  Fire-and-forget error isolation (Stop / PostToolUse /
 *       SessionEnd / SubagentStop / Notification)
 *   5.  PreToolUse first-deny short-circuit
 *   6.  PreToolUse all-allow returns allow:true
 *   7.  PreToolUse handler throw fails CLOSED with reason
 *   8.  PreToolUse with no hooks registered returns allow:true
 *   9.  SessionStart inject aggregation in priority order
 *  10.  SessionStart no-inject hooks return undefined
 *  11.  SessionStart throwing handler skipped, siblings preserved
 *  12.  Empty registry no-ops resolve cleanly
 *  13.  Sync and async handler signatures both work
 */
import { describe, expect, it } from "vitest";

import { makeHookBus } from "./HookBus.ts";

describe("HookBus — register + count", () => {
  it("starts empty for every event", () => {
    const bus = makeHookBus();
    expect(bus.count("PreToolUse")).toBe(0);
    expect(bus.count("PostToolUse")).toBe(0);
    expect(bus.count("Stop")).toBe(0);
    expect(bus.count("SessionStart")).toBe(0);
    expect(bus.count("SessionEnd")).toBe(0);
    expect(bus.count("SubagentStop")).toBe(0);
    expect(bus.count("Notification")).toBe(0);
  });

  it("count reflects registered handlers per event", () => {
    const bus = makeHookBus();
    bus.register({ event: "Stop", name: "a", handler: () => undefined });
    bus.register({ event: "Stop", name: "b", handler: () => undefined });
    bus.register({ event: "SessionStart", name: "c", handler: () => ({}) });
    expect(bus.count("Stop")).toBe(2);
    expect(bus.count("SessionStart")).toBe(1);
    expect(bus.count("PostToolUse")).toBe(0);
  });

  it("clear() empties every event", () => {
    const bus = makeHookBus();
    bus.register({ event: "Stop", name: "a", handler: () => undefined });
    bus.register({ event: "PreToolUse", name: "b", handler: () => ({ allow: true }) });
    bus.clear();
    expect(bus.count("Stop")).toBe(0);
    expect(bus.count("PreToolUse")).toBe(0);
  });
});

describe("HookBus — dispatch ordering", () => {
  it("dispatches Stop handlers in ascending priority order", async () => {
    const bus = makeHookBus();
    const order: string[] = [];
    bus.register({
      event: "Stop",
      name: "high-priority",
      priority: 10,
      handler: () => {
        order.push("high");
      },
    });
    bus.register({
      event: "Stop",
      name: "low-priority",
      priority: 200,
      handler: () => {
        order.push("low");
      },
    });
    bus.register({
      event: "Stop",
      name: "default-priority",
      handler: () => {
        order.push("default");
      },
    });
    await bus.dispatchStop({ event: "Stop", threadId: "t1", cwd: undefined, turnIndex: 0 });
    // priority 10 → default 100 → priority 200
    expect(order).toEqual(["high", "default", "low"]);
  });

  it("dispatches PostToolUse handlers in ascending priority order", async () => {
    const bus = makeHookBus();
    const order: number[] = [];
    bus.register({
      event: "PostToolUse",
      name: "third",
      priority: 300,
      handler: () => {
        order.push(3);
      },
    });
    bus.register({
      event: "PostToolUse",
      name: "first",
      priority: 100,
      handler: () => {
        order.push(1);
      },
    });
    bus.register({
      event: "PostToolUse",
      name: "second",
      priority: 200,
      handler: () => {
        order.push(2);
      },
    });
    await bus.dispatchPostToolUse({
      event: "PostToolUse",
      threadId: "t1",
      cwd: undefined,
      toolName: "Edit",
      args: {},
      result: {},
    });
    expect(order).toEqual([1, 2, 3]);
  });
});

describe("HookBus — fire-and-forget error isolation", () => {
  it("Stop handler throw does NOT block subsequent handlers", async () => {
    const bus = makeHookBus();
    const fired: string[] = [];
    bus.register({
      event: "Stop",
      name: "throws",
      priority: 10,
      handler: () => {
        throw new Error("boom");
      },
    });
    bus.register({
      event: "Stop",
      name: "still-fires",
      priority: 20,
      handler: () => {
        fired.push("ok");
      },
    });
    await bus.dispatchStop({ event: "Stop", threadId: "t1", cwd: undefined, turnIndex: 0 });
    expect(fired).toEqual(["ok"]);
  });

  it("PostToolUse async handler throw does NOT block subsequent handlers", async () => {
    const bus = makeHookBus();
    const fired: string[] = [];
    bus.register({
      event: "PostToolUse",
      name: "async-throws",
      priority: 10,
      handler: async () => {
        await Promise.resolve();
        throw new Error("async boom");
      },
    });
    bus.register({
      event: "PostToolUse",
      name: "still-fires",
      priority: 20,
      handler: () => {
        fired.push("ok");
      },
    });
    await bus.dispatchPostToolUse({
      event: "PostToolUse",
      threadId: "t1",
      cwd: undefined,
      toolName: "Edit",
      args: {},
      result: {},
    });
    expect(fired).toEqual(["ok"]);
  });

  it("SessionEnd handler throw does NOT block subsequent handlers", async () => {
    const bus = makeHookBus();
    const fired: string[] = [];
    bus.register({
      event: "SessionEnd",
      name: "throws",
      priority: 10,
      handler: () => {
        throw new Error("end boom");
      },
    });
    bus.register({
      event: "SessionEnd",
      name: "still-fires",
      priority: 20,
      handler: () => {
        fired.push("ok");
      },
    });
    await bus.dispatchSessionEnd({
      event: "SessionEnd",
      threadId: "t1",
      cwd: undefined,
      reason: "user_closed",
    });
    expect(fired).toEqual(["ok"]);
  });

  it("Notification handler throw does NOT block subsequent handlers", async () => {
    const bus = makeHookBus();
    const fired: string[] = [];
    bus.register({
      event: "Notification",
      name: "throws",
      priority: 10,
      handler: () => {
        throw new Error("notif boom");
      },
    });
    bus.register({
      event: "Notification",
      name: "still-fires",
      priority: 20,
      handler: () => {
        fired.push("ok");
      },
    });
    await bus.dispatchNotification({ event: "Notification", kind: "test", payload: {} });
    expect(fired).toEqual(["ok"]);
  });

  it("SubagentStop handler throw does NOT block subsequent handlers", async () => {
    const bus = makeHookBus();
    const fired: string[] = [];
    bus.register({
      event: "SubagentStop",
      name: "throws",
      priority: 10,
      handler: () => {
        throw new Error("subagent boom");
      },
    });
    bus.register({
      event: "SubagentStop",
      name: "still-fires",
      priority: 20,
      handler: () => {
        fired.push("ok");
      },
    });
    await bus.dispatchSubagentStop({
      event: "SubagentStop",
      parentThreadId: "parent",
      workerId: "w-1",
      result: undefined,
    });
    expect(fired).toEqual(["ok"]);
  });
});

describe("HookBus — PreToolUse veto behavior", () => {
  it("first allow:false short-circuits remaining handlers", async () => {
    const bus = makeHookBus();
    const ran: string[] = [];
    bus.register({
      event: "PreToolUse",
      name: "ok-1",
      priority: 10,
      handler: () => {
        ran.push("ok-1");
        return { allow: true };
      },
    });
    bus.register({
      event: "PreToolUse",
      name: "deny",
      priority: 20,
      handler: () => {
        ran.push("deny");
        return { allow: false, reason: "test-block" };
      },
    });
    bus.register({
      event: "PreToolUse",
      name: "ok-2-should-not-run",
      priority: 30,
      handler: () => {
        ran.push("ok-2");
        return { allow: true };
      },
    });
    const result = await bus.dispatchPreToolUse({
      event: "PreToolUse",
      threadId: "t1",
      cwd: undefined,
      toolName: "Bash",
      args: {},
    });
    expect(result).toEqual({ allow: false, reason: "test-block" });
    // ok-2 must never have run — short-circuit on first deny
    expect(ran).toEqual(["ok-1", "deny"]);
  });

  it("all allow:true returns allow:true", async () => {
    const bus = makeHookBus();
    bus.register({
      event: "PreToolUse",
      name: "ok-a",
      handler: () => ({ allow: true }),
    });
    bus.register({
      event: "PreToolUse",
      name: "ok-b",
      handler: () => ({ allow: true }),
    });
    const result = await bus.dispatchPreToolUse({
      event: "PreToolUse",
      threadId: "t1",
      cwd: undefined,
      toolName: "Edit",
      args: {},
    });
    expect(result).toEqual({ allow: true });
  });

  it("PreToolUse handler throw fails CLOSED with reason mentioning the hook name", async () => {
    const bus = makeHookBus();
    bus.register({
      event: "PreToolUse",
      name: "explodes",
      handler: () => {
        throw new Error("kaboom");
      },
    });
    const result = await bus.dispatchPreToolUse({
      event: "PreToolUse",
      threadId: "t1",
      cwd: undefined,
      toolName: "Edit",
      args: {},
    });
    expect(result.allow).toBe(false);
    if (!result.allow) {
      expect(result.reason).toContain("explodes");
      expect(result.reason).toContain("kaboom");
    }
  });

  it("empty PreToolUse hook list returns allow:true", async () => {
    const bus = makeHookBus();
    const result = await bus.dispatchPreToolUse({
      event: "PreToolUse",
      threadId: "t1",
      cwd: undefined,
      toolName: "Edit",
      args: {},
    });
    expect(result).toEqual({ allow: true });
  });
});

describe("HookBus — SessionStart inject aggregation", () => {
  it("concatenates injects in priority order separated by blank line", async () => {
    const bus = makeHookBus();
    bus.register({
      event: "SessionStart",
      name: "second-by-priority",
      priority: 20,
      handler: () => ({ inject: "BLOCK_B" }),
    });
    bus.register({
      event: "SessionStart",
      name: "first-by-priority",
      priority: 10,
      handler: () => ({ inject: "BLOCK_A" }),
    });
    const out = await bus.dispatchSessionStart({
      event: "SessionStart",
      threadId: "t1",
      cwd: undefined,
    });
    expect(out).toBe("BLOCK_A\n\nBLOCK_B");
  });

  it("returns undefined when no hooks injected anything", async () => {
    const bus = makeHookBus();
    bus.register({
      event: "SessionStart",
      name: "no-op",
      handler: () => ({}),
    });
    bus.register({
      event: "SessionStart",
      name: "empty-result",
      handler: () => ({}),
    });
    const out = await bus.dispatchSessionStart({
      event: "SessionStart",
      threadId: "t1",
      cwd: undefined,
    });
    expect(out).toBeUndefined();
  });

  it("returns undefined when registry is empty", async () => {
    const bus = makeHookBus();
    const out = await bus.dispatchSessionStart({
      event: "SessionStart",
      threadId: "t1",
      cwd: undefined,
    });
    expect(out).toBeUndefined();
  });

  it("skips handlers that throw and preserves sibling injects", async () => {
    const bus = makeHookBus();
    bus.register({
      event: "SessionStart",
      name: "throws-early",
      priority: 10,
      handler: () => {
        throw new Error("nope");
      },
    });
    bus.register({
      event: "SessionStart",
      name: "good-citizen",
      priority: 20,
      handler: () => ({ inject: "RECOVERED" }),
    });
    const out = await bus.dispatchSessionStart({
      event: "SessionStart",
      threadId: "t1",
      cwd: undefined,
    });
    expect(out).toBe("RECOVERED");
  });

  it("ignores zero-length inject strings", async () => {
    const bus = makeHookBus();
    bus.register({
      event: "SessionStart",
      name: "empty-inject",
      priority: 10,
      handler: () => ({ inject: "" }),
    });
    bus.register({
      event: "SessionStart",
      name: "real-inject",
      priority: 20,
      handler: () => ({ inject: "REAL" }),
    });
    const out = await bus.dispatchSessionStart({
      event: "SessionStart",
      threadId: "t1",
      cwd: undefined,
    });
    expect(out).toBe("REAL");
  });
});

describe("HookBus — empty-registry dispatch is a clean no-op", () => {
  it("Stop with no hooks resolves to undefined", async () => {
    const bus = makeHookBus();
    await expect(
      bus.dispatchStop({ event: "Stop", threadId: "t1", cwd: undefined, turnIndex: 0 }),
    ).resolves.toBeUndefined();
  });

  it("SessionEnd with no hooks resolves to undefined", async () => {
    const bus = makeHookBus();
    await expect(
      bus.dispatchSessionEnd({
        event: "SessionEnd",
        threadId: "t1",
        cwd: undefined,
        reason: "user_closed",
      }),
    ).resolves.toBeUndefined();
  });

  it("SubagentStop with no hooks resolves to undefined", async () => {
    const bus = makeHookBus();
    await expect(
      bus.dispatchSubagentStop({
        event: "SubagentStop",
        parentThreadId: "p",
        workerId: "w",
        result: undefined,
      }),
    ).resolves.toBeUndefined();
  });

  it("Notification with no hooks resolves to undefined", async () => {
    const bus = makeHookBus();
    await expect(
      bus.dispatchNotification({ event: "Notification", kind: "x", payload: {} }),
    ).resolves.toBeUndefined();
  });
});

describe("HookBus — sync + async handler equivalence", () => {
  it("sync Stop handler runs", async () => {
    const bus = makeHookBus();
    let fired = false;
    bus.register({
      event: "Stop",
      name: "sync",
      handler: () => {
        fired = true;
      },
    });
    await bus.dispatchStop({ event: "Stop", threadId: "t1", cwd: undefined, turnIndex: 0 });
    expect(fired).toBe(true);
  });

  it("async Stop handler is awaited", async () => {
    const bus = makeHookBus();
    let fired = false;
    bus.register({
      event: "Stop",
      name: "async",
      handler: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        fired = true;
      },
    });
    await bus.dispatchStop({ event: "Stop", threadId: "t1", cwd: undefined, turnIndex: 0 });
    expect(fired).toBe(true);
  });

  it("async PreToolUse handler is awaited and its result respected", async () => {
    const bus = makeHookBus();
    bus.register({
      event: "PreToolUse",
      name: "async-deny",
      handler: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { allow: false, reason: "async-decided" };
      },
    });
    const result = await bus.dispatchPreToolUse({
      event: "PreToolUse",
      threadId: "t1",
      cwd: undefined,
      toolName: "Bash",
      args: {},
    });
    expect(result).toEqual({ allow: false, reason: "async-decided" });
  });
});
