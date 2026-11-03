"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { HostWorktreeCleanupResult } from "@duya/agent-protocol";
import { useTranslation } from "@/hooks/useTranslation";
import {
  SettingsSection,
  SettingsCard,
  SettingsCardFooter,
  SettingsInput,
  SettingsInputRow,
  SettingsToggle,
} from "@/components/settings/ui";
import { SpinnerGapIcon, FolderIcon, TrashIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import {
  getConfigValue,
  setConfig,
  subscribeConfigUpdates,
} from "@/lib/config-port-bus";
import { cleanupCheckouts } from "@/lib/workspace-lifecycle-ipc";

/** Mirrors the Host's reader: absent / empty means the default root. */
const DEFAULT_KEEP_COUNT = 15;
const MAX_KEEP_COUNT = 1000;
/** How long the "confirm cleanup" arm stays live. */
const CONFIRM_TIMEOUT_MS = 5000;

/**
 * Whether the renderer can write config at all.
 *
 * The browser surface has no Electron bridge, so both the location and the
 * cleanup controls are read-only there — a disabled control with an
 * explanation, not a control that silently does nothing.
 */
function hasConfigPort(): boolean {
  return typeof window !== "undefined" && typeof window.electronAPI?.getConfigPort === "function";
}

/**
 * Windows drive paths, UNC paths, and POSIX paths. The Host is the
 * authority (it resolves with `path.isAbsolute`); this only avoids sending a
 * write the Host would reject.
 */
function isAbsolutePath(value: string): boolean {
  return /^([A-Za-z]:[\\/]|\\\\|\/)/.test(value);
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readKeepCount(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_KEEP_COUNT
    ? value
    : DEFAULT_KEEP_COUNT;
}

export function WorktreesSection() {
  const { t } = useTranslation();
  const available = hasConfigPort();

  const [savedRoot, setSavedRoot] = useState("");
  const [draftRoot, setDraftRoot] = useState("");
  const [rootError, setRootError] = useState<string | null>(null);

  const [autoCleanup, setAutoCleanup] = useState(false);
  const [keepCount, setKeepCount] = useState(DEFAULT_KEEP_COUNT);
  const [keepCountDraft, setKeepCountDraft] = useState(String(DEFAULT_KEEP_COUNT));
  const [keepCountError, setKeepCountError] = useState<string | null>(null);

  const [confirmArmed, setConfirmArmed] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<HostWorktreeCleanupResult | null>(null);
  const [cleanupError, setCleanupError] = useState<string | null>(null);
  const confirmTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!available) return;
    let cancelled = false;

    // Only the committed value follows config broadcasts; the draft belongs
    // to the user and must survive an unrelated settings write.
    const apply = (config: Record<string, unknown>): void => {
      if (cancelled) return;
      setSavedRoot(readString(config.worktreeRoot, ""));
      setAutoCleanup(readBoolean(config.worktreeAutoCleanupEnabled, false));
      const nextKeepCount = readKeepCount(config.worktreeKeepCount);
      setKeepCount(nextKeepCount);
      setKeepCountDraft(String(nextKeepCount));
    };

    const unsubscribe = subscribeConfigUpdates(apply);

    // The ConfigStore pushes a full snapshot on port registration, so this
    // is a fallback for a late-mounting page rather than the only read.
    void Promise.all([
      getConfigValue("worktreeRoot"),
      getConfigValue("worktreeAutoCleanupEnabled"),
      getConfigValue("worktreeKeepCount"),
    ]).then(([root, enabled, keep]) => {
      if (cancelled) return;
      const nextRoot = readString(root, "");
      setSavedRoot(nextRoot);
      setDraftRoot(nextRoot);
      setAutoCleanup(readBoolean(enabled, false));
      const nextKeepCount = readKeepCount(keep);
      setKeepCount(nextKeepCount);
      setKeepCountDraft(String(nextKeepCount));
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [available]);

  useEffect(
    () => () => {
      if (confirmTimer.current !== undefined) window.clearTimeout(confirmTimer.current);
    },
    [],
  );

  const saveRoot = useCallback(() => {
    const trimmed = draftRoot.trim();
    if (trimmed !== "" && !isAbsolutePath(trimmed)) {
      setRootError(t("settings.worktrees.invalidPath"));
      return;
    }
    setRootError(null);
    setConfig("worktreeRoot", trimmed);
    setSavedRoot(trimmed);
    setDraftRoot(trimmed);
  }, [draftRoot, t]);

  const resetRoot = useCallback(() => {
    setRootError(null);
    setConfig("worktreeRoot", "");
    setSavedRoot("");
    setDraftRoot("");
  }, []);

  const browseRoot = useCallback(async () => {
    const picker = window.electronAPI?.dialog?.openFolder;
    if (!picker) return;
    const result = await picker({
      title: t("settings.worktrees.location"),
      defaultPath: draftRoot.trim() || undefined,
    });
    if (!result.canceled && result.filePaths[0]) {
      setDraftRoot(result.filePaths[0]);
      setRootError(null);
    }
  }, [draftRoot, t]);

  const toggleCleanup = useCallback((checked: boolean) => {
    setAutoCleanup(checked);
    setConfig("worktreeAutoCleanupEnabled", checked);
  }, []);

  const applyKeepCount = useCallback(() => {
    const parsed = Number(keepCountDraft.trim());
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_KEEP_COUNT) {
      setKeepCountError(t("settings.worktrees.keepCountInvalid"));
      return;
    }
    setKeepCountError(null);
    setKeepCount(parsed);
    setKeepCountDraft(String(parsed));
    setConfig("worktreeKeepCount", parsed);
  }, [keepCountDraft, t]);

  const armCleanup = useCallback(() => {
    if (confirmTimer.current !== undefined) window.clearTimeout(confirmTimer.current);
    setConfirmArmed(true);
    confirmTimer.current = window.setTimeout(() => setConfirmArmed(false), CONFIRM_TIMEOUT_MS);
  }, []);

  const runCleanup = useCallback(async () => {
    if (confirmTimer.current !== undefined) window.clearTimeout(confirmTimer.current);
    setConfirmArmed(false);
    setCleaning(true);
    setCleanupError(null);
    setCleanupResult(null);
    try {
      const result = await cleanupCheckouts({ dryRun: false });
      setCleanupResult(result);
    } catch (error) {
      setCleanupError(error instanceof Error ? error.message : String(error));
    } finally {
      setCleaning(false);
    }
  }, []);

  const rootDirty = draftRoot.trim() !== savedRoot;

  return (
    <div className="space-y-6">
      <SettingsSection
        title={t("settings.worktrees.title")}
        description={t("settings.worktrees.description")}
      >
        <SettingsCard>
          <SettingsInput
            label={t("settings.worktrees.location")}
            description={t("settings.worktrees.locationDesc")}
            value={draftRoot}
            onChange={(value) => {
              setDraftRoot(value);
              setRootError(null);
            }}
            placeholder={t("settings.worktrees.defaultLocation")}
            disabled={!available}
            error={rootError ?? undefined}
            onKeyDown={(event) => {
              if (event.key === "Enter") saveRoot();
            }}
            action={
              <Button size="sm" variant="secondary" onClick={() => void browseRoot()} disabled={!available}>
                <FolderIcon size={14} />
                {t("settings.worktrees.browse")}
              </Button>
            }
          />
          <SettingsCardFooter>
            <span className="mr-auto text-xs text-[var(--muted)]">
              {available
                ? t("settings.worktrees.newCheckoutsOnly")
                : t("settings.worktrees.readOnly")}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={resetRoot}
              disabled={!available || savedRoot === ""}
            >
              {t("settings.worktrees.reset")}
            </Button>
            <Button
              size="sm"
              onClick={saveRoot}
              disabled={!available || !rootDirty}
            >
              {t("settings.worktrees.save")}
            </Button>
          </SettingsCardFooter>
        </SettingsCard>

        <div className="mt-4">
          <SettingsCard>
            <SettingsToggle
              label={t("settings.worktrees.cleanupToggle")}
              description={t("settings.worktrees.cleanupToggleDesc")}
              checked={autoCleanup}
              onCheckedChange={toggleCleanup}
              disabled={!available}
            />
            <SettingsInputRow
              label={t("settings.worktrees.keepCount")}
              description={t("settings.worktrees.keepCountDesc")}
              value={keepCountDraft}
              onChange={(value) => {
                setKeepCountDraft(value);
                setKeepCountError(null);
              }}
              type="number"
              disabled={!available}
              error={keepCountError ?? undefined}
              onBlur={applyKeepCount}
            />
          </SettingsCard>
        </div>
      </SettingsSection>

      <SettingsSection
        title={t("settings.worktrees.cleanupNow")}
        description={t("settings.worktrees.cleanupNowDesc")}
      >
        <SettingsCard>
          <div className="flex items-center justify-between gap-4 py-1">
            <p className="text-sm text-muted-foreground">
              {t("settings.worktrees.cleanupKeepCount", { count: keepCount })}
            </p>
            <div className="flex items-center gap-2">
              {confirmArmed && (
                <Button size="sm" variant="ghost" onClick={() => setConfirmArmed(false)}>
                  {t("settings.worktrees.cancel")}
                </Button>
              )}
              <Button
                size="sm"
                variant={confirmArmed ? "danger" : "secondary"}
                onClick={() => (confirmArmed ? void runCleanup() : armCleanup())}
                disabled={!available || cleaning}
              >
                {cleaning ? <SpinnerGapIcon size={14} className="animate-spin" /> : <TrashIcon size={14} />}
                {cleaning
                  ? t("settings.worktrees.running")
                  : confirmArmed
                    ? t("settings.worktrees.confirmCleanup")
                    : t("settings.worktrees.cleanupNow")}
              </Button>
            </div>
          </div>

          {cleanupResult && (
            <div className="space-y-2 border-t border-border/20 pt-3 text-sm">
              <p className="text-foreground">
                {t("settings.worktrees.cleanupSummary", {
                  examined: cleanupResult.examined,
                  removed: cleanupResult.removed.length,
                  retained: cleanupResult.retained.length,
                  failed: cleanupResult.failed.length,
                })}
              </p>
              {cleanupResult.removed.length > 0 && (
                <CleanupList
                  label={t("settings.worktrees.removed")}
                  items={cleanupResult.removed}
                />
              )}
              {cleanupResult.retained.length > 0 && (
                <CleanupList
                  label={t("settings.worktrees.retained")}
                  items={cleanupResult.retained.map((entry) => `${entry.root} — ${entry.reason}`)}
                />
              )}
              {cleanupResult.failed.length > 0 && (
                <CleanupList
                  label={t("settings.worktrees.failed")}
                  items={cleanupResult.failed.map((entry) => `${entry.root} — ${entry.message}`)}
                />
              )}
            </div>
          )}

          {cleanupError && <p className="border-t border-border/20 pt-3 text-sm text-destructive">{cleanupError}</p>}
          {!available && (
            <p className="border-t border-border/20 pt-3 text-sm text-muted-foreground">
              {t("settings.worktrees.readOnly")}
            </p>
          )}
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}

function CleanupList({ label, items }: { label: string; items: readonly string[] }) {
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <ul className="mt-1 space-y-0.5">
        {items.map((item) => (
          <li key={item} className="font-mono text-xs text-muted-foreground break-all">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}
