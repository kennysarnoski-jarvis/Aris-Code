/**
 * HookedTools tests — wrap an SDK-shaped tool with the hook bus and
 * verify PreToolUse / PostToolUse fire around `.invoke`, deny short-
 * circuits, and errors propagate while still firing PostToolUse.
 */
import { describe, expect, it } from "vitest";

import { makeHookBus } from "./HookBus.ts";
import type { PostToolUseContext, PreToolUseContext, PreToolUseResult } from "./HookTypes.ts";
import { type HookableTool, wrapToolsWithHooks, wrapToolWithHooks } from "./HookedTools.ts";

/**
 * Build a minimal SDK-tool-shaped object. The wrapper only reads
 * `.name` and intercepts `.invoke`; everything else is passed through
 * via Reflect.get so we can stash arbitrary extra fields and verify
 * they survive the Proxy.
 */
const mkTool = (
  name: string,
  invoke: (rc: unknown, input: string) => Promise<unknown>,
  extras: Record<string, unknown> = {},
): HookableTool & Record<string, unknown> => ({
  name,
  invoke,
  ...extras,
});

describe("wrapToolWithHooks — Pre / Post dispatch", () => {
  it("fires PreToolUse and PostToolUse around a successful invoke", async () => {
    const bus = makeHookBus();
    const events: string[] = [];
    bus.register({
      event: "PreToolUse",
      name: "pre-observer",
      handler: (ctx: PreToolUseContext) => {
        events.push(`pre:${ctx.toolName}:${JSON.stringify(ctx.args)}`);
        return { allow: true };
      },
    });
    bus.register({
      event: "PostToolUse",
      name: "post-observer",
      handler: (ctx: PostToolUseContext) => {
        events.push(`post:${ctx.toolName}:${JSON.stringify(ctx.result)}`);
      },
    });
    const tool = mkTool("read_file", async (_rc, input) => {
      events.push(`invoke:${input}`);
      return "file contents";
    });
    const wrapped = wrapToolWithHooks(tool, bus, { threadId: "t1", cwd: "/work" });
    const result = await wrapped.invoke({}, JSON.stringify({ path: "a.txt" }));
    expect(result).toBe("file contents");
    expect(events).toEqual([
      'pre:read_file:{"path":"a.txt"}',
      'invoke:{"path":"a.txt"}',
      'post:read_file:"file contents"',
    ]);
  });

  it("short-circuits the original invoke when PreToolUse returns allow:false", async () => {
    const bus = makeHookBus();
    let invokeCalled = false;
    bus.register({
      event: "PreToolUse",
      name: "deny",
      handler: (): PreToolUseResult => ({ allow: false, reason: "policy violation" }),
    });
    const tool = mkTool("dangerous_thing", async () => {
      invokeCalled = true;
      return "should not run";
    });
    const wrapped = wrapToolWithHooks(tool, bus, { threadId: "t1", cwd: undefined });
    const result = (await wrapped.invoke({}, "{}")) as string;
    expect(invokeCalled).toBe(false);
    expect(result).toContain("[blocked by PreToolUse hook]");
    expect(result).toContain("policy violation");
  });

  it("fires PostToolUse with an error payload and re-throws when invoke throws", async () => {
    const bus = makeHookBus();
    let observedResult: unknown = undefined;
    bus.register({
      event: "PostToolUse",
      name: "post-capture",
      handler: (ctx: PostToolUseContext) => {
        observedResult = ctx.result;
      },
    });
    const tool = mkTool("flaky", async () => {
      throw new Error("upstream broke");
    });
    const wrapped = wrapToolWithHooks(tool, bus, { threadId: "t1", cwd: undefined });
    await expect(wrapped.invoke({}, "{}")).rejects.toThrow("upstream broke");
    expect(observedResult).toEqual({ error: "upstream broke" });
  });

  it("PreToolUse handler throws → fail-closed (HookBus contract) → deny string returned", async () => {
    const bus = makeHookBus();
    bus.register({
      event: "PreToolUse",
      name: "buggy",
      handler: () => {
        throw new Error("hook crashed");
      },
    });
    const tool = mkTool("read_file", async () => "should not run");
    const wrapped = wrapToolWithHooks(tool, bus, { threadId: "t1", cwd: undefined });
    const result = (await wrapped.invoke({}, "{}")) as string;
    expect(result).toContain("[blocked by PreToolUse hook]");
    expect(result).toContain("hook crashed");
  });

  it("passes raw input through when the SDK input string is not JSON", async () => {
    const bus = makeHookBus();
    let observedArgs: unknown = undefined;
    bus.register({
      event: "PreToolUse",
      name: "capture",
      handler: (ctx: PreToolUseContext) => {
        observedArgs = ctx.args;
        return { allow: true };
      },
    });
    const tool = mkTool("legacy_tool", async () => "ok");
    const wrapped = wrapToolWithHooks(tool, bus, { threadId: "t1", cwd: undefined });
    await wrapped.invoke({}, "not json at all");
    expect(observedArgs).toBe("not json at all");
  });

  it("Proxy preserves non-invoke properties so the SDK sees the original surface", () => {
    const bus = makeHookBus();
    const tool = mkTool("ping", async () => "pong", {
      description: "the description",
      parameters: { type: "object" },
      secretInternal: 42,
    });
    const wrapped = wrapToolWithHooks(tool, bus, { threadId: "t1", cwd: undefined });
    expect((wrapped as unknown as { description: string }).description).toBe("the description");
    expect((wrapped as unknown as { parameters: { type: string } }).parameters).toEqual({
      type: "object",
    });
    expect((wrapped as unknown as { secretInternal: number }).secretInternal).toBe(42);
    expect(wrapped.name).toBe("ping");
  });

  it("passes threadId and cwd from context into the hook context", async () => {
    const bus = makeHookBus();
    let observedPre: PreToolUseContext | undefined;
    let observedPost: PostToolUseContext | undefined;
    bus.register({
      event: "PreToolUse",
      name: "p",
      handler: (ctx) => {
        observedPre = ctx;
        return { allow: true };
      },
    });
    bus.register({
      event: "PostToolUse",
      name: "p",
      handler: (ctx) => {
        observedPost = ctx;
      },
    });
    const tool = mkTool("ping", async () => "pong");
    const wrapped = wrapToolWithHooks(tool, bus, {
      threadId: "thread-xyz",
      cwd: "/my/project",
    });
    await wrapped.invoke({}, JSON.stringify({ x: 1 }));
    expect(observedPre?.threadId).toBe("thread-xyz");
    expect(observedPre?.cwd).toBe("/my/project");
    expect(observedPre?.toolName).toBe("ping");
    expect(observedPost?.threadId).toBe("thread-xyz");
    expect(observedPost?.cwd).toBe("/my/project");
    expect(observedPost?.toolName).toBe("ping");
  });
});

describe("wrapToolsWithHooks — array mapping", () => {
  it("wraps every tool in an array independently", async () => {
    const bus = makeHookBus();
    const calls: string[] = [];
    bus.register({
      event: "PostToolUse",
      name: "post",
      handler: (ctx: PostToolUseContext) => {
        calls.push(ctx.toolName);
      },
    });
    const tools = [
      mkTool("a", async () => "A"),
      mkTool("b", async () => "B"),
      mkTool("c", async () => "C"),
    ];
    const wrapped = wrapToolsWithHooks(tools, bus, { threadId: "t1", cwd: undefined });
    expect(wrapped).toHaveLength(3);
    await wrapped[0]!.invoke({}, "{}");
    await wrapped[1]!.invoke({}, "{}");
    await wrapped[2]!.invoke({}, "{}");
    expect(calls).toEqual(["a", "b", "c"]);
  });

  it("returns an empty array when given an empty array", () => {
    const bus = makeHookBus();
    const wrapped = wrapToolsWithHooks([], bus, { threadId: "t1", cwd: undefined });
    expect(wrapped).toEqual([]);
  });
});
