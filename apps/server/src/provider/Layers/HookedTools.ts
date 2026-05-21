/**
 * HookedTools — wrap `@openai/agents` SDK tools so their invocations
 * fire `PreToolUse` / `PostToolUse` events on the HookBus.
 *
 * The HookBus already declares both events (`HookTypes.ts`) and
 * dispatches them (`HookBus.ts`), but nothing in the adapter has been
 * firing them yet. This module is the bridge: take an array of SDK
 * tools (from `createDeepSeekAgentTools`, `createUseSkillTool`,
 * `createUseCommandTool`, etc.), return a parallel array where each
 * tool's `.invoke` is wrapped to dispatch the events around the
 * original call.
 *
 * Semantics (mirrors HookBus.ts's documented behavior):
 *
 *   - `PreToolUse` fires BEFORE the original invoke. If any handler
 *     returns `{ allow: false, reason }` (or throws — fail-closed),
 *     we short-circuit and return the deny reason as the tool result
 *     string. The original tool never runs.
 *
 *   - `PostToolUse` fires AFTER the original invoke, whether it
 *     succeeded or threw. On throw, the original exception is
 *     re-thrown to the SDK so the tool-call surface still sees the
 *     failure — the PostToolUse handlers just get to observe the
 *     error result before the throw propagates.
 *
 *   - Hook context carries `threadId` and `cwd` from the session, the
 *     `toolName` from the tool itself, and a best-effort parsed
 *     `args` value (we JSON.parse the SDK's input string; on failure
 *     we pass through the raw string). Hook subscribers see the same
 *     args the model passed.
 *
 * Why Proxy and not object-spread:
 *   The SDK's tool object may carry non-enumerable properties or
 *   prototype methods (it's an opaque library type). Proxy is the
 *   safe pattern because it forwards every untouched access via
 *   `Reflect.get`, so the SDK sees the original tool's full surface —
 *   we only override `.invoke`.
 *
 * @module HookedTools
 */

import type { HookBus } from "./HookBus.ts";

/**
 * Minimum SDK tool surface we touch. The real `@openai/agents` tool
 * has more properties (description, parameters, etc.) but we only
 * need to read `.name` and intercept `.invoke` — Proxy forwards the
 * rest automatically.
 */
export interface HookableTool {
  readonly name: string;
  invoke(runContext: unknown, input: string): Promise<unknown>;
}

export interface ToolHookContext {
  readonly threadId: string;
  readonly cwd: string | undefined;
}

/**
 * Best-effort parse the SDK's tool input string into a structured
 * value for hook visibility. The SDK serializes the model's tool
 * arguments as JSON, so this usually succeeds — but if a tool ever
 * accepts raw strings or a non-JSON payload, we pass the string
 * through unchanged so the hook can still see something useful.
 */
function parseToolInput(input: string): unknown {
  if (input == null) return undefined;
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

/**
 * Wrap a single SDK tool so PreToolUse/PostToolUse fire around its
 * invocation. Returns a Proxy that's interchangeable with the
 * original everywhere the SDK looks (name, description, parameters,
 * everything except `invoke` itself).
 *
 * The generic `T` is unconstrained because the `@openai/agents` SDK's
 * `Tool` type is opaque (its `.invoke` signature is broader than ours
 * — different second-arg shape — so a structural `extends HookableTool`
 * constraint would reject SDK tools at the call site). Internally we
 * still treat the input as a `HookableTool`, so the runtime contract
 * is "the input MUST have `.name: string` and `.invoke(rc, input):
 * Promise<unknown>`". Every tool factory in the codebase satisfies
 * this; if a future tool somehow doesn't, the wrapped Proxy will
 * crash at the `target.name` read on first invoke — a clear failure
 * mode the type system doesn't gain anything by also reporting.
 */
export function wrapToolWithHooks<T>(tool: T, hookBus: HookBus, ctx: ToolHookContext): T {
  const target = tool as unknown as HookableTool;
  return new Proxy(target, {
    get(proxyTarget, prop, receiver) {
      if (prop !== "invoke") {
        return Reflect.get(proxyTarget, prop, receiver);
      }
      // Wrap the .invoke method with PreToolUse / PostToolUse dispatch.
      return async function wrappedInvoke(runContext: unknown, input: string): Promise<unknown> {
        const parsedArgs = parseToolInput(input);

        // PreToolUse — may veto with allow:false. A throwing handler
        // fails closed (HookBus returns allow:false with the throw
        // reason), which surfaces as the deny string below.
        const preResult = await hookBus.dispatchPreToolUse({
          event: "PreToolUse",
          threadId: ctx.threadId,
          cwd: ctx.cwd,
          toolName: proxyTarget.name,
          args: parsedArgs,
        });
        if (!preResult.allow) {
          return `[blocked by PreToolUse hook] ${preResult.reason}`;
        }

        // Call the original invoke. On throw, fire PostToolUse with
        // the error captured as the `result` field so observers can
        // see the failure, then re-throw so the SDK still surfaces
        // the original error to the model.
        let result: unknown;
        try {
          result = await proxyTarget.invoke(runContext, input);
        } catch (err) {
          const errPayload = {
            error: err instanceof Error ? err.message : String(err),
          };
          await hookBus.dispatchPostToolUse({
            event: "PostToolUse",
            threadId: ctx.threadId,
            cwd: ctx.cwd,
            toolName: proxyTarget.name,
            args: parsedArgs,
            result: errPayload,
          });
          throw err;
        }

        // Success path. PostToolUse is fire-and-forget by contract
        // (HookBus.ts catches handler throws), so we await it for
        // sequencing but don't propagate any internal observer bugs
        // to the model.
        await hookBus.dispatchPostToolUse({
          event: "PostToolUse",
          threadId: ctx.threadId,
          cwd: ctx.cwd,
          toolName: proxyTarget.name,
          args: parsedArgs,
          result,
        });
        return result;
      };
    },
  }) as unknown as T;
}

/**
 * Convenience wrapper around `wrapToolWithHooks` for arrays of
 * tools. Same semantics; just maps each entry through the wrapper.
 * Generic `T` is unconstrained for the same reason as the single-tool
 * variant — SDK tool types vary structurally from our minimal shape.
 */
export function wrapToolsWithHooks<T>(
  tools: ReadonlyArray<T>,
  hookBus: HookBus,
  ctx: ToolHookContext,
): T[] {
  return tools.map((t) => wrapToolWithHooks(t, hookBus, ctx));
}
