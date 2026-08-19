"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import { SpinnerGapIcon, SearchIcon, ArrowsClockwiseIcon, WebhookIcon } from "@/components/icons";
import { SettingsSection, SettingsCard } from "@/components/settings/ui";
import { getHookOverview, type HookOverview, type HookEventGroup } from "@/lib/hooks-ipc";
import { useHookTasks } from "@/hooks/useHookTasks";
import type { HookTaskSnapshot, HookTaskStatus } from "@/types/hook-task";

export function HooksSection() {
  const { t } = useTranslation();
  const [data, setData] = useState<HookOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const { tasks } = useHookTasks(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await getHookOverview());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const groups = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    if (!q) return data.events;
    return data.events
      .map((group) => ({
        ...group,
        hooks: group.hooks.filter(
          (h) =>
            h.name.toLowerCase().includes(q) ||
            h.command.toLowerCase().includes(q) ||
            h.source.toLowerCase().includes(q)
        ),
      }))
      .filter((g) => g.hooks.length > 0 || g.event.toLowerCase().includes(q));
  }, [data, query]);

  return (
    <div className="settings-section">
      <SettingsSection
        title={t("settings.hooks") || "Hooks"}
        description={t("settings.hooks.description") || "View loaded agent hooks, grouped by trigger event."}
      >
        {/* Search + refresh toolbar, below the section title */}
        <div className="flex items-center gap-2 mb-4">
          <div className="relative flex-1 min-w-0">
            <SearchIcon
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("settings.hooks.search") || "搜索 hook 名称、命令或来源"}
              className="w-full h-9 rounded-lg bg-surface border border-border/50 pl-9 pr-4 text-sm text-foreground placeholder:text-muted-foreground/70 outline-none focus:border-accent/60 focus:ring-1 focus:ring-accent/20"
            />
          </div>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            title={t("settings.hooks.refresh") || "刷新"}
            className="shrink-0 w-9 h-9 rounded-lg bg-surface border border-border/50 text-muted-foreground hover:text-foreground hover:border-border inline-flex items-center justify-center transition disabled:opacity-60"
          >
            {loading ? (
              <SpinnerGapIcon size={16} className="animate-spin" />
            ) : (
              <ArrowsClockwiseIcon size={16} />
            )}
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12">
            <SpinnerGapIcon size={18} className="animate-spin" />
            <span className="text-sm text-muted-foreground">{t("common.loading")}</span>
          </div>
        ) : error ? (
          <p className="text-sm text-red-400 py-4 text-center">{error}</p>
        ) : (
          <>
            <HookTaskList tasks={tasks} />
            {groups.length === 0 ? (
              <SettingsCard>
                <p className="py-6 text-center text-sm text-muted-foreground">
                  {query
                    ? t("settings.hooks.noResults") || "没有匹配的 hook。"
                    : t("settings.hooks.empty") || "No hooks loaded."}
                </p>
              </SettingsCard>
            ) : (
              groups.map((group) => <EventGroupCard key={group.event} group={group} />)
            )}
          </>
        )}
      </SettingsSection>
    </div>
  );
}

function HookTaskList({ tasks }: { tasks: HookTaskSnapshot[] }) {
  const { t } = useTranslation();
  if (tasks.length === 0) return null;
  const statusLabel: Record<HookTaskStatus, string> = {
    running: "运行中",
    completed: "已完成",
    killed: "已终止",
    error: "失败",
  };
  const statusColor: Record<HookTaskStatus, string> = {
    running: "text-blue-400",
    completed: "text-emerald-500",
    killed: "text-amber-500",
    error: "text-red-400",
  };
  return (
    <SettingsSection title={t("settings.hooks.backgroundTasks") || "后台 Hook 任务"}>
      <SettingsCard>
        <div className="divide-y divide-border/30">
          {tasks.map((task) => (
            <div key={task.id} className="py-3">
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-accent/10 font-mono ${statusColor[task.status]}`}
                >
                  {statusLabel[task.status]}
                </span>
                <span className="text-sm font-medium text-foreground truncate">
                  {task.event}
                </span>
                <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">
                  {task.hookType}
                  {task.rewake ? " · 通知模型" : ""}
                </span>
              </div>
              <div className="mt-1 text-xs font-mono text-muted-foreground break-all">
                {task.command}
              </div>
              {task.exitCode !== undefined ? (
                <div className="mt-1 text-[11px] text-muted-foreground/70">
                  exit {task.exitCode}
                  {task.error ? ` — ${task.error}` : ""}
                </div>
              ) : null}
              <div className="mt-1 text-[11px] font-mono text-muted-foreground/50 break-all">
                {task.outputFile}
              </div>
            </div>
          ))}
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}

function EventGroupCard({ group }: { group: HookEventGroup }) {
  const { t } = useTranslation();
  return (
    <SettingsSection title={group.event}>
      <SettingsCard>
        <div className="divide-y divide-border/30">
          {group.hooks.map((hook, i) => {
            const isBuiltin = hook.kind === "builtin";
            return (
              <div key={`${hook.kind}-${hook.name}-${i}`} className="py-3">
                <div className="flex items-center gap-2 min-w-0">
                  <WebhookIcon size={13} className="shrink-0 text-muted-foreground/60" />
                  <span className="text-sm font-medium text-foreground truncate">{hook.name}</span>
                  <span
                    className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded ${
                      isBuiltin
                        ? "bg-accent/10 text-accent"
                        : "bg-emerald-500/10 text-emerald-500"
                    }`}
                  >
                    {isBuiltin ? "内置" : "配置"}
                  </span>
                  <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent font-mono">
                    {hook.matcher ? hook.matcher : t("settings.hooks.matchAll") || "匹配全部"}
                  </span>
                </div>
                {hook.command ? (
                  <div className="mt-1 text-xs font-mono text-muted-foreground break-all">
                    {hook.command}
                  </div>
                ) : null}
                <div className="mt-1 text-[11px] text-muted-foreground/70 break-all">
                  {hook.source}
                </div>
              </div>
            );
          })}
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}