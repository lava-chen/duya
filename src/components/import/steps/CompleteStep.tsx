"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import { applyImportIPC, rollbackImportIPC } from "@/lib/import-ipc";
import type { ImportSource, ImportItem, ImportManifest, ConflictResolution, SessionImportItem } from "@/types/import";

interface CompleteStepProps {
  items: ImportItem[];
  sessions: SessionImportItem[];
  source: ImportSource;
  conflictResolutions: ConflictResolution[];
  projectPath?: string;
  manifest: ImportManifest | null;
  onComplete: (manifest: ImportManifest) => void;
  onFinish: () => void;
  error: string | null;
  setError: (error: string | null) => void;
}

export function CompleteStep({
  items,
  sessions,
  source,
  conflictResolutions,
  projectPath,
  manifest,
  onComplete,
  onFinish,
  error,
  setError,
}: CompleteStepProps) {
  const { t } = useTranslation();
  const [applying, setApplying] = useState(!manifest);
  const [rolledBack, setRolledBack] = useState(false);

  useEffect(() => {
    if (manifest) return;

    setApplying(true);
    setError(null);

    applyImportIPC({
      items,
      conflictResolutions,
      targetProjectPath: projectPath,
      sessions: sessions.length > 0 ? sessions : undefined,
    })
      .then((result) => {
        onComplete(result);
        setApplying(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        setApplying(false);
      });
  }, []);

  const handleRollback = async () => {
    if (!manifest) return;
    try {
      await rollbackImportIPC(manifest.batchId);
      setRolledBack(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (applying) {
    return (
      <div className="flex flex-col items-center justify-center py-12 space-y-4">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-[var(--accent)] border-t-transparent" />
        <p className="text-muted-foreground">{t("importFlow.applyingImport")}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-8 space-y-4">
        <p className="text-red-500">{t("importFlow.importFailed", { error })}</p>
        <button
          onClick={onFinish}
          className="text-sm text-[var(--accent)] hover:underline"
        >
          {t("importFlow.close")}
        </button>
      </div>
    );
  }

  if (rolledBack) {
    return (
      <div className="text-center py-8 space-y-4">
        <div className="text-4xl">↩</div>
        <h2 className="text-xl font-semibold">{t("importFlow.importRolledBack")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("importFlow.allContentRemoved")}
        </p>
        <button
          onClick={onFinish}
          className="inline-flex items-center gap-2 px-6 py-2 bg-[var(--accent)] text-white rounded-xl text-sm font-medium hover:opacity-90 transition-opacity"
        >
          {t("importFlow.close")}
        </button>
      </div>
    );
  }

  if (!manifest) return null;

  return (
    <div className="space-y-6 text-center">
      <div className="text-4xl">✓</div>
      <h2 className="text-xl font-semibold">{t("importFlow.importComplete")}</h2>

      <div className="space-y-2 text-sm">
        <p className="text-muted-foreground">
          <span className="font-medium text-foreground">{manifest.appliedCount}</span> {t("importFlow.itemsImported", { count: manifest.appliedCount })}
        </p>
        {manifest.sessionCount > 0 && (
          <p className="text-muted-foreground">
            <span className="font-medium text-foreground">{manifest.sessionCount}</span> {t("importFlow.sessionsImported", { count: manifest.sessionCount })}
          </p>
        )}
        {manifest.skippedCount > 0 && (
          <p className="text-muted-foreground">
            <span className="font-medium">{manifest.skippedCount}</span> {t("importFlow.itemsSkipped", { count: manifest.skippedCount })}
          </p>
        )}
        {manifest.needsAuthCount > 0 && (
          <p className="text-yellow-600">
            <span className="font-medium">{manifest.needsAuthCount}</span> {t("importFlow.itemsNeedAuth", { count: manifest.needsAuthCount })}
          </p>
        )}
        {manifest.disabledCount > 0 && (
          <p className="text-muted-foreground">
            <span className="font-medium">{manifest.disabledCount}</span> {t("importFlow.itemsDisabled", { count: manifest.disabledCount })}
          </p>
        )}
      </div>

      <div className="p-4 bg-[var(--bg-canvas)] rounded-xl text-left text-xs text-muted-foreground space-y-1">
        <p>{t("importFlow.source", { source })}</p>
        <p>{t("importFlow.time", { time: new Date(manifest.createdAt).toLocaleString() })}</p>
        <p>{t("importFlow.copyOnlyMode")}</p>
        <p>{t("importFlow.batchId", { id: manifest.batchId })}</p>
      </div>

      <div className="flex justify-center gap-3">
        <button
          onClick={handleRollback}
          className="px-4 py-2 text-sm text-red-500 border border-red-500/30 rounded-xl hover:bg-red-500/10 transition-colors"
        >
          {t("importFlow.undoImport")}
        </button>
        <button
          onClick={onFinish}
          className="px-6 py-2 bg-[var(--accent)] text-white rounded-xl text-sm font-medium hover:opacity-90 transition-opacity"
        >
          {t("importFlow.startUsingDUYA")}
        </button>
      </div>
    </div>
  );
}