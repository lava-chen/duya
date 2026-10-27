// The background tasks panel.
//
// Reference parity (Claude Code desktop, measured 2026-10-20):
//   - background tasks are a leaf pane of the side panel, opened from the
//     launcher row's options menu — not a toggle of the chat's session rail;
//   - live work sits at the top, flat;
//   - finished work collapses into one "已完成 N" group that expands in place;
//   - a card reads "title · kind · status · duration", and the kind decides
//     how much detail the card carries: a command card shows the command,
//     an agent card shows the run and can be opened for its transcript.
//
// The data is the same source the composer chip reads (the bash task
// registry and the agent progress channel), so the panel and the chip can
// never disagree about what is running.

"use client";

import { useMemo, useState } from "react";
import {
  CaretRightIcon,
  TablerRobotIcon,
  TerminalIcon,
} from "@/components/icons";
import { useTranslation } from "@/hooks/useTranslation";
import { useBashTasks } from "@/hooks/useBashTasks";
import { useSubAgentProgress, type SubAgentRowInfo } from "@/hooks/useSubAgentProgress";
import { useConversationStore } from "@/stores/conversation-store";
import { formatElapsed } from "@/lib/format-elapsed";
import { dispatchOpenSessionPanel } from "@/lib/open-session-panel-event";
import type { TranslationKey } from "@/i18n";
import type { BashBackgroundTaskSnapshot, BashTaskStatus } from "@/types";
import type { PageTab } from "./page-tab";

const BASH_STATUS_KEY: Record<BashTaskStatus, TranslationKey> = {
  running: "panel.backgroundTasks.bashRunning",
  completed: "panel.backgroundTasks.bashCompleted",
  killed: "panel.backgroundTasks.bashKilled",
  error: "panel.backgroundTasks.bashFailed",
  disk_limit: "panel.backgroundTasks.bashDiskLimit",
  lost: "panel.backgroundTasks.bashLost",
};

const AGENT_STATUS_KEY: Record<SubAgentRowInfo["status"], TranslationKey> = {
  pending: "subAgent.status.pending",
  running: "subAgent.status.running",
  completed: "subAgent.status.completed",
  failed: "subAgent.status.failed",
  killed: "subAgent.status.killed",
};

function bashElapsed(task: BashBackgroundTaskSnapshot): number {
  if (task.status === "running") {
    return task.lastProgress?.elapsed ?? Date.now() - task.startTime;
  }
  return (task.endTime ?? Date.now()) - task.startTime;
}

function agentElapsed(agent: SubAgentRowInfo): number | null {
  if (agent.startedAt === undefined || agent.endedAt === undefined) return null;
  return Math.max(0, agent.endedAt - agent.startedAt);
}

