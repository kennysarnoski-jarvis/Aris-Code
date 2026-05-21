/**
 * Hook type definitions for the DeepSeek (Aris) provider hook bus.
 *
 * Seven events fire at well-defined points in the session lifecycle.
 * Hooks are in-process TypeScript functions (not subprocesses); each
 * one returns synchronously or via Promise. Per-event handler
 * signatures keep registration type-safe — a `Stop` hook can't
 * accidentally be registered as a `PreToolUse` hook.
 *
 * The eighth Claude-Code event (`PreCompact`) is intentionally NOT
 * here: Aris uses the rolling-window threshold (920K tokens) instead
 * of compaction, so the event has no firing site.
 *
 * Flow-affecting events (two of seven):
 *   - PreToolUse  → may veto the tool call (returns allow:true/false)
 *   - SessionStart → may inject system context (returns { inject? })
 *
 * Fire-and-forget events (five of seven):
 *   - PostToolUse, Stop, SessionEnd, SubagentStop, Notification
 *     → errors are caught + logged, never bubble.
 */

export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "SessionStart"
  | "SessionEnd"
  | "SubagentStop"
  | "Notification";

/**
 * Default priority for hooks that don't declare one. Ascending
 * priority means lower numbers run first. Built-in hooks generally
 * sit at 100; user-authored hooks can slot in earlier or later as
 * needed.
 */
export const DEFAULT_HOOK_PRIORITY = 100;

// ---------------------------------------------------------------------------
// Per-event context shapes
// ---------------------------------------------------------------------------

export interface PreToolUseContext {
  readonly event: "PreToolUse";
  readonly threadId: string;
  readonly cwd: string | undefined;
  readonly toolName: string;
  readonly args: unknown;
}

export interface PostToolUseContext {
  readonly event: "PostToolUse";
  readonly threadId: string;
  readonly cwd: string | undefined;
  readonly toolName: string;
  readonly args: unknown;
  readonly result: unknown;
}

export interface StopContext {
  readonly event: "Stop";
  readonly threadId: string;
  readonly cwd: string | undefined;
  /** Zero-based index of the assistant turn that just finished. */
  readonly turnIndex: number;
}

export interface SessionStartContext {
  readonly event: "SessionStart";
  readonly threadId: string;
  readonly cwd: string | undefined;
}

export interface SessionEndContext {
  readonly event: "SessionEnd";
  readonly threadId: string;
  readonly cwd: string | undefined;
  readonly reason: "user_closed" | "shutdown" | "error";
}

export interface SubagentStopContext {
  readonly event: "SubagentStop";
  readonly parentThreadId: string;
  readonly workerId: string;
  readonly result: unknown;
}

export interface NotificationContext {
  readonly event: "Notification";
  readonly kind: string;
  readonly payload: unknown;
}

export type HookContext =
  | PreToolUseContext
  | PostToolUseContext
  | StopContext
  | SessionStartContext
  | SessionEndContext
  | SubagentStopContext
  | NotificationContext;

// ---------------------------------------------------------------------------
// Flow-affecting return shapes
// ---------------------------------------------------------------------------

export type PreToolUseResult =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: string };

export interface SessionStartResult {
  readonly inject?: string;
}

// ---------------------------------------------------------------------------
// Per-event handler signatures
// ---------------------------------------------------------------------------

export type PreToolUseHandler = (
  ctx: PreToolUseContext,
) => PreToolUseResult | Promise<PreToolUseResult>;

export type PostToolUseHandler = (ctx: PostToolUseContext) => void | Promise<void>;

export type StopHandler = (ctx: StopContext) => void | Promise<void>;

export type SessionStartHandler = (
  ctx: SessionStartContext,
) => SessionStartResult | Promise<SessionStartResult>;

export type SessionEndHandler = (ctx: SessionEndContext) => void | Promise<void>;

export type SubagentStopHandler = (ctx: SubagentStopContext) => void | Promise<void>;

export type NotificationHandler = (ctx: NotificationContext) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Registration shape (discriminated by event so handler types match)
// ---------------------------------------------------------------------------

interface HookSpecBase {
  /** Human-readable name used in logs. Required for traceability. */
  readonly name: string;
  /** Ascending priority. Defaults to DEFAULT_HOOK_PRIORITY (100). */
  readonly priority?: number;
}

export type HookSpec =
  | (HookSpecBase & { readonly event: "PreToolUse"; readonly handler: PreToolUseHandler })
  | (HookSpecBase & { readonly event: "PostToolUse"; readonly handler: PostToolUseHandler })
  | (HookSpecBase & { readonly event: "Stop"; readonly handler: StopHandler })
  | (HookSpecBase & { readonly event: "SessionStart"; readonly handler: SessionStartHandler })
  | (HookSpecBase & { readonly event: "SessionEnd"; readonly handler: SessionEndHandler })
  | (HookSpecBase & { readonly event: "SubagentStop"; readonly handler: SubagentStopHandler })
  | (HookSpecBase & { readonly event: "Notification"; readonly handler: NotificationHandler });
