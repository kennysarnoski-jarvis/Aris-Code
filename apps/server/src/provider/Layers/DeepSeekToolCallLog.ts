/**
 * DeepSeekToolCallLog — pure formatters for the stderr tool-call
 * observability lines emitted from the DeepSeek agent runner and the
 * spawn_worker stream handler.
 *
 * Slice A (2026-05-16) — H12 fix from the self-audit. Pre-Slice-A the
 * log lines included the full (truncated) args content via
 * `JSON.stringify(argsPreview)`. When a tool call carried secrets in
 * its args (e.g. an `edit_file` that wrote a `.env` body, or a `bash`
 * with inline credentials), the secret landed in stderr. On a
 * developer machine that's just dev console noise — but the moment
 * those logs are aggregated, streamed to telemetry, or attached to
 * bug reports, the secret exfiltrates.
 *
 * The fix is structural, not procedural: these formatters **do not
 * accept** the args content as a parameter. They take only the byte
 * count. The TypeScript signature makes it compile-time impossible
 * for a caller to slip args content into the log line.
 *
 * Argument descriptions (the `describeWorkerToolCall` helper in
 * DeepSeekAgentTool that produces "Reading X" / "Editing Y" labels for
 * the CoordinatorActivityPanel UI) still parse args to pick decision-
 * relevant fields, but those labels are derived from KNOWN safe fields
 * (path, pattern, command) and pass through the UI's existing content-
 * truncation. Raw args bytes never reach stderr.
 *
 * @module DeepSeekToolCallLog
 */

export interface FormatWorkerToolCallLogInput {
  /** Worker tag (e.g. `[worker 'audit-foo']`). Prefixed verbatim. */
  readonly tag: string;
  /** Tool name as emitted by the model. */
  readonly toolName: string;
  /** Tool call id from the SDK frame. */
  readonly callId: string;
  /** Byte length of the raw args JSON. Used for shape diagnostics. */
  readonly argsBytes: number;
}

/**
 * Format the worker-side `tool_call:` log line emitted from inside
 * `DeepSeekAgentTool`'s stream handler for each tool call a spawned
 * worker makes. Pre-Slice-A this line included the args content; that
 * field has been removed. Callers that need to render "what is the
 * worker doing right now?" should use the existing
 * `describeWorkerToolCall` helper which produces a verb-label from
 * known-safe args fields.
 */
export function formatWorkerToolCallLog(input: FormatWorkerToolCallLogInput): string {
  return (
    `${input.tag} tool_call: name=${input.toolName} callId=${input.callId} ` +
    `argsBytes=${input.argsBytes}`
  );
}

export interface FormatRunnerToolCallLogInput {
  /** Tool name as emitted by the model. */
  readonly toolName: string;
  /** Tool call id from the SDK frame. */
  readonly callId: string;
  /** Byte length of the raw args JSON. Used for shape diagnostics. */
  readonly argsBytes: number;
  /**
   * Optional parse error string. When set, the formatter emits the
   * JSON_PARSE_FAILED variant (still without leaking the args content
   * — parse failures are signaled by the error message alone). When
   * unset, the formatter emits the standard success variant.
   */
  readonly parseError?: string | null | undefined;
}

/**
 * Format the runner-side `[DeepSeekAgentRunner] tool_call_item:` log
 * line emitted from `DeepSeekAgentRunner` for each tool call the
 * model emits. Pre-Slice-A both the success branch and the parse-
 * failure branch leaked args content via `argsPreview`. That field
 * has been removed from both branches.
 *
 * Parse-failure detail (the `JSON_PARSE_FAILED=<reason>` segment) is
 * preserved because the reason string is generated server-side, NOT
 * derived from args content — it carries no user-controlled data.
 */
export function formatRunnerToolCallLog(input: FormatRunnerToolCallLogInput): string {
  const prefix =
    `[DeepSeekAgentRunner] tool_call_item: ` +
    `name=${input.toolName} callId=${input.callId} ` +
    `argsBytes=${input.argsBytes}`;
  if (typeof input.parseError === "string" && input.parseError.length > 0) {
    return `${prefix} JSON_PARSE_FAILED=${input.parseError}`;
  }
  return prefix;
}