export function BackgroundTasksPanel(_props: { tab: PageTab; embedded: boolean }) {
  const { t } = useTranslation();
  const activeThreadId = useConversationStore((s) => s.activeThreadId);
  const { tasks } = useBashTasks(activeThreadId);
  const agents = useSubAgentProgress(activeThreadId ?? "");
  const [showFinished, setShowFinished] = useState(false);

  const { liveBash, finishedBash, liveAgents, finishedAgents } = useMemo(() => {
    const liveAgent = (agent: SubAgentRowInfo) => agent.status === "running" || agent.status === "pending";
    return {
      liveBash: tasks.filter((task) => task.status === "running"),
      finishedBash: tasks.filter((task) => task.status !== "running"),
      liveAgents: agents.filter(liveAgent),
      finishedAgents: agents.filter((agent) => !liveAgent(agent)),
    };
  }, [tasks, agents]);

  const finishedCount = finishedBash.length + finishedAgents.length;
  const isEmpty = liveBash.length === 0 && liveAgents.length === 0 && finishedCount === 0;

  const openBashOutput = (task: BashBackgroundTaskSnapshot) => {
    window.dispatchEvent(
      new CustomEvent("duya:open-bash-output-panel", {
        detail: {
          taskId: task.id,
          sessionId: activeThreadId,
          outputFile: task.outputFile,
          command: task.command,
          startTime: task.startTime,
        },
      }),
    );
  };

  const openAgentTranscript = (agent: SubAgentRowInfo) => {
    if (!agent.sessionId) return;
    dispatchOpenSessionPanel(agent.sessionId, agent.name, {
      parentSessionId: activeThreadId ?? undefined,
      taskId: agent.id,
    });
  };

  return (
    <div className="bg-tasks-panel">
      {isEmpty ? (
        <p className="bg-tasks-panel-empty">{t("panel.backgroundTasks.empty")}</p>
      ) : null}

      {liveBash.map((task) => (
        <BashTaskCard key={task.id} task={task} onOpen={() => openBashOutput(task)} />
      ))}
      {liveAgents.map((agent) => (
        <AgentTaskCard
          key={agent.id}
          agent={agent}
          onOpen={() => openAgentTranscript(agent)}
        />
      ))}

      {finishedCount > 0 ? (
        <div className="bg-tasks-group">
          <button
            type="button"
            className="bg-tasks-group-toggle"
            aria-expanded={showFinished}
            onClick={() => setShowFinished((prev) => !prev)}
          >
            <CaretRightIcon
              size={12}
              className={`bg-tasks-group-chevron${showFinished ? " open" : ""}`}
            />
            <span>{t("panel.backgroundTasks.completed", { count: finishedCount })}</span>
          </button>
          {showFinished ? (
            <div className="bg-tasks-group-body">
              {finishedBash.map((task) => (
                <BashTaskCard key={task.id} task={task} onOpen={() => openBashOutput(task)} />
              ))}
              {finishedAgents.map((agent) => (
                <AgentTaskCard
                  key={agent.id}
                  agent={agent}
                  onOpen={() => openAgentTranscript(agent)}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function BashTaskCard({ task, onOpen }: { task: BashBackgroundTaskSnapshot; onOpen: () => void }) {
  const { t } = useTranslation();
  const command = task.command.replace(/\s+/g, " ").trim();
  return (
    <button type="button" className="bg-tasks-card" onClick={onOpen} title={command}>
      <span className="bg-tasks-card-head">
        <TerminalIcon size={12} className="bg-tasks-card-kind-icon" />
        <span className="bg-tasks-card-title">{command}</span>
        <span className="bg-tasks-card-kind">{t("panel.backgroundTasks.kindCommand")}</span>
      </span>
      <span className="bg-tasks-card-meta">
        <span className="bg-tasks-card-status" data-status={task.status}>
          {t(BASH_STATUS_KEY[task.status])}
        </span>
        <span className="bg-tasks-card-duration">{formatElapsed(bashElapsed(task))}</span>
      </span>
    </button>
  );
}

function AgentTaskCard({ agent, onOpen }: { agent: SubAgentRowInfo; onOpen: () => void }) {
  const { t } = useTranslation();
  const elapsed = agentElapsed(agent);
  const canOpen = Boolean(agent.sessionId);
  return (
    <button
      type="button"
      className="bg-tasks-card"
      onClick={onOpen}
      disabled={!canOpen}
      title={canOpen ? agent.name : `${agent.name} is starting`}
    >
      <span className="bg-tasks-card-head">
        <TablerRobotIcon size={12} className="bg-tasks-card-kind-icon" style={{ color: agent.color }} />
        <span className="bg-tasks-card-title">{agent.name}</span>
        <span className="bg-tasks-card-kind">{t("panel.backgroundTasks.kindAgent")}</span>
      </span>
      <span className="bg-tasks-card-meta">
        <span className="bg-tasks-card-status" data-status={agent.status}>
          {t(AGENT_STATUS_KEY[agent.status])}
        </span>
        {elapsed !== null ? (
          <span className="bg-tasks-card-duration">{formatElapsed(elapsed)}</span>
        ) : null}
        {canOpen ? (
          <span className="bg-tasks-card-action">{t("panel.backgroundTasks.viewOutput")}</span>
        ) : null}
      </span>
    </button>
  );
}
