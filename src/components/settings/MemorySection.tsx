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
import { listMemoryIPC } from "@/lib/ipc-client";
import type { MemoryEntry } from "@/types";

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
        icon={<BrainIcon size={20} />}
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
