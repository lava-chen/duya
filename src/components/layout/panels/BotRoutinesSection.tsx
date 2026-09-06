"use client";

/**
 * BotRoutinesSection — per-bot routines over the cronjob.toml store
 * (Plan 476 P2.3b). Rakazo-style: status-icon rows with a schedule
 * summary line, and an inline editor (name / instruction / schedule
 * card) instead of a modal.
 *
 * Routines bound to a bot fire into the bot's resident session through
 * the wake bus; the editor therefore only exposes the fields a routine
 * needs (name, prompt, schedule) — model/workingDirectory/concurrency
 * stay scheduler defaults. "Test run" fires the routine on demand
 * (Scheduler.runCronNow → manual wake), so its output lands in the bot's
 * conversation, matching rakazo's "runs stream into the thread" model.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useTranslation } from "@/hooks/useTranslation";
import {
  createAutomationCronIPC,
  deleteAutomationCronIPC,
  listAutomationCronsIPC,
  runAutomationCronIPC,
  updateAutomationCronIPC,
} from "@/lib/automation-ipc";
import type { AutomationCron } from "@/types/automation";
import {
  createDefaultScheduleDraft,
  describeScheduleDraft,
  draftToSchedule,
  scheduleToDraft,
  type ScheduleDraft,
} from "@/components/automation/cron-schedule";
import { CronScheduleCard } from "@/components/automation/CronScheduleCard";

type Draft = {
  name: string;
  prompt: string;
  enabled: boolean;
  scheduleDraft: ScheduleDraft;
};

function draftFromCron(cron: AutomationCron): Draft {
  return {
    name: cron.name,
    prompt: cron.prompt,
    enabled: cron.enabled,
    scheduleDraft: scheduleToDraft(cron),
  };
}

const EMPTY_DRAFT: Draft = {
  name: "",
  prompt: "",
  enabled: true,
  scheduleDraft: createDefaultScheduleDraft(),
};

function relativeTime(ts: number | null): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

/** Tiny status glyph — Clock (active) / Pause bars (paused), no icon lib. */
function StatusGlyph({ active }: { active: boolean }) {
  return active ? (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" stroke="var(--success, #22c55e)" strokeWidth="1.4" />
      <path d="M8 4.8V8l2.2 1.6" stroke="var(--success, #22c55e)" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ) : (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="4.4" y="3.6" width="2.4" height="8.8" rx="1" fill="var(--text-muted)" />
      <rect x="9.2" y="3.6" width="2.4" height="8.8" rx="1" fill="var(--text-muted)" />
    </svg>
  );
}

function ActiveToggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className="inline-flex items-center gap-2"
    >
      <span
        className="relative inline-block h-[20px] w-[36px] rounded-full transition-colors"
        style={{ background: checked ? "var(--accent)" : "var(--border)" }}
      >
        <span
          className="absolute top-[2px] h-[16px] w-[16px] rounded-full transition-all"
          style={{ left: checked ? 18 : 2, background: "var(--bg-canvas, #fff)" }}
        />
      </span>
      <span className="text-xs" style={{ color: "var(--text-muted)" }}>
        {label}
      </span>
    </button>
  );
}

