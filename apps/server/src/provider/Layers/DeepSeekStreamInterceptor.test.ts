/**
 * DeepSeekStreamInterceptor tests.
 *
 * Covers the three responsibilities of the interceptor:
 *   1. Extract `reasoning_content` deltas via the registered handler.
 *   2. Strip `reasoning_content` from the forwarded chunk so the SDK
 *      only sees standard OpenAI delta fields.
 *   3. Forward everything else (content deltas, usage, [DONE], unknown
 *      shapes, malformed frames) verbatim.
 *
 * Frames are constructed by hand to mirror the exact wire shapes
 * captured during the 2026-05-08 DeepSeek V4 recon (see
 * `project_deepseek_v4_api_recon` memory).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  setDeepSeekReasoningHandler,
  wrapResponseWithReasoningInterceptor,
} from "./DeepSeekStreamInterceptor.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function frame(payload: object | string): string {
  const data = typeof payload === "string" ? payload : JSON.stringify(payload);
  return `data: ${data}\n\n`;
}

function makeStreamingResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ev of events) controller.enqueue(encoder.encode(ev));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function readAll(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let out = "";
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

function parseDataFrames(stream: string): unknown[] {
  const frames: unknown[] = [];
  for (const event of stream.split("\n\n")) {
    if (!event.startsWith("data: ")) continue;
    const payload = event.slice(6).trim();
    if (payload === "" || payload === "[DONE]") continue;
    frames.push(JSON.parse(payload));
  }
  return frames;
}

// ---------------------------------------------------------------------------
// Lifecycle — clear handler between tests so state never leaks.
// ---------------------------------------------------------------------------

beforeEach(() => {
  setDeepSeekReasoningHandler(null);
});

afterEach(() => {
  setDeepSeekReasoningHandler(null);
});

// ---------------------------------------------------------------------------
// reasoning_content extraction + stripping
// ---------------------------------------------------------------------------

describe("wrapResponseWithReasoningInterceptor — reasoning_content", () => {
  it("invokes the handler with each non-empty reasoning_content delta", async () => {
    const captured: string[] = [];
    setDeepSeekReasoningHandler((text) => captured.push(text));

    const wrapped = wrapResponseWithReasoningInterceptor(
      makeStreamingResponse([
        frame({ choices: [{ delta: { content: null, reasoning_content: "Step 1." } }] }),
        frame({ choices: [{ delta: { content: null, reasoning_content: " Step 2." } }] }),
        frame({ choices: [{ delta: { content: "Hello", reasoning_content: null } }] }),
        frame("[DONE]"),
      ]),
    );

    await readAll(wrapped);
    expect(captured).toEqual(["Step 1.", " Step 2."]);
  });

  it("strips reasoning_content from the delta before forwarding", async () => {
    setDeepSeekReasoningHandler(() => undefined);

    const wrapped = wrapResponseWithReasoningInterceptor(
      makeStreamingResponse([
        frame({ choices: [{ delta: { content: null, reasoning_content: "thinking..." } }] }),
        frame("[DONE]"),
      ]),
    );

    const out = await readAll(wrapped);
    const frames = parseDataFrames(out) as Array<{ choices: Array<{ delta: object }> }>;
    expect(frames).toHaveLength(1);
    expect(frames[0]!.choices[0]!.delta).not.toHaveProperty("reasoning_content");
  });

  it("preserves every non-reasoning delta field on the same chunk", async () => {
    setDeepSeekReasoningHandler(() => undefined);

    const wrapped = wrapResponseWithReasoningInterceptor(
      makeStreamingResponse([
        frame({
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: "visible",
                reasoning_content: "hidden",
                tool_calls: [{ index: 0, id: "call_x", type: "function" }],
              },
              finish_reason: null,
            },
          ],
        }),
        frame("[DONE]"),
      ]),
    );

    const out = await readAll(wrapped);
    const [chunk] = parseDataFrames(out) as Array<{
      choices: Array<{ index: number; delta: Record<string, unknown>; finish_reason: null }>;
    }>;
    expect(chunk!.choices[0]!.index).toBe(0);
    expect(chunk!.choices[0]!.finish_reason).toBeNull();
    expect(chunk!.choices[0]!.delta).toEqual({
      role: "assistant",
      content: "visible",
      tool_calls: [{ index: 0, id: "call_x", type: "function" }],
    });
  });

  it("strips a null reasoning_content sibling without invoking the handler", async () => {
    const captured: string[] = [];
    setDeepSeekReasoningHandler((text) => captured.push(text));

    const wrapped = wrapResponseWithReasoningInterceptor(
      makeStreamingResponse([
        frame({ choices: [{ delta: { content: "Hi", reasoning_content: null } }] }),
        frame("[DONE]"),
      ]),
    );

    const out = await readAll(wrapped);
    const [chunk] = parseDataFrames(out) as Array<{ choices: Array<{ delta: object }> }>;
    expect(chunk!.choices[0]!.delta).toEqual({ content: "Hi" });
    expect(captured).toEqual([]);
  });

  it("doesn't crash when no handler is registered", async () => {
    setDeepSeekReasoningHandler(null);

    const wrapped = wrapResponseWithReasoningInterceptor(
      makeStreamingResponse([
        frame({ choices: [{ delta: { reasoning_content: "lonely thought" } }] }),
        frame("[DONE]"),
      ]),
    );

    const out = await readAll(wrapped);
    const [chunk] = parseDataFrames(out) as Array<{ choices: Array<{ delta: object }> }>;
    expect(chunk!.choices[0]!.delta).toEqual({});
  });

  it("swallows handler exceptions — stream continues unaffected", async () => {
    const seenAfter: string[] = [];
    setDeepSeekReasoningHandler((text) => {
      if (text === "boom") throw new Error("handler exploded");
      seenAfter.push(text);
    });

    const wrapped = wrapResponseWithReasoningInterceptor(
      makeStreamingResponse([
        frame({ choices: [{ delta: { reasoning_content: "boom" } }] }),
        frame({ choices: [{ delta: { reasoning_content: "after" } }] }),
        frame({ choices: [{ delta: { content: "ok" } }] }),
        frame("[DONE]"),
      ]),
    );

    const out = await readAll(wrapped);
    expect(seenAfter).toEqual(["after"]);
    expect(out).toContain('"content":"ok"');
    expect(out.endsWith("data: [DONE]\n\n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pass-through — content / usage / unknown shapes / malformed frames
// ---------------------------------------------------------------------------

describe("wrapResponseWithReasoningInterceptor — pass-through", () => {
  it("forwards plain content deltas verbatim", async () => {
    const wrapped = wrapResponseWithReasoningInterceptor(
      makeStreamingResponse([
        frame({ choices: [{ delta: { content: "Hello, " } }] }),
        frame({ choices: [{ delta: { content: "world!" } }] }),
        frame("[DONE]"),
      ]),
    );

    const out = await readAll(wrapped);
    const frames = parseDataFrames(out) as Array<{ choices: Array<{ delta: object }> }>;
    expect(frames).toHaveLength(2);
    expect(frames[0]!.choices[0]!.delta).toEqual({ content: "Hello, " });
    expect(frames[1]!.choices[0]!.delta).toEqual({ content: "world!" });
  });

  it("preserves the trailing usage chunk untouched", async () => {
    const finalChunk = {
      choices: [{ delta: { content: "" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 337,
        completion_tokens: 50,
        total_tokens: 387,
        prompt_tokens_details: { cached_tokens: 256 },
        completion_tokens_details: { reasoning_tokens: 50 },
        prompt_cache_hit_tokens: 256,
        prompt_cache_miss_tokens: 81,
      },
    };

    const wrapped = wrapResponseWithReasoningInterceptor(
      makeStreamingResponse([frame(finalChunk), frame("[DONE]")]),
    );

    const out = await readAll(wrapped);
    const [chunk] = parseDataFrames(out);
    expect(chunk).toEqual(finalChunk);
    expect(out.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  it("forwards [DONE] as the final event", async () => {
    const wrapped = wrapResponseWithReasoningInterceptor(
      makeStreamingResponse([frame({ choices: [{ delta: { content: "x" } }] }), frame("[DONE]")]),
    );
    const out = await readAll(wrapped);
    expect(out.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  it("forwards malformed JSON frames unchanged (the SDK can decide)", async () => {
    const wrapped = wrapResponseWithReasoningInterceptor(
      makeStreamingResponse(["data: {oops not json}\n\n", frame("[DONE]")]),
    );
    const out = await readAll(wrapped);
    expect(out).toContain("data: {oops not json}");
  });

  it("forwards frames without choices unchanged (e.g. server keep-alives)", async () => {
    const keepAlive = { id: "chatcmpl-x", object: "chat.completion.chunk", created: 0 };
    const wrapped = wrapResponseWithReasoningInterceptor(
      makeStreamingResponse([frame(keepAlive), frame("[DONE]")]),
    );
    const out = await readAll(wrapped);
    const [chunk] = parseDataFrames(out);
    expect(chunk).toEqual(keepAlive);
  });

  it("forwards unrelated SSE events (event:, id:) unchanged", async () => {
    const wrapped = wrapResponseWithReasoningInterceptor(
      makeStreamingResponse(["event: ping\ndata: {}\n\n", frame("[DONE]")]),
    );
    const out = await readAll(wrapped);
    expect(out).toContain("event: ping\ndata: {}");
  });
});

// ---------------------------------------------------------------------------
// Stream mechanics — chunk boundaries, multi-choice, response identity
// ---------------------------------------------------------------------------

describe("wrapResponseWithReasoningInterceptor — stream mechanics", () => {
  it("handles SSE events split across multiple read chunks", async () => {
    const captured: string[] = [];
    setDeepSeekReasoningHandler((text) => captured.push(text));

    const fullStream =
      frame({ choices: [{ delta: { reasoning_content: "split-thought" } }] }) +
      frame({ choices: [{ delta: { content: "split-content" } }] }) +
      frame("[DONE]");

    // Slice the stream in three weird places to force the buffer
    // to span chunk boundaries.
    const encoder = new TextEncoder();
    const bytes = encoder.encode(fullStream);
    const a = bytes.slice(0, 25);
    const b = bytes.slice(25, 70);
    const c = bytes.slice(70);

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(a);
        controller.enqueue(b);
        controller.enqueue(c);
        controller.close();
      },
    });

    const wrapped = wrapResponseWithReasoningInterceptor(
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );

    const out = await readAll(wrapped);
    expect(captured).toEqual(["split-thought"]);
    expect(out).toContain('"content":"split-content"');
    expect(out.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  it("processes multiple choices independently within one chunk", async () => {
    const captured: string[] = [];
    setDeepSeekReasoningHandler((text) => captured.push(text));

    const wrapped = wrapResponseWithReasoningInterceptor(
      makeStreamingResponse([
        frame({
          choices: [
            { index: 0, delta: { reasoning_content: "thought-a" } },
            { index: 1, delta: { reasoning_content: "thought-b", content: "visible-b" } },
          ],
        }),
        frame("[DONE]"),
      ]),
    );

    const out = await readAll(wrapped);
    const [chunk] = parseDataFrames(out) as Array<{
      choices: Array<{ index: number; delta: Record<string, unknown> }>;
    }>;
    expect(captured).toEqual(["thought-a", "thought-b"]);
    expect(chunk!.choices[0]!.delta).toEqual({});
    expect(chunk!.choices[1]!.delta).toEqual({ content: "visible-b" });
  });

  it("returns the original Response when there's no body", () => {
    const empty = new Response(null, { status: 204 });
    const wrapped = wrapResponseWithReasoningInterceptor(empty);
    expect(wrapped).toBe(empty);
  });

  it("preserves status, statusText, and headers on the wrapped response", () => {
    const original = new Response("data: {}\n\n", {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "text/event-stream", "x-ds-trace-id": "abc123" },
    });
    const wrapped = wrapResponseWithReasoningInterceptor(original);
    expect(wrapped.status).toBe(200);
    expect(wrapped.statusText).toBe("OK");
    expect(wrapped.headers.get("content-type")).toBe("text/event-stream");
    expect(wrapped.headers.get("x-ds-trace-id")).toBe("abc123");
  });
});

// ---------------------------------------------------------------------------
// Handler lifecycle — set / clear / reset
// ---------------------------------------------------------------------------

describe("setDeepSeekReasoningHandler", () => {
  it("uses the most recently registered handler", async () => {
    const a: string[] = [];
    const b: string[] = [];
    setDeepSeekReasoningHandler((t) => a.push(t));
    setDeepSeekReasoningHandler((t) => b.push(t));

    const wrapped = wrapResponseWithReasoningInterceptor(
      makeStreamingResponse([
        frame({ choices: [{ delta: { reasoning_content: "second-wins" } }] }),
        frame("[DONE]"),
      ]),
    );

    await readAll(wrapped);
    expect(a).toEqual([]);
    expect(b).toEqual(["second-wins"]);
  });

  it("clearing to null disables handler dispatch but still strips the field", async () => {
    const captured: string[] = [];
    setDeepSeekReasoningHandler((t) => captured.push(t));
    setDeepSeekReasoningHandler(null);

    const wrapped = wrapResponseWithReasoningInterceptor(
      makeStreamingResponse([
        frame({ choices: [{ delta: { reasoning_content: "ignored" } }] }),
        frame("[DONE]"),
      ]),
    );

    const out = await readAll(wrapped);
    const [chunk] = parseDataFrames(out) as Array<{ choices: Array<{ delta: object }> }>;
    expect(captured).toEqual([]);
    expect(chunk!.choices[0]!.delta).toEqual({});
  });
});
