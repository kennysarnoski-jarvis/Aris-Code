/**
 * ArisStreamInterceptor — pulls Aris-specific control-plane frames out
 * of an OpenAI-shape SSE stream before they reach the OpenAI SDK.
 *
 * Why this exists:
 *   `aris_server` mixes standalone control frames into its
 *   `/v1/chat/completions` SSE stream:
 *     - `data: {"aris": {"conversation_id": 42}}\n\n` (server-assigned
 *       conversation row id, emitted on first frame of a new
 *       conversation)
 *     - `data: {"aris": {"compacting": true}}\n\n` (background
 *       compaction-block lifecycle)
 *     - `data: {"aris": {"compacting": false}}\n\n`
 *     - `data: {"aris": {"memory_changed": true}}\n\n` (graph-mutating
 *       tool fired this turn, sidebar should refresh)
 *     - `data: {"aris": {"iteration_thinking": true|false}}\n\n` (per-
 *       iteration thinking-mode signal, internal only)
 *
 *   The OpenAI Agents SDK parses each SSE chunk as an OpenAI chat
 *   completion chunk. When it sees one with no `choices` field it
 *   silently ignores it — and we lose the aris signal. To capture
 *   them, this module provides a `TransformStream` that wraps the
 *   response body, parses SSE chunks, calls a registered handler for
 *   each aris envelope it sees, and forwards everything else
 *   unchanged.
 *
 *   Per `aris_agentic.py:818` and `aris_server.py:{4854,4859,5280}`,
 *   envelope frames are ALWAYS standalone — they never carry a
 *   `choices` field alongside `aris`. So dropping the whole frame
 *   after extracting `aris` is safe.
 *
 * Handler registration:
 *   Module-level singleton because the OpenAI SDK's `fetch` is set
 *   once at client construction time. Per-turn handler registration
 *   would require per-turn fetch wiring, which is heavier. The runner
 *   sets the handler before `run()` and clears it in finally{}; the
 *   single-threaded JS runtime makes this safe in the spike. For
 *   production multi-tenancy this would need refactoring (each
 *   request would need its own contextual handler), but the spike
 *   isn't multi-tenant.
 *
 * @module ArisStreamInterceptor
 */

/**
 * Shape of the `aris` field on a control-plane SSE frame.
 * Mirrors the four emission sites in aris_server / aris_agentic.
 * All fields optional — a single frame typically carries one key.
 */
export interface ArisEnvelope {
  readonly conversation_id?: number;
  readonly compacting?: boolean;
  readonly memory_changed?: boolean;
  readonly iteration_thinking?: boolean;
}

export type ArisEnvelopeHandler = (envelope: ArisEnvelope) => void;

let currentHandler: ArisEnvelopeHandler | null = null;

/**
 * Register a handler to receive aris envelope frames. Pass `null`
 * to unregister. The runner pairs `set(handler)` with
 * `set(null)` in a finally block so handler state doesn't leak
 * between turns.
 */
export function setArisEnvelopeHandler(handler: ArisEnvelopeHandler | null): void {
  currentHandler = handler;
}

// ── Slice 31 — per-message thinking-mode override ─────────────────────
//
// `chat_template_kwargs.enable_thinking` is the vLLM-level switch that
// controls whether Qwen3.6 emits `<think>...</think>` blocks. Server
// defaults to ON. The Aris Code composer carries a per-message toggle
// the user can flip — when set, we inject the value into the next
// outbound chat-completions request body via the fetch wrapper in
// ArisOpenAIClient.
//
// Module-level state mirrors the envelope-handler pattern: the runner
// sets it before `run()` and clears it in `finally{}` so values don't
// leak across turns. JS is single-threaded so this is safe in the
// spike / single-tenant case; multi-tenancy refactor would replace
// this with per-request context.

let currentRequestThinkingMode: boolean | undefined = undefined;