export function BotRoutinesSection({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const [crons, setCrons] = useState<AutomationCron[] | null>(null);
  const [editing, setEditing] = useState<AutomationCron | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    try {
      const all = await listAutomationCronsIPC();
      setCrons(all.filter((c) => c.agent === agentId));
      setError("");
    } catch {
      // Dev browser without the Electron preload — hide the section.
      setCrons(null);
    }
  }, [agentId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const openEditor = useCallback((target: AutomationCron | "new") => {
    setDraft(target === "new" ? EMPTY_DRAFT : draftFromCron(target));
    setError("");
    setEditing(target);
  }, []);

  const handleSave = useCallback(async () => {
    if (!editing) return;
    const name = draft.name.trim();
    const prompt = draft.prompt.trim();
    if (!name || !prompt) {
      setError(t("panel.botSettings.routines.errorRequired"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const schedule = draftToSchedule(draft.scheduleDraft);
      if (editing === "new") {
        await createAutomationCronIPC({ name, prompt, schedule, agent: agentId, enabled: draft.enabled });
      } else {
        await updateAutomationCronIPC(editing.id, { name, prompt, schedule, enabled: draft.enabled });
      }
      setEditing(null);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [agentId, draft, editing, reload, t]);

  const handleDelete = useCallback(async () => {
    if (!editing || editing === "new") return;
    setBusy(true);
    setError("");
    try {
      await deleteAutomationCronIPC(editing.id);
      setEditing(null);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [editing, reload]);

  const handleTestRun = useCallback(async () => {
    if (!editing || editing === "new") return;
    setBusy(true);
    setError("");
    try {
      await runAutomationCronIPC(editing.id);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [editing, reload]);

  const sorted = useMemo(
    () => (crons ? [...crons].sort((a, b) => b.createdAt - a.createdAt) : []),
    [crons],
  );

  // Preload unavailable (browser-only dev): keep the section invisible.
  if (crons === null) return null;

  return (
    <div className="mb-5">
      {editing === null ? (
        <>
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-sm font-medium" style={{ color: "var(--text)" }}>
              {t("panel.botSettings.routines.title")}
            </div>
            <Button variant="secondary" size="sm" onClick={() => openEditor("new")}>
              {t("panel.botSettings.routines.new")}
            </Button>
          </div>
          <div className="text-xs mb-2" style={{ color: "var(--text-muted)" }}>
            {t("panel.botSettings.routines.hint")}
          </div>
          {error && (
            <div className="text-xs mb-2" style={{ color: "var(--error, #ef4444)" }}>
              {error}
            </div>
          )}
          {sorted.length === 0 ? (
            <div
              className="rounded-lg px-3 py-4 text-center text-xs"
              style={{ border: "1px dashed var(--border)", color: "var(--text-muted)" }}
            >
              {t("panel.botSettings.routines.empty")}
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {sorted.map((cron) => (
                <button
                  key={cron.id}
                  type="button"
                  onClick={() => openEditor(cron)}
                  className="w-full rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-[var(--surface-hover)]"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <StatusGlyph active={cron.enabled} />
                    <span className="truncate text-sm font-medium" style={{ color: "var(--text)" }}>
                      {cron.name}
                    </span>
                    {cron.lastError && (
                      <span className="ml-auto shrink-0 text-xs" style={{ color: "var(--error, #ef4444)" }}>
                        {t("panel.botSettings.routines.errorState")}
                      </span>
                    )}
                  </div>
                  <div className="truncate pl-[23px] text-xs" style={{ color: "var(--text-muted)" }}>
                    {describeScheduleDraft(scheduleToDraft(cron))}
                    {cron.lastRunAt ? ` · ${t("panel.botSettings.routines.lastRun")} ${relativeTime(cron.lastRunAt)}` : ""}
                  </div>
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="flex items-center justify-between mb-3">
            <ActiveToggle
              checked={draft.enabled}
              onChange={(enabled) => setDraft((d) => ({ ...d, enabled }))}
              label={draft.enabled ? t("panel.botSettings.routines.active") : t("panel.botSettings.routines.paused")}
            />
            <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
              {t("common.cancel")}
            </Button>
          </div>

          <div className="text-sm font-medium mb-1.5" style={{ color: "var(--text)" }}>
            {t("panel.botSettings.routines.nameLabel")}
          </div>
          <Input
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            placeholder={t("panel.botSettings.routines.namePlaceholder")}
            className="w-full mb-3"
          />

          <div className="text-sm font-medium mb-1.5" style={{ color: "var(--text)" }}>
            {t("panel.botSettings.routines.instructionLabel")}
          </div>
          <textarea
            value={draft.prompt}
            onChange={(e) => setDraft((d) => ({ ...d, prompt: e.target.value }))}
            placeholder={t("panel.botSettings.routines.instructionPlaceholder")}
            rows={4}
            className="w-full mb-4 rounded-lg px-3 py-2 text-sm resize-none"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }}
          />

          <div className="text-sm font-medium mb-1.5" style={{ color: "var(--text)" }}>
            {t("panel.botSettings.routines.whenToRun")}
          </div>
          <CronScheduleCard
            value={draft.scheduleDraft}
            onChange={(scheduleDraft) => setDraft((d) => ({ ...d, scheduleDraft }))}
          />
          <div className="mt-2 mb-3 text-xs" style={{ color: "var(--text-muted)" }}>
            {describeScheduleDraft(draft.scheduleDraft)}
          </div>

          {error && (
            <div className="text-xs mb-2" style={{ color: "var(--error, #ef4444)" }}>
              {error}
            </div>
          )}

          <div className="flex items-center justify-between gap-2 mb-1">
            <div className="flex gap-2">
              {editing !== "new" && (
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => void handleTestRun()}>
                  {t("panel.botSettings.routines.testRun")}
                </Button>
              )}
              {editing !== "new" && (
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => void handleDelete()}>
                  {t("panel.botSettings.routines.delete")}
                </Button>
              )}
            </div>
            <Button size="sm" disabled={busy} onClick={() => void handleSave()}>
              {t("bot.edit.save")}
            </Button>
          </div>

          {editing !== "new" && (
            <div className="text-xs mt-2" style={{ color: "var(--text-muted)" }}>
              {t("panel.botSettings.routines.runsHint")}
            </div>
          )}
        </>
      )}
    </div>
  );
}
