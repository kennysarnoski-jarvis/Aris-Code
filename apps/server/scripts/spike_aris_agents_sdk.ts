#!/usr/bin/env bun
/**
 * Slice 25 — Spike. Proof of concept that the OpenAI Agents SDK can drive
 * a tool-calling turn against `aris_server` (vLLM serving Qwen3.6-FP8).
 *
 * Throwaway code. Not wired into the running app. Run it standalone to
 * confirm the handshake works before committing to the full migration:
 *
 *     # from repo root, with aris_server reachable:
 *     ARIS_BASE_URL="http://38.80.152.148:31946" \
 *     ARIS_API_KEY="<your X-Aris-Key>" \
 *     bun run apps/server/scripts/spike_aris_agents_sdk.ts
 *
 * What this script proves end-to-end:
 *   1. We can configure the SDK's underlying `OpenAI` client to talk to
 *      our aris_server endpoint via custom `defaultHeaders` (X-Aris-Key
 *      auth, not standard Bearer).
 *   2. `OpenAIChatCompletionsModel` works against vLLM/Qwen3.6 (NOT the
 *      Responses API — vLLM doesn't speak Responses).
 *   3. The SDK's agentic loop dispatches a tool call against our locally-
 *      defined Zod-typed `bash` tool and feeds the result back to the
 *      model for a closing reply, all in one `runner.run()` call.
 *   4. Streaming works: we can observe assistant deltas, tool start/end,
 *      and final-message events as they happen.
 *
 * If ANY of those four steps breaks, we find out before committing the
 * larger ArisAdapter refactor (Slices 26-31). Failure mode is plan B:
 * fall back to Vercel AI SDK.
 *
 * The `bash` tool here is intentionally stripped down — no permission
 * gates, no event-bus emission, no PTY. The full client tool suite gets
 * ported in Slice 26 with proper plumbing. This is just the handshake.
 */

import { Agent } from "@openai/agents";
import { OpenAIChatCompletionsModel, setDefaultOpenAIClient } from "@openai/agents-openai";
import OpenAI from "openai";

import type { MessageId, ThreadId, TurnId } from "@t3tools/contracts";

import {
  type ArisAgentEventEmitter,
  runArisAgent,
} from "../src/provider/Layers/ArisAgentRunner.ts";
import { createArisAgentTools } from "../src/provider/Layers/ArisAgentTools.ts";
import { wrapResponseWithEnvelopeInterceptor } from "../src/provider/Layers/ArisStreamInterceptor.ts";

// ── Configuration ───────────────────────────────────────────────────

const BASE_URL = process.env.ARIS_BASE_URL?.replace(/\/+$/, "");
const API_KEY = process.env.ARIS_API_KEY;
const MODEL_NAME = process.env.ARIS_MODEL ?? "qwen3-coder";
const PROJECT_ID = process.env.ARIS_PROJECT_ID
  ? Number.parseInt(process.env.ARIS_PROJECT_ID, 10)
  : undefined;

if (!BASE_URL) {
  console.error("ERROR: ARIS_BASE_URL not set (e.g., http://38.80.152.148:31946)");
  process.exit(1);
}
if (!API_KEY) {
  console.error("ERROR: ARIS_API_KEY not set (the X-Aris-Key value)");
  process.exit(1);
}
if (!PROJECT_ID || Number.isNaN(PROJECT_ID)) {
  console.error("ERROR: ARIS_PROJECT_ID not set (integer — fetch via GET /v1/projects)");
  process.exit(1);
}

const SPIKE_THREAD_ID = `spike-${crypto.randomUUID()}`;

console.log(`[spike] base=${BASE_URL}  model=${MODEL_NAME}`);
console.log(`[spike] auth header = X-Aris-Key (length=${API_KEY.length})`);
console.log(`[spike] project_id=${PROJECT_ID}  thread_id=${SPIKE_THREAD_ID}`);

// ── Custom fetch that injects Aris-specific fields ──────────────────
//
// aris_server's /v1/chat/completions is NOT pure OpenAI-compatible —
// it requires `project_id` and `thread_id` in the body alongside the
// standard `model`/`messages`. The OpenAI Agents SDK builds requests
// internally with no hook for extra body fields, so we wrap `fetch`
// at the OpenAI client layer: parse outgoing chat-completions bodies,
// inject our Aris fields, forward.
//
// Spike-only workaround. The full Slice 26+ migration should make
// aris_server tolerate missing project_id by deriving it server-side
// from the X-Aris-Key + a default project per user.

const arisInjectingFetch = async (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const isChatCompletions = url.includes("/v1/chat/completions");
  let resp: Response;
  if (isChatCompletions && init?.method === "POST" && typeof init.body === "string") {
    try {
      const parsed = JSON.parse(init.body) as Record<string, unknown>;
      parsed.project_id = PROJECT_ID;
      parsed.thread_id = SPIKE_THREAD_ID;
      parsed.conversation_id = null;
      const newInit: RequestInit = { ...init, body: JSON.stringify(parsed) };
      resp = await fetch(input, newInit);
    } catch (err) {
      console.warn(`[spike] body inject failed: ${err instanceof Error ? err.message : err}`);
      resp = await fetch(input, init);
    }
  } else {
    resp = await fetch(input, init);
  }
  // Slice 29 — strip aris envelope frames from the response stream
  // before the SDK consumes them. The interceptor is a no-op on
  // non-streaming responses (no body) and on responses without
  // envelope frames.
  if (isChatCompletions) {
    return wrapResponseWithEnvelopeInterceptor(resp);
  }
  return resp;
};

