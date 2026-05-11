import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef } from "react";
import ChatView from "../components/ChatView";
import { threadHasStarted } from "../components/ChatView.logic";
import { useComposerDraftStore, DraftId } from "../composerDraftStore";
import { SidebarInset } from "../components/ui/sidebar";
import { createThreadSelectorAcrossEnvironments } from "../storeSelectors";
import { useStore } from "../store";
import { buildThreadRouteParams } from "../threadRoutes";

function DraftChatThreadRouteView() {
  const navigate = useNavigate();
  const { draftId: rawDraftId } = Route.useParams();
  const draftId = DraftId.make(rawDraftId);
  const draftSession = useComposerDraftStore((store) => store.getDraftSession(draftId));
  // Provider this draft will dispatch to. Used below to relax the
  // `serverThreadStarted` gate for Aris (whose messages live in
  // aris_memory.db, not the orchestration projection).
  const draftActiveProvider = useComposerDraftStore(
    (store) => store.getComposerDraft(draftId)?.activeProvider ?? null,
  );
  const serverThread = useStore(
    useMemo(
      () => createThreadSelectorAcrossEnvironments(draftSession?.threadId ?? null),
      [draftSession?.threadId],
    ),
  );
  const serverThreadStarted = threadHasStarted(serverThread);
  const canonicalThreadRef = useMemo(() => {
    if (draftSession?.promotedTo) {
      // Aris stores chat content in aris_memory.db rather than the
      // orchestration projection, so `threadHasStarted` (which gates on
      // latestTurn / messages / session populating in state.sqlite) never
      // returns true for Aris drafts at promotion time. Promotion alone
      // is sufficient — the canonical chat view fetches Aris messages
      // directly via `useArisThreadHistory`. For other providers we keep
      // the started gate so the user doesn't land on a half-projected
      // thread URL with an empty chat.
      const providerSkipsStartedGate = draftActiveProvider === "aris";
      if (providerSkipsStartedGate || serverThreadStarted) {
        return draftSession.promotedTo;
      }
      return null;
    }
    return serverThread
      ? {
          environmentId: serverThread.environmentId,
          threadId: serverThread.id,
        }
      : null;
  }, [draftSession?.promotedTo, draftActiveProvider, serverThread, serverThreadStarted]);

  // Single redirect-decision guard shared between both useEffects below.
  //
  // The draft route's job is to issue exactly one redirect per mounted
  // draftId — either to the canonical thread URL (when promotion lands) or
  // to "/" (when the draft is abandoned). After that decision is made the
  // component is on its way out and should not issue further navigations.
  //
  // Without this guard, mid-route-transition state churn can fire either
  // navigate twice — the composer draft store recreates its selected slice
  // on every tick, and during the router's commit phase `draftSession` /
  // `canonicalThreadRef` can flicker through null. Two competing navigates
  // (one to the thread URL, one to "/") then produce the runaway
  // `RouterCore.commitLocation` loop that blows React's update depth.
  //
  // Tracking by draftId (rather than a plain bool) means the guard auto-
  // resets if the same component instance ever sees a different draftId.
  const redirectedFromDraftRef = useRef<DraftId | null>(null);

  useEffect(() => {
    if (redirectedFromDraftRef.current === draftId) {
      return;
    }
    if (!canonicalThreadRef) {
      return;
    }
    redirectedFromDraftRef.current = draftId;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(canonicalThreadRef),
      replace: true,
    });
  }, [draftId, canonicalThreadRef, navigate]);

  useEffect(() => {
    if (redirectedFromDraftRef.current === draftId) {
      return;
    }
    if (draftSession || canonicalThreadRef) {
      return;
    }
    redirectedFromDraftRef.current = draftId;
    void navigate({ to: "/", replace: true });
  }, [draftId, canonicalThreadRef, draftSession, navigate]);

  if (canonicalThreadRef) {
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
        <ChatView
          environmentId={canonicalThreadRef.environmentId}
          threadId={canonicalThreadRef.threadId}
          routeKind="server"
        />
      </SidebarInset>
    );
  }

  if (!draftSession) {
    return null;
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <ChatView
        draftId={draftId}
        environmentId={draftSession.environmentId}
        threadId={draftSession.threadId}
        routeKind="draft"
      />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/draft/$draftId")({
  component: DraftChatThreadRouteView,
});