/**
 * Set the `enable_thinking` value to inject into the NEXT outbound
 * chat-completions request body. Pass `undefined` to clear (server
 * default applies). The runner pairs `set(mode)` with `set(undefined)`
 * in a finally block.
 */
export function setRequestThinkingMode(enabled: boolean | undefined): void {
  currentRequestThinkingMode = enabled;
}

/** Read the currently-set thinking mode. Used by ArisOpenAIClient's fetch wrapper. */
export function getRequestThinkingMode(): boolean | undefined {
  return currentRequestThinkingMode;
}

/**
 * Wrap a streaming Response so envelope frames are pulled out before
 * the SDK consumes the stream. If the response has no body or isn't a
 * streaming chat completion, returns it unchanged.
 *
 * Behavior:
 *   - Decodes the response body chunk by chunk.
 *   - Splits on SSE event boundary (`\n\n`).
 *   - For each `data: {...}` frame: parses as JSON, checks for
 *     `aris` field. If present, invokes the registered handler and
 *     drops the frame from the forwarded stream. Otherwise forwards
 *     the frame unchanged.
 *   - Other event types (e.g. `event: foo`) and `data: [DONE]` pass
 *     through unchanged.
 *
 * Failure modes:
 *   - Handler throws → swallowed (logged via console.error). We
 *     don't want a buggy handler to corrupt the stream the SDK is
 *     consuming.
 *   - Frame JSON is malformed → forwarded unchanged. The SDK might
 *     choke on it but that's its problem; we don't want this layer
 *     deciding what's malformed for the SDK.
 */
export function wrapResponseWithEnvelopeInterceptor(response: Response): Response {
  if (!response.body) return response;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  const interceptor = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });

      // SSE events terminate on a blank line — `\n\n`. Process all
      // complete events in the buffer; leave any trailing partial
      // event for the next chunk.
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        if (isArisEnvelopeFrame(event)) {
          // Drop the frame entirely — the SDK never sees it.
          // Handler invoked via side-effect inside isArisEnvelopeFrame.
        } else {
          // Forward unchanged, including the boundary.
          controller.enqueue(encoder.encode(event + "\n\n"));
        }

        boundary = buffer.indexOf("\n\n");
      }
    },

    flush(controller) {
      // Drain any remaining partial frame at end-of-stream. Don't
      // try to parse — incomplete frames are by definition not
      // well-formed JSON.
      if (buffer.length > 0) {
        controller.enqueue(encoder.encode(buffer));
        buffer = "";
      }
    },
  });

  return new Response(response.body.pipeThrough(interceptor), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Test whether a complete SSE event is an aris envelope frame, and
 * if so invoke the handler. Returns true when the caller should drop
 * the frame from the forwarded stream.
 *
 * SSE event format we expect from aris_server:
 *   data: {"aris": {...}}
 * (single-line `data:` payload — multi-line `data:` continuations
 * exist in the spec but aris_server doesn't emit them.)
 */
function isArisEnvelopeFrame(event: string): boolean {
  // An SSE event can contain multiple lines (data:, event:, id:,
  // retry:). We only care about the data: line(s).
  const lines = event.split("\n");
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const dataStr = line.slice(6).trim();
    // OpenAI's stream-end marker — definitely not an aris envelope.
    if (dataStr === "[DONE]") return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataStr);
    } catch {
      // Non-JSON data line (uncommon but valid SSE). Forward.
      return false;
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      "aris" in parsed &&
      typeof (parsed as { aris: unknown }).aris === "object" &&
      (parsed as { aris: unknown }).aris !== null
    ) {
      const envelope = (parsed as { aris: ArisEnvelope }).aris;
      // Per aris_server source, envelope frames are emitted as
      // standalone `data: {"aris": {...}}` chunks — they never
      // carry a `choices` array. So if we see `aris`, drop the
      // whole frame.
      if (currentHandler) {
        try {
          currentHandler(envelope);
        } catch (err) {
          console.error(
            `[ArisStreamInterceptor] handler threw — swallowed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      return true;
    }
  }
  return false;
}
