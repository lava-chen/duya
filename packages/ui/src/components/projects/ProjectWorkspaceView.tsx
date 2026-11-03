"use client";

import React, { useCallback, useEffect } from "react";
import { ArrowClockwiseIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { ChatView } from "@/components/chat/ChatView";
import { ProjectWorkPanel } from "@/components/projects/ProjectWorkPanel";
import { useProjectWorkspaceStore } from "@/stores/project-workspace-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useTranslation } from "@/hooks/useTranslation";
import type { Message } from "@/types";
import type { FileAttachment } from "@/types/message";
import type { PermissionRequestEvent } from "@/types/stream";

/**
 * ProjectWorkspaceView — the Project-first surface.
 *
 * ## The shape of it
 *
 * The coordinator conversation in the middle, the project's tasks and working
 * sessions beside it. That is the whole product claim of this view: a project
 * is somewhere you TALK (to its coordinator) and somewhere you can SEE what
 * the work is doing — not two separate places the user has to keep in sync.
 *
 * ## The coordinator is a normal conversation
 *
 * The coordinator is a session the project owns, and it is rendered with the
 * ordinary chat view. That is deliberate: the transcript, the composer, the
 * streaming and the permission prompts are all the ones the product already
 * has, so the project view inherits them instead of reimplementing a second
 * transcript that would drift from the first.
 *
 * ## Working sessions are read-only until asked for
 *
 * Opening a working session shows its transcript without taking it over. The
 * user asks for it explicitly, and gives it back explicitly — see
 * {@link ProjectWorkPanel}.
 */

export interface ProjectCoordinatorChatProps {
  sessionId: string;
  messages: Message[];
  onSendMessage: (
    content: string,
    model?: string,
    files?: FileAttachment[],
    agentProfileId?: string | null,
    outputStyleConfig?: { name: string; prompt: string; keepCodingInstructions?: boolean } | null,
    mode?: string,
    effort?: string,
    displayContent?: string,
    queuedMailboxId?: string,
    permissionMode?: "ask" | "auto" | "bypass",
  ) => void;
  onInterrupt?: () => void;
  isStreaming?: boolean;
  isFinalizing?: boolean;
  hostRunActive?: boolean;
  hostSendError?: string | null;
  hostPermission?: PermissionRequestEvent | null;
  onHostPermissionResponse?: (decision: "allow" | "allow_session" | "deny") => void;
  allowPermissionModeChange?: boolean;
  hasQueuedMessages?: boolean;
  onLivePermissionChange?: (mode: "ask" | "auto" | "bypass") => void;
}

export interface ProjectWorkspaceViewProps {
  /** The chat wiring for the coordinator conversation. */
  chat: ProjectCoordinatorChatProps;
}

export function ProjectWorkspaceView({ chat }: ProjectWorkspaceViewProps) {
  const { t } = useTranslation();
  const snapshot = useProjectWorkspaceStore((s) => s.snapshot);
  const loading = useProjectWorkspaceStore((s) => s.loading);
  const error = useProjectWorkspaceStore((s) => s.error);
  const refresh = useProjectWorkspaceStore((s) => s.refresh);
  const acquireLease = useProjectWorkspaceStore((s) => s.acquireLease);
  const setActiveThread = useConversationStore((s) => s.setActiveThread);
  const setCurrentView = useConversationStore((s) => s.setCurrentView);

  // Keep the project's live session states fresh while the view is open: the
  // progress column is the answer to "is anything running right now", and a
  // column that only updates when the user clicks refresh is not an answer.
  useEffect(() => {
    const sessionIds = (useProjectWorkspaceStore.getState().snapshot?.workSessions ?? []).map((s) => s.sessionId);
    if (sessionIds.length === 0) return;
    const timer = window.setInterval(() => {
      void useProjectWorkspaceStore.getState().refreshSessionStatuses(sessionIds);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [snapshot?.observedAt]);

  // A restart lands the user back in the project they were in, with the
  // coordinator conversation restored. The project's own state is in memory
  // only, so it is read again by the app shell — otherwise the panel would be
  // empty next to a conversation about work it cannot show.

  const handleTakeOver = useCallback(
    async (sessionId: string) => {
      const taken = await acquireLease(sessionId);
      if (!taken) return;
      // Taking a session over and opening it are one action: the user asked
      // to work in it, so they land in it.
      await setActiveThread(sessionId);
      setCurrentView("chat");
    },
    [acquireLease, setActiveThread, setCurrentView],
  );

  const handleOpenSession = useCallback(
    async (sessionId: string) => {
      await setActiveThread(sessionId);
      setCurrentView("chat");
    },
    [setActiveThread, setCurrentView],
  );

  return (
    <div className="flex h-full min-h-0 w-full" data-testid="project-workspace-view">
      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className="flex items-center gap-3 px-4 py-2"
          style={{ borderBottom: "1px solid var(--border)" }}
        >
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium" style={{ color: "var(--text)" }}>
              {snapshot?.project.name || t("project.workspace.coordinator")}
            </div>
            <div className="truncate text-xs" style={{ color: "var(--muted)" }} title={snapshot?.project.canonical_root}>
              {snapshot?.project.canonical_root}
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={loading}>
            <ArrowClockwiseIcon size={14} />
            {t("project.workspace.refresh")}
          </Button>
        </header>

        {error && (
          <div
            role="alert"
            className="px-4 py-2 text-sm"
            style={{ backgroundColor: "var(--error-soft)", color: "var(--error)" }}
          >
            {error}
          </div>
        )}

        <div className="min-h-0 flex-1">
          <ChatView
            key={chat.sessionId}
            sessionId={chat.sessionId}
            messages={chat.messages}
            onSendMessage={chat.onSendMessage}
            onInterrupt={chat.onInterrupt}
            isStreaming={chat.isStreaming}
            isFinalizing={chat.isFinalizing}
            hostRunActive={chat.hostRunActive}
            hostSendError={chat.hostSendError}
            hostPermission={chat.hostPermission}
            onHostPermissionResponse={chat.onHostPermissionResponse}
            allowPermissionModeChange={chat.allowPermissionModeChange}
            hasQueuedMessages={chat.hasQueuedMessages}
            onLivePermissionChange={chat.onLivePermissionChange}
          />
        </div>
      </div>

      <ProjectWorkPanel onOpenSession={handleOpenSession} onTakeOver={handleTakeOver} />
    </div>
  );
}