// ── OpenAI client pointed at aris_server ────────────────────────────
//
// aris_server uses X-Aris-Key, not standard Bearer. We pass a dummy
// `apiKey` to satisfy the OpenAI client constructor (it would refuse
// to construct without one) and override the actual auth via
// defaultHeaders. The dummy gets sent as `Authorization: Bearer ...`
// which aris_server ignores when X-Aris-Key is present.

const client = new OpenAI({
  baseURL: `${BASE_URL}/v1`,
  apiKey: "ignored-by-aris-server",
  defaultHeaders: {
    "X-Aris-Key": API_KEY,
  },
  fetch: arisInjectingFetch,
});

// Make this the default client for all SDK model classes.
setDefaultOpenAIClient(client);

// ── Sanity check: can we reach /v1/models? ─────────────────────────
//
// Optional but cheap. Confirms the auth header + base URL combination
// before we try a streaming tool call. If this 401s or 404s we know
// the issue is connectivity, not the SDK.

console.log("\n[spike] step 1: GET /v1/models …");
try {
  const list = await client.models.list();
  const ids = list.data.map((m) => m.id);
  console.log(`[spike] /v1/models OK — ${ids.length} models: ${ids.join(", ")}`);
  if (!ids.includes(MODEL_NAME)) {
    console.warn(
      `[spike] WARNING: requested model "${MODEL_NAME}" not in /v1/models. ` +
        `If the run fails with model_not_found, set ARIS_MODEL to one of the above.`,
    );
  }
} catch (err) {
  console.error(`[spike] /v1/models FAILED — ${err instanceof Error ? err.message : String(err)}`);
  console.error("[spike] aborting before streaming run; fix connectivity first.");
  process.exit(1);
}

// ── Build the full Aris tool surface (Slice 26) ────────────────────
//
// Replaces the Slice 25 inline single-tool definition. All 7 tools
// (read_file, write_file, edit_file, bash, grep, glob, list_directory)
// come from `ArisAgentTools.createArisAgentTools()` — the same module
// that the production-wired ArisAdapter will use in Slice 27+.
//
// cwd is hardcoded to the t3code repo root for the spike. Production
// will pass `ctx.session.cwd` from the active session.

const SPIKE_CWD = process.env.ARIS_SPIKE_CWD ?? process.cwd();
console.log(`[spike] tool cwd=${SPIKE_CWD}`);

const arisTools = createArisAgentTools({ cwd: SPIKE_CWD });

// ── Define the agent ───────────────────────────────────────────────

const arisAgent = new Agent({
  name: "Aris (spike)",
  instructions:
    "You are Aris in a smoke test. Use the available tools as needed " +
    "to answer the user's question. Reply concisely after gathering enough " +
    "information.",
  model: new OpenAIChatCompletionsModel(client, MODEL_NAME),
  tools: arisTools,
});

// ── Run via ArisAgentRunner (Slice 27) ─────────────────────────────
//
// Replaces the Slice 25/26 inline event consumer with a call to
// `runArisAgent`, which translates SDK stream events into Aris bus
// events. The spike-side emitter just `console.log`s each event in
// order so we can verify the bridge maps correctly:
//
//   - aris.turn.started fires once at the top
//   - aris.assistant.delta fires per text chunk
//   - aris.tool.started / completed bracket each tool invocation
//   - aris.assistant.message.completed fires per finished assistant msg
//   - aris.turn.completed fires once at the bottom
//
// In production the same runner gets a real bus emitter that publishes
// through the WS push channel.

const PROMPT = "Where am I? Use the bash tool to find out.";
console.log(`\n[spike] step 2: running agent with prompt: ${JSON.stringify(PROMPT)}`);
console.log("[spike] aris.* events as they fire:\n");

const consoleEmitter: ArisAgentEventEmitter = {
  publish(event) {
    // Compact the payload for legibility — full assistant.delta payloads
    // would flood the terminal one token at a time.
    const payload = JSON.stringify(event.payload).slice(0, 200);
    console.log(`[event] ${event.type}  ${payload}`);
  },
};

try {
  const result = await runArisAgent({
    agent: arisAgent,
    prompt: PROMPT,
    threadId: SPIKE_THREAD_ID as unknown as ThreadId,
    turnId: `spike-turn-${Date.now()}` as unknown as TurnId,
    userMessageId: `user:${SPIKE_THREAD_ID}` as unknown as MessageId,
    runtimeMode: "full-access",
    emitter: consoleEmitter,
  });

  console.log("\n[spike] === DONE ===");
  console.log(`[spike] final output: ${result.finalOutput ?? "(none)"}`);
  console.log(`[spike] message count: ${result.messageCount}`);
  console.log("\n[spike] ✅ handshake + tool surface + bus bridge work. Slice 27 green.");
  process.exit(0);
} catch (err) {
  console.error(`\n\n[spike] === FAILED ===`);
  console.error(`[spike] error: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) {
    console.error(`[spike] stack:\n${err.stack}`);
  }
  console.error("\n[spike] ❌ handshake broke. Inspect above before continuing.");
  process.exit(2);
}
