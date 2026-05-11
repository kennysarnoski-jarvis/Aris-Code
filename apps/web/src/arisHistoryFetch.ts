/**
 * arisHistoryFetch — fetch Aris chat history from aris_memory.db.
 *
 * Aris-provider threads store their canonical chat content in the ArisLLM
 * backend's sqlite database (aris_memory.db), NOT in state.sqlite's
 * projection_thread_messages. When the web app is rendering an Aris thread it
 * hits this endpoint directly to get the authoritative message list.
 *
 * CORS on the Aris server is wide open (allow_origins="*"), so the browser
 * can call it directly using the signed-in user's session key as the
 * `X-Aris-Key` header.
 */
import { MessageId } from "@t3tools/contracts";

import type { ChatMessage } from "./types";

interface ArisMessageRow {
  readonly id: number;
  readonly role: string;
  readonly content: string | null;
  readonly tool_call_id?: string | null;
  readonly tool_calls_json?: string | null;
  // Persisted Thinking trace for assistant messages (slice 1.13b).
  // Null/missing for non-assistant rows or pre-1.13b history.
  readonly reasoning?: string | null;
  readonly created_at: string;
}

interface ArisMessagesResponse {
  readonly thread_id: string;
  readonly conversation_id: number | null;
  readonly messages: ReadonlyArray<ArisMessageRow>;
}

export interface FetchArisThreadHistoryOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly threadId: string;
  readonly signal?: AbortSignal;
}

/**
 * GET /v1/threads/{thread_id}/messages → ChatMessage[] (oldest first).
 *
 * Filters out `tool` and any empty-content rows — those are machine-only and
 * never surface in the chat timeline.
 */
export async function fetchArisThreadHistory(
  opts: FetchArisThreadHistoryOptions,
): Promise<ChatMessage[]> {
  const trimmedBase = opts.baseUrl.replace(/\/+$/, "");
  const url = `${trimmedBase}/v1/threads/${encodeURIComponent(opts.threadId)}/messages`;

  const res = await fetch(url, {
    method: "GET",
    headers: { "X-Aris-Key": opts.apiKey },
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`Aris history fetch ${res.status}: ${detail.slice(0, 500)}`);
  }

  const data = (await res.json()) as ArisMessagesResponse;
  return data.messages
    .filter(
      (m): m is ArisMessageRow & { content: string } =>
        (m.role === "user" || m.role === "assistant" || m.role === "system") &&
        typeof m.content === "string" &&
        m.content.length > 0,
    )
    .map(
      (m): ChatMessage => ({
        id: MessageId.make(`aris-${m.id}`),
        role: m.role as "user" | "assistant" | "system",
        text: m.content,
        createdAt: normalizeCreatedAt(m.created_at),
        streaming: false,
        // Slice 1.13b: persisted Thinking trace. Only meaningful on
        // assistant rows; user/system rows always have null here.
        ...(typeof m.reasoning === "string" && m.reasoning.length > 0
          ? { reasoning: m.reasoning }
          : {}),
      }),
    );
}

/**
 * aris_db writes created_at as SQLite's default `YYYY-MM-DD HH:MM:SS` (UTC).
 * The rest of the web app expects ISO-8601. Normalize opportunistically and
 * fall back to the raw string if the shape is unexpected.
 */
function normalizeCreatedAt(raw: string): string {
  if (!raw) return new Date(0).toISOString();
  if (raw.includes("T")) return raw;
  const iso = raw.replace(" ", "T") + "Z";
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? raw : new Date(parsed).toISOString();
}
