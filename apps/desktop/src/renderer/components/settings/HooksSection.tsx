"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import {
  SpinnerGapIcon,
  SearchIcon,
  ArrowsClockwiseIcon,
  WebhookIcon,
  XIcon,
  CopyIcon,
  CheckIcon,
  CaretRightIcon,
} from "@/components/icons";
import { SettingsSection, SettingsCard } from "@/components/settings/ui";
import { Switch } from "@/components/ui/Switch";
import { IconButton } from "@/components/ui/IconButton";
import {
  getHookOverview,
  setHookEnabled,
  type HookOverview,
  type HookEventGroup,
  type HookRow,
} from "@/lib/hooks-ipc";
import { useHookTasks } from "@/hooks/useHookTasks";
import { useSettings } from "@/hooks/useSettings";
import type { HookTaskSnapshot, HookTaskStatus } from "@/types/hook-task";

export function HooksSection() {
  const { t } = useTranslation();
  const [data, setData] = useState<HookOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [jsonHook, setJsonHook] = useState<HookRow | null>(null);
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
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

  const toggleHook = useCallback(
    async (hook: HookRow, enabled: boolean) => {
      if (!hook.id || pendingIds.has(hook.id)) return;
      const id = hook.id;
      setPendingIds((prev) => new Set(prev).add(id));
      try {
        const res = await setHookEnabled(id, enabled);
        if (!res.ok) {
          setError(
            res.error ??
              (t("settings.hooks.updateFailed") || "Failed to update hook"),
          );
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setPendingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        load();
      }
    },
    [load, pendingIds, t],
  );

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
        description={
          t("settings.hooks.description") ||
          "View loaded agent hooks, grouped by trigger event. Toggle a hook to disable it in config.toml; click a configured hook to inspect its JSON."
        }
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
              groups.map((group) => (
                <EventGroupCard
                  key={group.event}
                  group={group}
                  pendingIds={pendingIds}
                  onToggle={toggleHook}
                  onOpenJson={setJsonHook}
                />
              ))
            )}
          </>
        )}
      </SettingsSection>

      {jsonHook ? (
        <HookJsonModal hook={jsonHook} onClose={() => setJsonHook(null)} />
      ) : null}

      {/* Plan 437: chat-flow visibility toggle. Keeps the chat history
          quiet for users with many hooks; persisted via the standard
          settings store so the choice survives reload. */}
      <HookChatVisibilityCard />
    </div>
  );
}

/**
 * Small card with the "Show hook invocations in chat" switch. Pulled
 * out so the parent component stays focused on the hook list rendering
 * and the toggle can be reused if other settings pages ever want to
 * surface it.
 */
function HookChatVisibilityCard() {
  const { t } = useTranslation();
  const { settings, save, saving } = useSettings();
  const enabled = settings.showHookInvocations !== false;
  return (
    <SettingsCard className="mt-4">
      <div className="flex items-start gap-3 py-2">
        <WebhookIcon size={16} className="shrink-0 text-muted-foreground mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-foreground">
            {t("settings.hooks.showInChat") || "Show hook invocations in chat"}
          </div>
          <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
            {t("settings.hooks.showInChatDesc") ||
              "Render one row per hook invocation (PreToolUse, PostToolUse, UserPromptSubmit, …) in the message flow. Click a row to expand the additionalContext the hook returned to the agent. Turn this off for a quieter chat log when many hooks are configured."}
          </p>
        </div>
        <Switch
          checked={enabled}
          disabled={saving}
          onCheckedChange={async (checked) => {
            try {
              await save({ showHookInvocations: checked });
            } catch {
              // useSettings already sets `error`; nothing to do here.
            }
          }}
        />
      </div>
    </SettingsCard>
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

interface EventGroupCardProps {
  group: HookEventGroup;
  pendingIds: ReadonlySet<string>;
  onToggle: (hook: HookRow, enabled: boolean) => void;
  onOpenJson: (hook: HookRow) => void;
}

function EventGroupCard({ group, pendingIds, onToggle, onOpenJson }: EventGroupCardProps) {
  const { t } = useTranslation();
  return (
    <SettingsSection title={group.event}>
      <SettingsCard>
        <div className="divide-y divide-border/30">
          {group.hooks.map((hook, i) => {
            const isBuiltin = hook.kind === "builtin";
            const clickable = Boolean(hook.json);
            const checked = hook.enabled ?? true;
            const pending = hook.id ? pendingIds.has(hook.id) : false;
            return (
              <div key={`${hook.kind}-${hook.name}-${i}`} className="py-3">
                <div className="flex items-center gap-2 min-w-0">
                  <button
                    type="button"
                    disabled={!clickable}
                    onClick={() => clickable && onOpenJson(hook)}
                    title={
                      clickable
                        ? t("settings.hooks.viewJson") || "点击查看 JSON 配置"
                        : undefined
                    }
                    className="flex items-center gap-2 min-w-0 flex-1 text-left group disabled:cursor-default"
                  >
                    <WebhookIcon
                      size={13}
                      className={`shrink-0 ${
                        clickable
                          ? "text-muted-foreground/60 group-hover:text-accent"
                          : "text-muted-foreground/60"
                      }`}
                    />
                    <span
                      className={`text-sm font-medium truncate ${
                        clickable ? "group-hover:text-accent" : ""
                      }`}
                    >
                      {hook.name}
                    </span>
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
                    {clickable ? (
                      <CaretRightIcon
                        size={14}
                        className="shrink-0 text-muted-foreground/40 group-hover:text-accent transition-transform group-hover:translate-x-0.5"
                      />
                    ) : null}
                  </button>
                  {hook.id ? (
                    <div className="shrink-0 flex items-center gap-1.5">
                      {pending ? (
                        <SpinnerGapIcon size={14} className="animate-spin text-muted-foreground" />
                      ) : null}
                      <Switch
                        checked={checked}
                        disabled={pending}
                        onCheckedChange={(v) => onToggle(hook, v)}
                        ariaLabel={`${t("settings.hooks.toggle") || "Toggle"} ${hook.name}`}
                      />
                    </div>
                  ) : null}
                </div>
                {hook.command ? (
                  <div
                    className={`mt-1 text-xs font-mono break-all ${
                      clickable
                        ? "text-muted-foreground group-hover:text-foreground"
                        : "text-muted-foreground"
                    }`}
                  >
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

function HookJsonModal({ hook, onClose }: { hook: HookRow; onClose: () => void }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(hook.json ?? "");
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable — ignore.
    }
  }, [hook.json]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-xl border border-border shadow-lg w-full max-w-2xl mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-border flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold truncate">{hook.name}</h2>
            <p className="text-sm text-muted-foreground mt-1 break-all font-mono">
              {hook.source}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={copy}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs font-medium bg-surface border border-border/50 text-muted-foreground hover:text-foreground hover:border-border transition"
            >
              {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
              {copied
                ? t("settings.hooks.copied") || "已复制"
                : t("settings.hooks.copyJson") || "复制 JSON"}
            </button>
            <IconButton variant="ghost" size="sm" aria-label="Close" onClick={onClose}>
              <XIcon size={20} />
            </IconButton>
          </div>
        </div>
        <div className="px-6 py-4 max-h-[60vh] overflow-y-auto">
          <pre className="text-xs font-mono leading-relaxed text-foreground/90 bg-[var(--surface-solid)] rounded-lg p-4 overflow-x-auto whitespace-pre-wrap break-all">
            {hook.json}
          </pre>
        </div>
      </div>
    </div>
  );
}
