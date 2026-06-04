"use client";

import { useState, useEffect } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import { ArrowRightIcon } from "@/components/icons";
import { detectImportIPC } from "@/lib/import-ipc";
import type { ImportSource } from "@/types/import";

interface SelectSourceStepProps {
  onSelect: (source: ImportSource, projectPath?: string) => void;
  onNext: () => void;
}

export function SelectSourceStep({ onSelect, onNext }: SelectSourceStepProps) {
  const { t } = useTranslation();
  const [detected, setDetected] = useState<{ claude: boolean; codex: boolean }>({
    claude: false,
    codex: false,
  });
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState<"user" | "project">("user");

  useEffect(() => {
    detectImportIPC()
      .then(setDetected)
      .catch(() => setDetected({ claude: false, codex: false }))
      .finally(() => setLoading(false));
  }, []);

  const handleSelect = (source: ImportSource) => {
    onSelect(source, scope === "project" ? undefined : undefined);
    onNext();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-pulse text-muted-foreground">{t("importFlow.detecting")}</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="text-xl font-semibold mb-2">{t("importFlow.importFromAIWorkspace")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("importFlow.bringExisting")}
        </p>
      </div>

      <div className="space-y-3">
        {detected.claude && (
          <button
            onClick={() => handleSelect("claude-code")}
            className="w-full p-4 border border-[var(--border)] rounded-xl hover:border-[var(--accent)] transition-colors text-left"
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">Claude Code</div>
                <div className="text-sm text-muted-foreground mt-1">
                  {t("importFlow.detectedOnMachine")}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {t("importFlow.claudeCodeFeatures")}
                </div>
              </div>
              <ArrowRightIcon size={18} className="text-muted-foreground" />
            </div>
          </button>
        )}

        {detected.codex && (
          <button
            onClick={() => handleSelect("codex")}
            className="w-full p-4 border border-[var(--border)] rounded-xl hover:border-[var(--accent)] transition-colors text-left"
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">Codex</div>
                <div className="text-sm text-muted-foreground mt-1">
                  {t("importFlow.detectedOnMachine")}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {t("importFlow.codexFeatures")}
                </div>
              </div>
              <ArrowRightIcon size={18} className="text-muted-foreground" />
            </div>
          </button>
        )}

        {!detected.claude && !detected.codex && (
          <div className="text-center py-8 text-muted-foreground">
            <p>{t("importFlow.noToolsDetected")}</p>
            <p className="text-sm mt-2">
              {t("importFlow.supportedTools")}
            </p>
          </div>
        )}
      </div>

      <div className="space-y-2 pt-2">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="radio"
            name="scope"
            checked={scope === "user"}
            onChange={() => setScope("user")}
            className="accent-[var(--accent)]"
          />
          <span className="text-sm">{t("importFlow.importGlobalOnly")}</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="radio"
            name="scope"
            checked={scope === "project"}
            onChange={() => setScope("project")}
            className="accent-[var(--accent)]"
          />
          <span className="text-sm">{t("importFlow.selectProjectFolder")}</span>
        </label>
      </div>
    </div>
  );
}