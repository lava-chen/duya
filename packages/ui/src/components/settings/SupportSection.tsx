"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import { TrashIcon, FolderOpenIcon, DownloadSimpleIcon, ExternalLinkIcon, ArrowCounterClockwiseIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
} from "@/components/settings/ui";

// Custom event for triggering onboarding reset
const RESET_ONBOARDING_EVENT = "duya:reset-onboarding";

export function resetOnboarding() {
  window.dispatchEvent(new CustomEvent(RESET_ONBOARDING_EVENT));
}

export function SupportSection() {
  const { t } = useTranslation();
  const [logInfo, setLogInfo] = useState<{
    logPath: string;
    logDir: string;
    size: number;
    sizeFormatted: string;
  } | null>(null);
  const [appVersion, setAppVersion] = useState<string>("");
  const [exporting, setExporting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  useEffect(() => {
    if (window.electronAPI?.logger?.getPath) {
      window.electronAPI.logger.getPath().then(setLogInfo).catch(console.error);
    }
    if (window.electronAPI?.app?.getVersion) {
      window.electronAPI.app.getVersion().then(setAppVersion).catch(() => setAppVersion("0.2.0-beta.1"));
    }
  }, []);

  const handleExport = useCallback(async () => {
    setExporting(true);
    setStatusMessage(null);
    try {
      const result = await window.electronAPI?.logger?.export();
      if (result?.success && result.logs) {
        const defaultPath = logInfo?.logPath || "app.log";
        if (window.electronAPI?.dialog?.openFolder) {
          const folderResult = await window.electronAPI.dialog.openFolder({
            title: "Select folder to save logs",
          });
          if (!folderResult.canceled && folderResult.filePaths.length > 0) {
            const targetFile = folderResult.filePaths[0] + "/duya-exported-logs.txt";
            const exportResult = await window.electronAPI?.logger?.exportToFile?.(targetFile);
            if (exportResult?.success) {
              setStatusMessage(`Logs exported to: ${targetFile}`);
            } else {
              setStatusMessage("Failed to export logs to file");
            }
          }
        } else {
          const blob = new Blob([result.logs], { type: "text/plain" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = "duya-logs.txt";
          a.click();
          URL.revokeObjectURL(url);
          setStatusMessage("Logs downloaded");
        }
      } else {
        setStatusMessage("Failed to export logs");
      }
    } catch {
      setStatusMessage("Failed to export logs");
    } finally {
      setExporting(false);
    }
  }, [logInfo]);

  const handleClear = useCallback(async () => {
    setClearing(true);
    setStatusMessage(null);
    try {
      const result = await window.electronAPI?.logger?.clear?.();
      if (result?.success) {
        setStatusMessage("Logs cleared successfully");
        if (window.electronAPI?.logger?.getPath) {
          const info = await window.electronAPI.logger.getPath();
          setLogInfo(info);
        }
      } else {
        setStatusMessage("Failed to clear logs");
      }
    } catch {
      setStatusMessage("Failed to clear logs");
    } finally {
      setClearing(false);
    }
  }, []);

  const handleOpenLogFolder = useCallback(() => {
    if (logInfo?.logDir && window.electronAPI?.shell?.openPath) {
      window.electronAPI.shell.openPath(logInfo.logDir);
    }
  }, [logInfo]);

  return (
    <div>
      <SettingsSection
        title={t("settings.support.logs.title")}
        description={t("settings.support.logs.description")}
      >
        <SettingsCard divided>
          <SettingsRow
            label={t("settings.support.logs.filePath")}
            description={logInfo?.logPath || t("common.loading")}
            action={
              <Button
                variant="ghost"
                size="sm"
                onClick={handleOpenLogFolder}
              >
                <FolderOpenIcon size={14} />
                {t("settings.support.logs.openFolder")}
              </Button>
            }
          />
          <SettingsRow
            label={t("settings.support.logs.fileSize")}
            description={logInfo?.sizeFormatted || t("common.loading")}
          />
        </SettingsCard>

        <div className="flex gap-3 mt-4">
          <Button
            variant="primary"
            onClick={handleExport}
            disabled={exporting}
          >
            <DownloadSimpleIcon size={16} />
            {exporting ? t("settings.support.logs.exporting") : t("settings.support.logs.export")}
          </Button>
          <Button
            variant="danger"
            onClick={handleClear}
            disabled={clearing}
          >
            <TrashIcon size={16} />
            {clearing ? t("settings.support.logs.clearing") : t("settings.support.logs.clear")}
          </Button>
        </div>

        {statusMessage && (
          <p className="mt-3 text-sm text-[var(--text-secondary)]">{statusMessage}</p>
        )}
      </SettingsSection>

      <SettingsSection
        title={t("settings.support.about.title")}
        description={t("settings.support.about.description")}
      >
        <SettingsCard divided>
          <SettingsRow
            label={t("settings.general.version")}
            description={appVersion || t("common.loading")}
          />
          <SettingsRow
            label={t("settings.support.about.docsLink")}
            description="duya.dev/docs"
            action={
              <a
                href="https://duya.dev/docs"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[var(--accent)] hover:bg-[var(--accent)]/10 rounded-md transition-colors cursor-pointer"
              >
                <ExternalLinkIcon size={14} />
                {t("settings.support.about.docsLink")}
              </a>
            }
          />
          <SettingsRow
            label={t("settings.support.about.resetOnboarding")}
            description={t("settings.support.about.resetOnboardingDesc")}
            action={
              <Button
                variant="danger"
                size="sm"
                onClick={resetOnboarding}
              >
                <ArrowCounterClockwiseIcon size={14} />
                {t("settings.support.about.resetOnboarding")}
              </Button>
            }
          />
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
