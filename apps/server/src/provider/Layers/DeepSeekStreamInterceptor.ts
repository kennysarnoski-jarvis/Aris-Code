/**
 * DeepSeekStreamInterceptor — extracts DeepSeek's `reasoning_content`
 * sibling field out of an OpenAI-shape SSE stream so it can be surfaced
 * as a separate "thinking" delta channel to the UI, before the rest of
 * the chunk reaches the OpenAI Agents SDK.
 *
 * Why this exists (recon 2026-05-08, see `project_deepseek_v4_api_recon`):
 *   DeepSeek V4 emits `reasoning_content` as a SIBLING field to
 *   `content` on each delta — not embedded inline as `<think>...</think>`
 *   blocks (Aris/Qwen3.6 pattern) and not as standalone control frames
 *   (Aris envelope pattern). Streaming order is clean: every
 *   `reasoning_content` delta comes first, then every `content` delta;
 *   no interleaving.
 *
 *   Streaming chunk shape:
 *     data: {"choices":[{"delta":{"content":null,"reasoning_content":"..."}}]}
 *     data: {"choices":[{"delta":{"content":"...","reasoning_content":null}}]}
 *     data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{...}}
 *     data: [DONE]
 *
 *   The OpenAI Agents SDK natively understands `delta.content` but is
 *   not aware of `delta.reasoning_content`. Without intervention the
 *   reasoning stream would be silently discarded. This interceptor:
 *     1. Extracts `reasoning_content` into a side channel via a
 *        registered handler (matches the Aris dropdown UI contract).
 *     2. Strips `reasoning_content` from the delta and re-serializes
 *        the chunk so the SDK only sees the standard `content` /
 *        `tool_calls` fields it expects.
 *     3. Forwards the cleaned chunk unchanged.
 *
 *   `usage` (the final pre-`[DONE]` chunk's billing object) is left
 *   intact — the SDK surfaces it via run result, and the cost-pill
 *   path consumes it from there.
 *
 * Handler registration:
 *   Module-level singleton, mirrors the ArisStreamInterceptor pattern.
 *   The runner sets the handler before `run()` and clears it in
 *   `finally{}`. Single-tenant assumption matches the rest of the
 *   provider stack.
 *
 * @module DeepSeekStreamInterceptor
 */

export type DeepSeekReasoningHandler = (deltaText: string) => void;

let currentReasoningHandler: DeepSeekReasoningHandler | null = null;

/**
 * Register a handler to receive `reasoning_content` deltas. Pass `null`
 * to unregister. The runner pairs `set(handler)` with `set(null)` in a
 * `finally{}` block so handler state doesn't leak between turns.
 */
export function setDeepSeekReasoningHandler(handler: DeepSeekReasoningHandler | null): void {
  currentReasoningHandler = handler;
}

// ── Multi-turn reasoning_content roundtrip cache ──────────────────
//
// DeepSeek V4 in thinking mode requires that `reasoning_content` from a
// prior assistant response be sent back on subsequent requests. Per
// DeepSeek's 400 error: "The `reasoning_content` in the thinking mode
// must be passed back to the API."
//
// The OpenAI Agents SDK doesn't know about `reasoning_content` — it
// only tracks role/content/tool_calls in its message history. Without
// help, the SDK builds followup requests missing reasoning_content and
// DeepSeek rejects them with 400, the SDK retries, the agent loop
// burns its turn budget hitting 400s.
//
// Fix: cache reasoning text per tool_call_id during stream processing,
// then re-inject it into outbound assistant messages in
// `DeepSeekOpenAIClient`'s body-inject hook. We key by tool_call_id
// because that's the only stable identifier the SDK preserves across
// iterations — the SDK doesn't assign its own message_ids and DeepSeek
// doesn't return one we can latch onto.
//
// Lifecycle mirrors `setRequestReasoningEffort`: cache persists across
// iterations within a run, cleared by the runner's finally{} block via
// `clearReasoningRoundtripCache()`.

const reasoningByToolCallId = new Map<string, string>();

/**
 * Look up cached reasoning_content for an assistant message whose first
 * tool_call has the given id. Returns undefined if not cached (e.g.
 * thinking was disabled, or this is the first iteration of the run).
 */
export function lookupReasoningForToolCallId(toolCallId: string): string | undefined {
  return reasoningByToolCallId.get(toolCallId);
}

/**
 * Clear the reasoning roundtrip cache. Called by the runner's finally{}
 * block at the end of each run so cache entries don't leak between
 * unrelated turns. Safe to call repeatedly.
 */
export function clearReasoningRoundtripCache(): void {
  reasoningByToolCallId.clear();
}

interface DeepSeekDelta {
  content?: string | null;
  reasoning_content?: string | null;
  // Intentionally permissive — the OpenAI SDK owns the rest of the
  // delta shape (role, tool_calls, refusal, etc.). We only manipulate
  // reasoning_content; everything else passes through verbatim.
  [k: string]: unknown;
}

interface DeepSeekChunkChoice {
  index?: number;
  delta?: DeepSeekDelta;
  finish_reason?: string | null;
  [k: string]: unknown;
}

interface DeepSeekChunk {
  choices?: DeepSeekChunkChoice[];
  [k: string]: unknown;
}

