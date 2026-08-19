"use client";

import { useEffect, useMemo, useState } from "react";
import { useSettings } from "@/hooks/useSettings";
import { useTranslation } from "@/hooks/useTranslation";
import {
  BrainIcon,
  SpinnerGapIcon,
  ArrowUpRightIcon,
} from "@/components/icons";
import { Button } from "@/components/ui/Button";
import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsToggle,
} from "@/components/settings/ui";
import { listMemoryIPC, listMemorySystemLogIPC, type MemorySystemLogEntry } from "@/lib/ipc-client";
import type { MemoryEntry } from "@/types";
import { MemoryRagCard } from "./MemoryRagCard";

interface GroupedEntries {
  you: MemoryEntry[];
  topics: MemoryEntry[];
  areas: MemoryEntry[];
}

function formatMemoryDate(timestamp: number, locale: string): string {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  try {
    return date.toLocaleDateString(locale === "zh" ? "zh-CN" : "en-US", {
      month: "short",
      day: "numeric",
    });
  } catch {
    return date.toLocaleDateString();
  }
}

function truncateDescription(content: string, maxLength = 90): string {
  const trimmed = content.trim();
  const firstLine = trimmed.split(/\r?\n/)[0] ?? "";
  if (firstLine.length <= maxLength) return firstLine;
  return firstLine.slice(0, maxLength).trimEnd() + "…";
}

function titleFromKey(key: string): string {
  const withoutPrefix = key.replace(/^(preference|fact|reference|procedure|person|area):\s*/, "");
  return withoutPrefix.charAt(0).toUpperCase() + withoutPrefix.slice(1);
}

export function MemorySection() {
  const { t, locale } = useTranslation();
  const { settings, loading: settingsLoading, save } = useSettings();

  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const result = await listMemoryIPC();
        if (!cancelled) {
          setEntries(result.entries);
        }
      } catch (err) {
        console.error("Failed to load memory entries:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const grouped = useMemo<GroupedEntries>(() => {
    const groups: GroupedEntries = { you: [], topics: [], areas: [] };
    for (const entry of entries) {
      if (entry.kind === "person") {
        groups.you.push(entry);
      } else if (entry.kind === "area") {
        groups.areas.push(entry);
      } else {
        groups.topics.push(entry);
      }
    }
    return groups;
  }, [entries]);

  const handleToggleMemory = async (checked: boolean) => {
    await save({ memoryEnabled: checked });
  };

  const handleImport = () => {
    // Placeholder: real import flow will be wired here later.
    window.alert(t("settings.memory.importComingSoon"));
  };

  if (settingsLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-12">
        <SpinnerGapIcon size={18} className="animate-spin" />
        <span className="text-sm text-muted-foreground">{t("common.loading")}</span>
      </div>
    );
  }

  return (
    <div className="settings-section">
      <SettingsSection
        title={t("settings.memory.title")}
        description={t("settings.memory.description")}
      >
        <SettingsCard>
          <SettingsToggle
            label={t("settings.memory.generateFromChats")}
            description={t("settings.memory.generateFromChatsDesc")}
            checked={settings?.memoryEnabled ?? false}
            onCheckedChange={handleToggleMemory}
          />
          <SettingsRow
            label={t("settings.memory.importTitle")}
            description={t("settings.memory.importDesc")}
            action={
              <Button variant="secondary" onClick={handleImport}>
                {t("settings.memory.startImport")}
              </Button>
            }
          />
        </SettingsCard>

        <MemoryRagCard />
      </SettingsSection>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-12">
          <SpinnerGapIcon size={18} className="animate-spin" />
          <span className="text-sm text-muted-foreground">{t("common.loading")}</span>
        </div>
      ) : (
        <>
          <MemoryGroup
            title={t("settings.memory.you")}
            entries={grouped.you}
            locale={locale}
          />
          <MemoryGroup
            title={t("settings.memory.topics")}
            entries={grouped.topics}
            locale={locale}
          />
          <MemoryGroup
            title={t("settings.memory.areas")}
            entries={grouped.areas}
            locale={locale}
          />
        </>
      )}

      <ActivityLog />
    </div>
  );
}

function MemoryGroup({
  title,
  entries,
  locale,
}: {
  title: string;
  entries: MemoryEntry[];
  locale: string;
}) {
  const { t } = useTranslation();

  if (entries.length === 0) return null;

  return (
    <SettingsSection title={title}>
      <SettingsCard>
        {entries.map((entry) => {
          const dateLabel = formatMemoryDate(entry.updated_at, locale);
          return (
            <button
              key={entry.memory_id}
              type="button"
              className="w-full flex items-center justify-between text-left py-3.5 hover:bg-muted/30 transition-colors group"
            >
              <div className="flex-1 min-w-0 pr-4">
                <div className="text-sm font-medium text-foreground group-hover:text-accent transition-colors">
                  {titleFromKey(entry.canonical_key)}
                </div>
                <div className="text-sm text-muted-foreground mt-0.5">
                  {truncateDescription(entry.content)}
                </div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className="text-sm text-muted-foreground whitespace-nowrap">
                  {t("settings.memory.updated", { date: dateLabel })}
                </span>
                <ArrowUpRightIcon
                  size={16}
                  className="text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                />
              </div>
            </button>
          );
        })}
      </SettingsCard>
    </SettingsSection>
  );
}

