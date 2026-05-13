/**
 * useArisThreadHistory — React hook that fetches chat history for the
 * Aris-channel providers (Aris and DeepSeek). Each provider has a
 * different persistence store but the hook hides that from callers:
 *
 *   - **Aris** → ArisLLM HTTP API → `aris_memory.db` (graph store)
 *   - **DS**   → local backend WS RPC `aris.archive.read` → `~/.aris/projects/<key>/sessions/<thread>/active.jsonl`
 *
 * Both return `ChatMessage[]` so downstream rendering doesn't branch
 * on provider. Source-of-truth note: `projection_thread_messages` in
 * state.sqlite is NOT used for either provider — Aris-channel threads
 * have authoritative history elsewhere.
 *
 * Refetches whenever:
 *   - threadId changes (thread switch)
 *   - provider flips between Aris-channel providers
 *   - baseUrl / apiKey change (Aris sign-in / sign-out — irrelevant for DS)
 *   - environmentId / cwd change (DS — needed to locate the archive file)
 *   - `refetch()` is called (caller-driven, e.g. on turn completion)
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { EnvironmentId, ThreadId, TurnId } from "@t3tools/contracts";

import { fetchArisThreadHistory } from "./arisHistoryFetch";
import { readEnvironmentApi } from "./environmentApi";
import { resolveEnvironmentHttpUrl } from "./environments/runtime";
import type { ChatMessage } from "./types";

export interface UseArisThreadHistoryOptions {
  readonly threadId: string | null;
  readonly provider: string | null;
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Required for DS history hydration — the archive lives under this path. */
  readonly cwd?: string | null;
  /** Required for DS history hydration — selects the WS RPC client. */
  readonly environmentId?: EnvironmentId | null;
}

export interface UseArisThreadHistoryResult {
  /** `null` until the first fetch resolves (or when the thread is not an Aris-channel thread). */
  readonly messages: ChatMessage[] | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refetch: () => void;
}

export function useArisThreadHistory(
  opts: UseArisThreadHistoryOptions,
): UseArisThreadHistoryResult {
  const { threadId, provider, baseUrl, apiKey, cwd, environmentId } = opts;

  const isArisProvider = provider === "aris";
  const isDeepSeekProvider = provider === "deepseek";

  const arisEnabled =
    isArisProvider && !!threadId && !!baseUrl && typeof apiKey === "string" && apiKey.length > 0;

  const deepseekEnabled =
    isDeepSeekProvider &&
    !!threadId &&
    typeof cwd === "string" &&
    cwd.length > 0 &&
    !!environmentId;

  const enabled = arisEnabled || deepseekEnabled;

  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refetchTick, setRefetchTick] = useState(0);

  // Latest-thread guard — drop results from a previous thread if the user
  // switched during an in-flight fetch.
  const activeThreadIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !threadId) {
      activeThreadIdRef.current = null;
      setMessages(null);
      setLoading(false);
      setError(null);
      return;
    }

    activeThreadIdRef.current = threadId;
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    const fetchPromise: Promise<ChatMessage[]> = arisEnabled
      ? fetchArisThreadHistory({
          baseUrl,
          apiKey,
          threadId,
          signal: controller.signal,
        })
      : (async () => {
          // DS history hydration via WS RPC. Server reads
          // ~/.aris/projects/<key>/sessions/<thread>/active.jsonl
          // and returns ArisArchiveMessage shapes that map cleanly
          // into ChatMessage. No streaming — this is a one-shot read
          // on thread mount; live updates still flow through
          // ArisEventBus separately.
          if (!environmentId || !cwd) return [];
          const api = readEnvironmentApi(environmentId);
          if (!api) return [];
          const result = await api.aris.readArchive({
            threadId: threadId as ThreadId,
            cwd,
          });
          return result.messages.map((m): ChatMessage => {
            // Build the base required-fields object first; conditionally
            // add `turnId` only when present. Under exactOptionalPropertyTypes
            // we can't pass `undefined` for an optional field, so we
            // either include it with a real value (TurnId or null) or
            // omit the key entirely.
            const base: ChatMessage = {
              id: m.id,
              role: m.role,
              text: m.content,
              createdAt: m.createdAt,
              streaming: false,
            };
            if (m.turnId !== null && m.turnId !== undefined) {
              base.turnId = m.turnId as TurnId;
            }
            // 2026-05-13 — Vision: forward image-attachment metadata so
            // the chat-bubble chip survives thread reload. `previewUrl`
            // resolves to the server's `/attachments/<id>` route via
            // the environment's HTTP base — same plumbing
            // `mapMessage` in store.ts uses for Codex/Claude. Built
            // here (not in store.ts) because Aris-channel messages
            // bypass the orchestration projection entirely.
            if (m.attachments && m.attachments.length > 0 && environmentId) {
              base.attachments = m.attachments.map((attachment) => ({
                type: "image" as const,
                id: attachment.id,
                name: attachment.name,
                mimeType: attachment.mimeType,
                sizeBytes: attachment.sizeBytes,
                previewUrl: resolveEnvironmentHttpUrl({
                  environmentId,
                  pathname: `/attachments/${encodeURIComponent(attachment.id)}`,
                }),
              }));
            }
            return base;
          });
        })();

    fetchPromise
      .then((result) => {
        if (activeThreadIdRef.current !== threadId) return;
        setMessages(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (activeThreadIdRef.current !== threadId) return;
        const detail = err instanceof Error ? err.message : String(err);
        setError(detail);
        setLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [enabled, arisEnabled, threadId, baseUrl, apiKey, cwd, environmentId, refetchTick]);

  const refetch = useCallback(() => {
    setRefetchTick((n) => n + 1);
  }, []);

  return { messages, loading, error, refetch };
}
