/**
 * DeepSeekOpenAIClient tests.
 *
 * Covers:
 *   - URL composition (cloudBaseUrl normalization → cloud trusted-caller
 *     proxy path).
 *   - X-Aris-Key header injection on all requests.
 *   - Per-message reasoning-effort body injection (`light` clears,
 *     `high`/`max` set thinking + reasoning_effort).
 *   - Reasoning-content interceptor wiring on streaming responses.
 *   - Holder lifecycle (set / clear / round-trip).
 *
 * Strategy: stub `fetch` via the OpenAI client's `fetch` option (which
 * the factory wires up). All "network" calls are captured in a recorder
 * so we can assert on URL, headers, and body shape without spinning a
 * real HTTP server.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createDeepSeekOpenAIClient,
  getRequestReasoningEffort,
  setRequestReasoningEffort,
} from "./DeepSeekOpenAIClient.ts";
import { setDeepSeekReasoningHandler } from "./DeepSeekStreamInterceptor.ts";

// ---------------------------------------------------------------------------
// Recorder fetch — captures the resolved url/init that the OpenAI SDK
// sends, then returns a synthetic SSE response so the SDK can finish
// parsing without exploding.
// ---------------------------------------------------------------------------

interface CapturedRequest {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: Record<string, unknown> | string | null;
}

// Use a structural fetch type rather than `typeof fetch` — Bun's
// global `fetch` is augmented with non-standard companions (e.g.
// `preconnect`) we don't implement here. We only need the call
// signature to satisfy globalThis.fetch reassignment.
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function makeRecorder(syntheticBody = `data: [DONE]\n\n`): {
  captured: CapturedRequest[];
  fetchImpl: FetchLike;
} {
  const captured: CapturedRequest[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers;
    if (rawHeaders) {
      // RequestInit headers may arrive as plain object, Headers, or
      // an array of tuples. The OpenAI SDK uses Headers in practice.
      // Cast through `unknown` to bridge the lib-dom / bun-types gap
      // on the global Headers init type.
      const h = new Headers(rawHeaders as unknown as ConstructorParameters<typeof Headers>[0]);
      h.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
    }
    let body: Record<string, unknown> | string | null = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        body = init.body;
      }
    }
    captured.push({
      url,
      method: init?.method,
      headers,
      body,
    });
    return new Response(syntheticBody, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  return { captured, fetchImpl };
}

// We can't easily make the OpenAI SDK call our recorder fetch directly
// because the factory installs its own wrapper around `fetch`. To test
// the wrapper end-to-end, we monkey-patch globalThis.fetch — the
// wrapper delegates to it.

const originalGlobalFetch = globalThis.fetch;

beforeEach(() => {
  setRequestReasoningEffort(undefined);
  setDeepSeekReasoningHandler(null);
});

afterEach(() => {
  setRequestReasoningEffort(undefined);
  setDeepSeekReasoningHandler(null);
  globalThis.fetch = originalGlobalFetch;
});

// ---------------------------------------------------------------------------
// URL composition
// ---------------------------------------------------------------------------

describe("createDeepSeekOpenAIClient — URL composition", () => {
  it("posts chat/completions to the cloud trusted-caller proxy path", async () => {
    const recorder = makeRecorder();
    globalThis.fetch = recorder.fetchImpl as unknown as typeof globalThis.fetch;

    const client = createDeepSeekOpenAIClient({
      cloudBaseUrl: "https://youraris.com",
      cloudToken: "jwt_test_001",
    });

    await client.chat.completions
      .create({
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      })
      .catch(() => undefined);

    expect(recorder.captured).toHaveLength(1);
    expect(recorder.captured[0]!.url).toBe(
      "https://youraris.com/api/local/deepseek/v1/chat/completions",
    );
  });

  it("normalizes a trailing slash on cloudBaseUrl", async () => {
    const recorder = makeRecorder();
    globalThis.fetch = recorder.fetchImpl as unknown as typeof globalThis.fetch;

    const client = createDeepSeekOpenAIClient({
      cloudBaseUrl: "https://youraris.com/",
      cloudToken: "jwt_test_002",
    });

    await client.chat.completions
      .create({
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hi" }],
      })
      .catch(() => undefined);

    expect(recorder.captured[0]!.url).toBe(
      "https://youraris.com/api/local/deepseek/v1/chat/completions",
    );
  });

  it("normalizes multiple trailing slashes on cloudBaseUrl", async () => {
    const recorder = makeRecorder();
    globalThis.fetch = recorder.fetchImpl as unknown as typeof globalThis.fetch;

    const client = createDeepSeekOpenAIClient({
      cloudBaseUrl: "http://localhost:8001///",
      cloudToken: "jwt_dev",
    });

    await client.chat.completions
      .create({ model: "deepseek-v4-pro", messages: [] })
      .catch(() => undefined);

    expect(recorder.captured[0]!.url).toBe(
      "http://localhost:8001/api/local/deepseek/v1/chat/completions",
    );
  });
});

// ---------------------------------------------------------------------------
// Auth header injection
// ---------------------------------------------------------------------------

describe("createDeepSeekOpenAIClient — auth header", () => {
  it("sends the cloud JWT as Authorization: Bearer on every chat/completions request", async () => {
    const recorder = makeRecorder();
    globalThis.fetch = recorder.fetchImpl as unknown as typeof globalThis.fetch;

    const client = createDeepSeekOpenAIClient({
      cloudBaseUrl: "https://youraris.com",
      cloudToken: "jwt_specific_user_session",
    });

    await client.chat.completions
      .create({ model: "deepseek-v4-pro", messages: [] })
      .catch(() => undefined);

    expect(recorder.captured[0]!.headers["authorization"]).toBe("Bearer jwt_specific_user_session");
  });

  it("does not send X-Aris-Key (cloud uses JWT, not the aris_server session key)", async () => {
    const recorder = makeRecorder();
    globalThis.fetch = recorder.fetchImpl as unknown as typeof globalThis.fetch;

    const client = createDeepSeekOpenAIClient({
      cloudBaseUrl: "https://youraris.com",
      cloudToken: "jwt_test_003",
    });

    await client.chat.completions
      .create({ model: "deepseek-v4-pro", messages: [] })
      .catch(() => undefined);

    expect(recorder.captured[0]!.headers["x-aris-key"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Reasoning-effort body injection
// ---------------------------------------------------------------------------

describe("createDeepSeekOpenAIClient — reasoning-effort body injection", () => {
  it("leaves the body alone when no effort is set (cloud default)", async () => {
    const recorder = makeRecorder();
    globalThis.fetch = recorder.fetchImpl as unknown as typeof globalThis.fetch;

    const client = createDeepSeekOpenAIClient({
      cloudBaseUrl: "https://youraris.com",
      cloudToken: "jwt_test",
    });

    await client.chat.completions
      .create({ model: "deepseek-v4-pro", messages: [] })
      .catch(() => undefined);

    const body = recorder.captured[0]!.body as Record<string, unknown>;
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("sets thinking + reasoning_effort='high' when effort is 'high'", async () => {
    const recorder = makeRecorder();
    globalThis.fetch = recorder.fetchImpl as unknown as typeof globalThis.fetch;
    setRequestReasoningEffort("high");

    const client = createDeepSeekOpenAIClient({
      cloudBaseUrl: "https://youraris.com",
      cloudToken: "jwt_test",
    });

    await client.chat.completions
      .create({ model: "deepseek-v4-pro", messages: [] })
      .catch(() => undefined);

    const body = recorder.captured[0]!.body as Record<string, unknown>;
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBe("high");
  });

  it("sets thinking + reasoning_effort='max' when effort is 'max'", async () => {
    const recorder = makeRecorder();
    globalThis.fetch = recorder.fetchImpl as unknown as typeof globalThis.fetch;
    setRequestReasoningEffort("max");

    const client = createDeepSeekOpenAIClient({
      cloudBaseUrl: "https://youraris.com",
      cloudToken: "jwt_test",
    });

    await client.chat.completions
      .create({ model: "deepseek-v4-pro", messages: [] })
      .catch(() => undefined);

    const body = recorder.captured[0]!.body as Record<string, unknown>;
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBe("max");
  });

  it("strips thinking + reasoning_effort when effort is 'light'", async () => {
    const recorder = makeRecorder();
    globalThis.fetch = recorder.fetchImpl as unknown as typeof globalThis.fetch;
    setRequestReasoningEffort("light");

    const client = createDeepSeekOpenAIClient({
      cloudBaseUrl: "https://youraris.com",
      cloudToken: "jwt_test",
    });

    await client.chat.completions
      .create({ model: "deepseek-v4-pro", messages: [] })
      .catch(() => undefined);

    const body = recorder.captured[0]!.body as Record<string, unknown>;
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("preserves the other request fields (model, messages, stream)", async () => {
    const recorder = makeRecorder();
    globalThis.fetch = recorder.fetchImpl as unknown as typeof globalThis.fetch;
    setRequestReasoningEffort("high");

    const client = createDeepSeekOpenAIClient({
      cloudBaseUrl: "https://youraris.com",
      cloudToken: "jwt_test",
    });

    await client.chat.completions
      .create({
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "what is 2+2?" }],
        stream: true,
        temperature: 0.5,
      })
      .catch(() => undefined);

    const body = recorder.captured[0]!.body as Record<string, unknown>;
    expect(body.model).toBe("deepseek-v4-pro");
    expect(body.messages).toEqual([{ role: "user", content: "what is 2+2?" }]);
    expect(body.stream).toBe(true);
    expect(body.temperature).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// Reasoning interceptor wiring
// ---------------------------------------------------------------------------

describe("createDeepSeekOpenAIClient — reasoning interceptor wiring", () => {
  it("routes reasoning_content deltas through the registered handler", async () => {
    const captured: string[] = [];
    setDeepSeekReasoningHandler((text) => captured.push(text));

    const sse =
      `data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}\n\n` +
      `data: {"choices":[{"delta":{"content":"hello"}}]}\n\n` +
      `data: [DONE]\n\n`;

    const recorder = makeRecorder(sse);
    globalThis.fetch = recorder.fetchImpl as unknown as typeof globalThis.fetch;

    const client = createDeepSeekOpenAIClient({
      cloudBaseUrl: "https://youraris.com",
      cloudToken: "jwt_test",
    });

    const stream = await client.chat.completions.create({
      model: "deepseek-v4-pro",
      messages: [],
      stream: true,
    });

    // Drain the stream — the SDK wraps our response and processes
    // chunks through the reasoning interceptor as they pass through.
    for await (const _chunk of stream) {
      // No-op; we just need the pipeline to consume the stream.
    }

    expect(captured).toEqual(["thinking..."]);
  });
});

// ---------------------------------------------------------------------------
// Holder lifecycle
// ---------------------------------------------------------------------------

describe("setRequestReasoningEffort / getRequestReasoningEffort", () => {
  it("round-trips a set value", () => {
    setRequestReasoningEffort("high");
    expect(getRequestReasoningEffort()).toBe("high");
  });

  it("clears with undefined", () => {
    setRequestReasoningEffort("max");
    setRequestReasoningEffort(undefined);
    expect(getRequestReasoningEffort()).toBeUndefined();
  });

  it("most recent setter wins", () => {
    setRequestReasoningEffort("high");
    setRequestReasoningEffort("light");
    expect(getRequestReasoningEffort()).toBe("light");
  });
});
