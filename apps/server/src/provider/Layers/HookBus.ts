/**
 * In-process hook bus for the DeepSeek (Aris) provider.
 *
 * Stateful registry of typed handlers keyed by event. The bus is
 * created per-adapter (not a module singleton) so tests can spin up
 * fresh instances and the adapter retains a single shared instance
 * for its lifetime.
 *
 * Dispatch semantics:
 *   - All events run handlers in ascending priority order (default 100).
 *   - PreToolUse: first `allow: false` short-circuits. A throwing
 *     handler fails CLOSED (denies the tool call) — better to block
 *     on a buggy handler than to let an unsafe call slip through.
 *   - SessionStart: every handler's `inject` is concatenated in
 *     priority order with `\n\n` separators. Throwing handlers are
 *     skipped (logged); their absence doesn't drop sibling injects.
 *   - PostToolUse / Stop / SessionEnd / SubagentStop / Notification:
 *     fire-and-forget. Handler throws are caught + logged, never
 *     bubble, never block the next handler.
 *
 * The bus does not start fibers or background tasks; it just calls
 * the handlers in series. Callers that want async behavior should
 * use Promise-returning handlers — the bus awaits each one before
 * proceeding to the next.
 */

import {
  DEFAULT_HOOK_PRIORITY,
  type HookSpec,
  type NotificationContext,
  type PostToolUseContext,
  type PreToolUseContext,
  type PreToolUseResult,
  type SessionEndContext,
  type SessionStartContext,
  type StopContext,
  type SubagentStopContext,
} from "./HookTypes.ts";

const LOG_PREFIX = "[HookBus]";

interface RegisteredHook {
  readonly name: string;
  readonly priority: number;
  readonly handler: (ctx: unknown) => unknown;
}

function sortByPriority(list: readonly RegisteredHook[]): readonly RegisteredHook[] {
  return list.toSorted((a, b) => a.priority - b.priority);
}

export interface HookBus {
  readonly register: (spec: HookSpec) => void;
  readonly clear: () => void;
  readonly count: (event: HookSpec["event"]) => number;
  readonly dispatchPreToolUse: (ctx: PreToolUseContext) => Promise<PreToolUseResult>;
  readonly dispatchPostToolUse: (ctx: PostToolUseContext) => Promise<void>;
  readonly dispatchStop: (ctx: StopContext) => Promise<void>;
  readonly dispatchSessionStart: (ctx: SessionStartContext) => Promise<string | undefined>;
  readonly dispatchSessionEnd: (ctx: SessionEndContext) => Promise<void>;
  readonly dispatchSubagentStop: (ctx: SubagentStopContext) => Promise<void>;
  readonly dispatchNotification: (ctx: NotificationContext) => Promise<void>;
}

export function makeHookBus(): HookBus {
  const hooks: Record<HookSpec["event"], RegisteredHook[]> = {
    PreToolUse: [],
    PostToolUse: [],
    Stop: [],
    SessionStart: [],
    SessionEnd: [],
    SubagentStop: [],
    Notification: [],
  };

  function register(spec: HookSpec): void {
    const priority = spec.priority ?? DEFAULT_HOOK_PRIORITY;
    hooks[spec.event].push({
      name: spec.name,
      priority,
      handler: spec.handler as (ctx: unknown) => unknown,
    });
  }

  function clear(): void {
    for (const event of Object.keys(hooks) as Array<HookSpec["event"]>) {
      hooks[event] = [];
    }
  }

  function count(event: HookSpec["event"]): number {
    return hooks[event].length;
  }

  async function dispatchPreToolUse(ctx: PreToolUseContext): Promise<PreToolUseResult> {
    const ordered = sortByPriority(hooks.PreToolUse);
    for (const hook of ordered) {
      let result: PreToolUseResult;
      try {
        result = (await hook.handler(ctx)) as PreToolUseResult;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`${LOG_PREFIX} PreToolUse handler "${hook.name}" threw: ${message}`);
        // Fail closed — deny the tool call if a hook errors. A buggy
        // safety hook should not silently allow an unsafe call.
        return {
          allow: false,
          reason: `Hook "${hook.name}" errored: ${message}`,
        };
      }
      if (!result.allow) {
        return result;
      }
    }
    return { allow: true };
  }

  async function dispatchPostToolUse(ctx: PostToolUseContext): Promise<void> {
    const ordered = sortByPriority(hooks.PostToolUse);
    for (const hook of ordered) {
      try {
        await hook.handler(ctx);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`${LOG_PREFIX} PostToolUse handler "${hook.name}" threw: ${message}`);
      }
    }
  }

  async function dispatchStop(ctx: StopContext): Promise<void> {
    const ordered = sortByPriority(hooks.Stop);
    for (const hook of ordered) {
      try {
        await hook.handler(ctx);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`${LOG_PREFIX} Stop handler "${hook.name}" threw: ${message}`);
      }
    }
  }

  async function dispatchSessionStart(ctx: SessionStartContext): Promise<string | undefined> {
    const ordered = sortByPriority(hooks.SessionStart);
    const injects: string[] = [];
    for (const hook of ordered) {
      try {
        const result = (await hook.handler(ctx)) as { inject?: string } | void;
        if (result && typeof result.inject === "string" && result.inject.length > 0) {
          injects.push(result.inject);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`${LOG_PREFIX} SessionStart handler "${hook.name}" threw: ${message}`);
      }
    }
    return injects.length === 0 ? undefined : injects.join("\n\n");
  }

  async function dispatchSessionEnd(ctx: SessionEndContext): Promise<void> {
    const ordered = sortByPriority(hooks.SessionEnd);
    for (const hook of ordered) {
      try {
        await hook.handler(ctx);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`${LOG_PREFIX} SessionEnd handler "${hook.name}" threw: ${message}`);
      }
    }
  }

  async function dispatchSubagentStop(ctx: SubagentStopContext): Promise<void> {
    const ordered = sortByPriority(hooks.SubagentStop);
    for (const hook of ordered) {
      try {
        await hook.handler(ctx);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`${LOG_PREFIX} SubagentStop handler "${hook.name}" threw: ${message}`);
      }
    }
  }

  async function dispatchNotification(ctx: NotificationContext): Promise<void> {
    const ordered = sortByPriority(hooks.Notification);
    for (const hook of ordered) {
      try {
        await hook.handler(ctx);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`${LOG_PREFIX} Notification handler "${hook.name}" threw: ${message}`);
      }
    }
  }

  return {
    register,
    clear,
    count,
    dispatchPreToolUse,
    dispatchPostToolUse,
    dispatchStop,
    dispatchSessionStart,
    dispatchSessionEnd,
    dispatchSubagentStop,
    dispatchNotification,
  };
}
