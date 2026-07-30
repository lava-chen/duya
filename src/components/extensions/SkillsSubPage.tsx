"use client";

import { useMemo } from "react";
import { Switch } from "@/components/ui/Switch";
import { useTranslation } from "@/hooks/useTranslation";
import { cn } from "@/lib/utils";

interface SkillSummary {
  name: string;
  description: string;
  category?: string;
  source?: string;
  enabled?: boolean;
  updatedAt?: string;
}

interface SkillsSubPageProps {
  skills: SkillSummary[];
  searchQuery: string;
  onSkillClick: (skill: SkillSummary) => void;
  onToggleEnabled: (skillName: string, enabled: boolean) => void;
}

function formatDateLabel(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString();
}

export function SkillsSubPage({
  skills,
  searchQuery,
  onSkillClick,
  onToggleEnabled,
}: SkillsSubPageProps) {
  const { t } = useTranslation();

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return skills;
    const q = searchQuery.toLowerCase();
    return skills.filter(
      (s) =>
        s.name?.toLowerCase().includes(q) ||
        s.description?.toLowerCase().includes(q)
    );
  }, [skills, searchQuery]);

  if (skills.length === 0) {
    return (
      <div className="rounded-xl border border-border/40 bg-[var(--surface)] px-4 py-12 text-center">
        <p className="text-sm text-muted-foreground">
          {t("extensions.empty.skills" as never)}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border/40 bg-[var(--surface)] overflow-hidden">
      {/* Header */}
      <div
        className="grid items-center gap-4 px-4 py-2 text-xs font-medium text-muted-foreground border-b border-border/30"
        style={{ gridTemplateColumns: "160px 1fr 120px 80px" }}
      >
        <div>{t("extensions.skills.table.name")}</div>
        <div>{t("extensions.skills.table.description")}</div>
        <div>{t("extensions.skills.table.updated")}</div>
        <div className="text-right">{t("extensions.skills.table.enabled")}</div>
      </div>

      {/* Rows */}
      {filtered.map((skill) => {
        const isEnabled = skill.enabled !== false;
        return (
          <div
            key={skill.name}
            className={cn(
              "grid items-center gap-4 px-4 py-3 text-sm border-b border-border/20 transition-colors last:border-b-0",
              "hover:bg-[var(--surface-hover)]"
            )}
            style={{ gridTemplateColumns: "160px 1fr 120px 80px" }}
          >
            <button
              type="button"
              onClick={() => onSkillClick(skill)}
              className="text-left font-medium text-foreground hover:text-accent truncate"
              title={skill.name}
            >
              {skill.name}
            </button>
            <div
              className="truncate text-muted-foreground"
              title={skill.description}
            >
              {skill.description}
            </div>
            <div className="text-muted-foreground text-xs">
              {formatDateLabel(skill.updatedAt)}
            </div>
            <div className="flex justify-end">
              <Switch
                checked={isEnabled}
                ariaLabel={isEnabled ? t("extensions.actions.disable") : t("extensions.actions.enable")}
                onCheckedChange={() => onToggleEnabled(skill.name, !isEnabled)}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export type { SkillSummary };