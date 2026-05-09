"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import { TrashIcon, FolderOpenIcon, DownloadSimpleIcon } from "@/components/icons";
import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
} from "@/components/settings/ui";

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
              <button
                type="button"
                onClick={handleOpenLogFolder}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[var(--accent)] hover:bg-[var(--accent)]/10 rounded-md transition-colors cursor-pointer"
              >
                <FolderOpenIcon size={14} />
                {t("settings.support.logs.openFolder")}
              </button>
            }
          />
          <SettingsRow
            label={t("settings.support.logs.fileSize")}
            description={logInfo?.sizeFormatted || t("common.loading")}
          />
        </SettingsCard>

        <div className="flex gap-3 mt-4">
          <button
            type="button"
            onClick={handleExport}
            disabled={exporting}
            className="flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-white text-sm font-medium rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer"
          >
            <DownloadSimpleIcon size={16} />
            {exporting ? t("settings.support.logs.exporting") : t("settings.support.logs.export")}
          </button>
          <button
            type="button"
            onClick={handleClear}
            disabled={clearing}
            className="flex items-center gap-2 px-4 py-2 bg-red-500/10 text-red-500 text-sm font-medium rounded-lg hover:bg-red-500/20 transition-colors disabled:opacity-50 cursor-pointer border border-red-500/20"
          >
            <TrashIcon size={16} />
            {clearing ? t("settings.support.logs.clearing") : t("settings.support.logs.clear")}
          </button>
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
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