type LogPhaseFilter = "all" | "phase1" | "phase2" | "phase3";

const PHASE_FILTERS: { value: LogPhaseFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "phase1", label: "Phase 1" },
  { value: "phase2", label: "Phase 2" },
  { value: "phase3", label: "Phase 3" },
];

const EVENT_LABELS: Record<string, string> = {
  extract_committed: "Extract committed",
  extract_no_output: "Extract no output",
  extract_skipped: "Extract skipped",
  extract_failed: "Extract failed",
  catalog_sync: "Catalog sync",
  curation_run_started: "Curation started",
  curation_run_succeeded: "Curation succeeded",
  curation_run_failed: "Curation failed",
  curation_run_abandoned: "Curation abandoned",
  curation_file_changed: "File changed",
  curation_policy_updated: "Policy updated",
  // Phase 3 — semantic summary + RAG index refresh
  summary_synthesized: "Summary synthesized",
  summary_synthesis_fallback: "Summary fallback",
  summary_synthesis_failed: "Summary failed",
  rag_index_refreshed: "RAG index refreshed",
  rag_index_refresh_failed: "RAG index refresh failed",
  rag_index_rebuilt_manual: "RAG index rebuilt (manual)",
  // System — retrieval hook events
  rag_hook_retrieved: "RAG hook retrieved",
  rag_hook_no_hits: "RAG hook no hits",
  rag_hook_error: "RAG hook error",
};

function formatLogTime(ts: number, locale: string): string {
  const date = new Date(ts);
  try {
    return date.toLocaleString(locale === "zh" ? "zh-CN" : "en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return date.toLocaleString();
  }
}

function ActivityLog() {
  const { t, locale } = useTranslation();
  const [entries, setEntries] = useState<MemorySystemLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<LogPhaseFilter>("all");

  async function load() {
    setLoading(true);
    try {
      const result = await listMemorySystemLogIPC({
        limit: 150,
        phase: phase === "all" ? undefined : phase,
      });
      setEntries(result.entries);
    } catch (err) {
      console.error("Failed to load memory system log:", err);
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) load();
  }, [open, phase]);

  return (
    <SettingsSection
      title={t("settings.memory.activityTitle")}
      description={t("settings.memory.activityDesc")}
    >
      <SettingsCard>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          {PHASE_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setPhase(f.value)}
              className={`px-3 py-1.5 text-xs rounded-full transition-colors ${
                phase === f.value
                  ? "bg-accent text-accent-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/70"
              }`}
            >
              {f.label}
            </button>
          ))}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setOpen((v) => !v);
              if (!open) load();
            }}
          >
            {open ? t("settings.memory.hideActivity") : t("settings.memory.viewActivity")}
          </Button>
        </div>

        {open && (
          <div className="mt-4">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-8">
                <SpinnerGapIcon size={16} className="animate-spin" />
                <span className="text-sm text-muted-foreground">{t("common.loading")}</span>
              </div>
            ) : entries.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                {t("settings.memory.noActivity")}
              </div>
            ) : (
              <ul className="divide-y divide-border rounded-md border border-border overflow-hidden">
                {entries.map((entry, i) => (
                  <li
                    key={`${entry.ts}-${i}`}
                    className="flex items-start gap-3 px-3 py-2.5 text-sm"
                  >
                    <span
                      className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                        entry.level === "error"
                          ? "bg-destructive"
                          : entry.level === "warn"
                          ? "bg-warning"
                          : entry.phase === "phase2" || entry.phase === "phase3"
                          ? "bg-accent"
                          : "bg-primary/50"
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                          {formatLogTime(entry.ts, locale)}
                        </span>
                        <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                          {entry.phase}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {EVENT_LABELS[entry.event_type] ?? entry.event_type}
                        </span>
                      </div>
                      <div className="mt-0.5 text-foreground break-words">{entry.message}</div>
                      {entry.event_type === "curation_file_changed" && entry.detail && (
                        <div className="mt-1 text-xs text-muted-foreground font-mono break-all">
                          {String(entry.detail.area_path ?? "")}
                          {entry.detail.content_preview
                            ? ` — ${String(entry.detail.content_preview)}`
                            : ""}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}
