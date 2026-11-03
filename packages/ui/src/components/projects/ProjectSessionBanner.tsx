"use client";

import React, { useCallback, useEffect, useMemo } from "react";
import { ArrowLeftIcon, HandIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { useProjectWorkspaceStore, isLocalUserLease } from "@/stores/project-workspace-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useTranslation } from "@/hooks/useTranslation";

/**
 * ProjectSessionBanner — the strip above a working session opened from a
 * project.
 *
 * ## What it says
 *
 * Two facts, and they are the whole contract of the takeover:
 *
 *   - **Read-only**: the session belongs to the project, and merely LOOKING
 *     at it does not take it away from the Coordinator. The composer is
 *     closed.
 *   - **Holding**: the user took the session over, so the Coordinator cannot
 *     send it a new instruction until the session is handed back.
 *
 * ## Why the lease is the authority
 *
 * The banner does not decide who may direct the session — the Host's lease
 * does. The banner asks the Host and renders the answer, so a session that
 * another client already holds is shown as held rather than silently taken.
 */
export function ProjectSessionBanner({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const snapshot = useProjectWorkspaceStore((s) => s.snapshot);
  const leases = useProjectWorkspaceStore((s) => s.leases);
  const readLease = useProjectWorkspaceStore((s) => s.readLease);
  const acquireLease = useProjectWorkspaceStore((s) => s.acquireLease);
  const releaseLease = useProjectWorkspaceStore((s) => s.releaseLease);
  const setActiveThread = useConversationStore((s) => s.setActiveThread);
  const setCurrentView = useConversationStore((s) => s.setCurrentView);

  const isProjectSession = useMemo(
    () => (snapshot?.workSessions ?? []).some((s) => s.sessionId === sessionId),
    [snapshot, sessionId],
  );
  const coordinatorSessionId = snapshot?.coordinatorSessionId ?? null;
  const lease = leases[sessionId];
  // Only the LOCAL user's lease means the user holds the session. A lease held
  // by another holder is somebody else's, and the banner must not report it
  // as the user's own.
  const holding = isLocalUserLease(lease);

  // The lease can be held by another client, so the banner asks the Host
  // rather than trusting what this renderer remembers.
  useEffect(() => {
    if (!isProjectSession) return;
    void readLease(sessionId);
  }, [isProjectSession, readLease, sessionId]);

  const handleTakeOver = useCallback(async () => {
    await acquireLease(sessionId);
  }, [acquireLease, sessionId]);

  const handleHandBack = useCallback(async () => {
    await releaseLease(sessionId);
  }, [releaseLease, sessionId]);

  const handleBackToProject = useCallback(async () => {
    if (coordinatorSessionId) {
      await setActiveThread(coordinatorSessionId);
    }
    setCurrentView("project");
  }, [coordinatorSessionId, setActiveThread, setCurrentView]);

  if (!isProjectSession) return null;

  return (
    <div
      data-testid="project-session-banner"
      className="mx-4 mt-2 flex items-center gap-3 rounded-lg border px-3 py-2 text-sm"
      style={{
        backgroundColor: holding ? "var(--accent-soft, var(--surface-hover))" : "var(--surface)",
        borderColor: "var(--border)",
        color: "var(--text)",
      }}
    >
      <span className="min-w-0 flex-1">
        {holding ? t("project.workspace.holdingHint") : t("project.workspace.readOnlyHint")}
      </span>
      {holding ? (
        <Button variant="ghost" size="sm" onClick={() => void handleHandBack()}>
          {t("project.workspace.handBack")}
        </Button>
      ) : (
        <Button variant="ghost" size="sm" onClick={() => void handleTakeOver()}>
          <HandIcon size={12} />
          {t("project.workspace.takeOver")}
        </Button>
      )}
      <Button variant="ghost" size="sm" onClick={() => void handleBackToProject()}>
        <ArrowLeftIcon size={12} />
        {t("project.workspace.backToProject")}
      </Button>
    </div>
  );
}
