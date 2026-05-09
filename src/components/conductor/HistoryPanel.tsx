"use client";

import { useEffect, useMemo } from "react";
import { useConductorStore } from "@/stores/conductor-store";
import type { Actor } from "@/types/conductor";
import { X, User, Robot, Gear, Funnel } from "@phosphor-icons/react";

const ACTOR_LABELS: Record<string, { label: string; icon: typeof User }> = {
  user: { label: "User", icon: User },
  agent: { label: "Agent", icon: Robot },
  system: { label: "System", icon: Gear },
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function HistoryPanel() {
  const {
    activeCanvasId,
    actions,
    actorFilter,
    widgetFilter,
    widgets,
    toggleHistory,
    setActorFilter,
    setWidgetFilter,
  } = useConductorStore();

  const filtered = useMemo(() => {
    return actions.filter((a) => {
      if (actorFilter !== "all" && a.actor !== actorFilter) return false;
      if (widgetFilter && a.widgetId !== widgetFilter) return false;
      return true;
    });
  }, [actions, actorFilter, widgetFilter]);

  return (
    <div className="absolute right-0 top-0 bottom-0 w-[320px] bg-[var(--sidebar-bg)] border-l border-[var(--border)] shadow-xl z-40 flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-[var(--border)]">
        <span className="text-xs font-semibold tracking-wider uppercase text-[var(--muted)]">
          History
        </span>
        <button
          type="button"
          onClick={toggleHistory}
          className="flex items-center justify-center w-6 h-6 rounded-md text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] transition-colors"
        >
          <X size={14} />
        </button>
      </div>

      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-[var(--border)]">
        <Funnel size={12} className="text-[var(--muted)] flex-shrink-0" />
        <div className="flex gap-1">
          {(["all", "user", "agent", "system"] as Array<Actor | "all">).map((actor) => (
            <button
              key={actor}
              type="button"
              onClick={() => setActorFilter(actor)}
              className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                actorFilter === actor
                  ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                  : "text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
              }`}
            >
              {actor === "all" ? "All" : ACTOR_LABELS[actor]?.label || actor}
            </button>
          ))}
        </div>
        {widgets.length > 0 && (
          <select
            value={widgetFilter || ""}
            onChange={(e) => setWidgetFilter(e.target.value || null)}
            className="ml-auto bg-[var(--main-bg)] border border-[var(--border)] rounded text-[10px] text-[var(--text)] px-1.5 py-0.5 outline-none"
          >
            <option value="">All widgets</option>
            {widgets.map((w) => (
              <option key={w.id} value={w.id}>
                {(w.config?.title as string) || w.type}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-full text-xs text-[var(--muted)] py-8">
            No actions recorded
          </div>
        ) : (
          filtered.map((action) => {
            const actorInfo = ACTOR_LABELS[action.actor];
            const ActorIcon = actorInfo?.icon || User;
            const isOTMerged = !!action.mergedFrom;

            return (
              <div
                key={action.id}
                className={`px-3 py-2 border-b border-[var(--border)] transition-colors ${
                  action.undoneAt
                    ? "opacity-40 bg-[var(--error-soft)]"
                    : isOTMerged
                    ? "bg-[var(--warning-soft)]"
                    : ""
                }`}
              >
                <div className="flex items-start gap-2">
                  <ActorIcon size={12} className="text-[var(--muted)] mt-0.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] font-medium text-[var(--text)]">
                        {action.actionType}
                      </span>
                      {isOTMerged && (
                        <span className="text-[9px] px-1 rounded-sm bg-[var(--warning-soft)] text-[var(--warning)] font-medium">
                          OT
                        </span>
                      )}
                      {action.undoneAt && (
                        <span className="text-[9px] px-1 rounded-sm bg-[var(--error-soft)] text-[var(--error)] font-medium">
                          undone
                        </span>
                      )}
                    </div>
                    {action.widgetId && (
                      <div className="text-[10px] text-[var(--muted)] truncate">
                        Widget: {action.widgetId.substring(0, 8)}...
                      </div>
                    )}
                    {action.payload && (
                      <div className="text-[10px] text-[var(--muted)] truncate mt-0.5">
                        {JSON.stringify(action.payload).substring(0, 60)}
                      </div>
                    )}
                    <div className="text-[9px] text-[var(--muted)] opacity-50 mt-0.5">
                      {formatTime(action.ts)}
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