/**
 * Wrap a streaming Response so reasoning_content deltas are extracted
 * before the OpenAI SDK consumes the stream. If the response has no
 * body, returns it unchanged.
 *
 * Behavior:
 *   - Decodes the response body chunk by chunk into UTF-8 text.
 *   - Splits on SSE event boundary (`\n\n`).
 *   - For each `data: {...}` frame: parses as JSON. If any choice's
 *     delta has a non-null `reasoning_content`, invokes the registered
 *     handler with the text, removes the field, and re-serializes the
 *     frame.
 *   - `data: [DONE]`, `event:` lines, and unparseable frames forward
 *     unchanged.
 *
 * Failure modes:
 *   - Handler throws → swallowed (logged via console.error). A buggy
 *     handler must not corrupt the stream the SDK is consuming.
 *   - Frame JSON malformed → forwarded unchanged. Don't double-judge
 *     the SDK's input.
 */
export function wrapResponseWithReasoningInterceptor(response: Response): Response {
  if (!response.body) return response;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  // Per-response state for the reasoning roundtrip cache. Accumulates
  // every reasoning_content delta seen during this stream; when a
  // tool_call delta arrives carrying an id, the accumulator is bound
  // to that id in the module-level cache so the next outbound request
  // can re-inject it. See `lookupReasoningForToolCallId`.
  const ctx = { reasoningAccumulator: "" };

  const interceptor = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const rewritten = rewriteEventStrippingReasoning(event, ctx);
        controller.enqueue(encoder.encode(rewritten + "\n\n"));

        boundary = buffer.indexOf("\n\n");
      }
    },

    flush(controller) {
      // Drain any trailing partial frame at end-of-stream. Don't try
      // to parse — incomplete frames are by definition not well-formed
      // JSON.
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
 * Per-response context the rewriter accumulates across SSE events for
 * one streaming response. Reasoning text accumulates here as deltas
 * arrive; when a tool_call delta arrives carrying an id, we copy the
 * current accumulator into the module-level cache keyed by that id.
 */
interface StreamContext {
  reasoningAccumulator: string;
}

/**
 * For a complete SSE event: locate the single `data:` payload (DeepSeek
 * doesn't emit multi-line `data:` continuations), parse as JSON, pull
 * any `reasoning_content` out of each choice's delta, invoke the
 * handler, capture reasoning per tool_call_id for multi-turn roundtrip,
 * and return a re-serialized event with the field removed.
 *
 * Returns the original event verbatim when:
 *   - There's no `data:` line.
 *   - The payload is `[DONE]`.
 *   - The payload isn't valid JSON.
 *   - No choice carries a non-null `reasoning_content` AND no tool_call
 *     delta needs roundtrip cache binding.
 */
function rewriteEventStrippingReasoning(event: string, ctx: StreamContext): string {
  const lines = event.split("\n");
  let dataLineIdx = -1;
  let dataPayload = "";

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || !line.startsWith("data: ")) continue;
    dataLineIdx = i;
    dataPayload = line.slice(6);
    break;
  }

  if (dataLineIdx === -1) return event;
  const trimmed = dataPayload.trim();
  if (trimmed === "" || trimmed === "[DONE]") return event;

  let parsed: DeepSeekChunk;
  try {
    parsed = JSON.parse(trimmed) as DeepSeekChunk;
  } catch {
    return event;
  }

  const choices = Array.isArray(parsed.choices) ? parsed.choices : null;
  if (!choices || choices.length === 0) return event;

  let mutated = false;
  for (const choice of choices) {
    const delta = choice?.delta;
    if (!delta || typeof delta !== "object") continue;
    const reasoning = delta.reasoning_content;
    if (typeof reasoning === "string" && reasoning.length > 0) {
      if (currentReasoningHandler) {
        try {
          currentReasoningHandler(reasoning);
        } catch (err) {
          console.error(
            `[DeepSeekStreamInterceptor] reasoning handler threw — swallowed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      // Accumulate for the multi-turn roundtrip cache. We bind the
      // accumulator to tool_call_ids when we see them below.
      ctx.reasoningAccumulator += reasoning;
      delete delta.reasoning_content;
      mutated = true;
    } else if (reasoning === null || reasoning === undefined) {
      // Strip null/undefined sibling so the SDK doesn't see it either.
      // (The SDK ignores unknown fields, but this keeps the on-wire
      // shape clean for any downstream consumer that re-parses.)
      if ("reasoning_content" in delta) {
        delete delta.reasoning_content;
        mutated = true;
      }
    }

    // Capture reasoning_content → tool_call_id binding. Tool call deltas
    // carry an `id` only on the first delta for each call; subsequent
    // deltas for the same call (argument continuations) come without
    // the id field. We only store on the id-bearing delta.
    const toolCalls = (delta as { tool_calls?: unknown }).tool_calls;
    if (Array.isArray(toolCalls) && ctx.reasoningAccumulator.length > 0) {
      for (const tc of toolCalls) {
        if (tc && typeof tc === "object" && typeof (tc as { id?: unknown }).id === "string") {
          const id = (tc as { id: string }).id;
          // Same accumulator goes to every tool_call_id in this response —
          // they all share the prior reasoning block per DeepSeek's
          // streaming order (reasoning first, then content/tool_calls).
          reasoningByToolCallId.set(id, ctx.reasoningAccumulator);
        }
      }
    }
  }

  if (!mutated) return event;

  const rewrittenLines = lines.slice();
  rewrittenLines[dataLineIdx] = `data: ${JSON.stringify(parsed)}`;
  return rewrittenLines.join("\n");
}
