"use client";

import { useState } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import { ArrowRightIcon, ArrowLeftIcon } from "@/components/icons";
import type { ImportItem, ScanResult, SessionImportItem } from "@/types/import";

interface PreviewStepProps {
  scanResult: ScanResult;
  selectedItems: ImportItem[];
  selectedSessions: SessionImportItem[];
  onConfirm: (items: ImportItem[], sessions: SessionImportItem[]) => void;
  onBack: () => void;
}

const RISK_LABELS: Record<string, { key: string; color: string }> = {
  safe: { key: "importFlow.recommended", color: "text-green-600" },
  review: { key: "importFlow.needsReview", color: "text-yellow-600" },
  restricted: { key: "importFlow.requiresAuthorization", color: "text-red-500" },
};

export function PreviewStep({ scanResult, selectedItems, selectedSessions, onConfirm, onBack }: PreviewStepProps) {
  const { t } = useTranslation();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const allItems = [...scanResult.userScopeItems, ...scanResult.projectScopeItems];
  const sessions = scanResult.sessions ?? [];

  const toggleItem = (item: ImportItem) => {
    const isSelected = selectedItems.some((s) => s.id === item.id);
    if (isSelected) {
      onConfirm(selectedItems.filter((s) => s.id !== item.id), selectedSessions);
    } else {
      onConfirm([...selectedItems, item], selectedSessions);
    }
  };

  const toggleSession = (session: SessionImportItem) => {
    const isSelected = selectedSessions.some((s) => s.id === session.id);
    if (isSelected) {
      onConfirm(selectedItems, selectedSessions.filter((s) => s.id !== session.id));
    } else {
      onConfirm(selectedItems, [...selectedSessions, session]);
    }
  };

  const safeItems = allItems.filter((i) => i.riskLevel === "safe");
  const advancedItems = allItems.filter((i) => i.riskLevel !== "safe");

  return (
    <div className="space-y-4">
      <div className="text-center">
        <h2 className="text-xl font-semibold mb-2">{t("importFlow.reviewAndSelect")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("importFlow.pickWhatToImport")}
        </p>
      </div>

      {safeItems.length > 0 && (
        <div className="space-y-3 max-h-[30vh] overflow-y-auto pr-1">
          {safeItems.map((item) => (
            <ItemCard
              key={item.id}
              item={item}
              selected={selectedItems.some((s) => s.id === item.id)}
              onToggle={() => toggleItem(item)}
            />
          ))}
        </div>
      )}

      {sessions.length > 0 && (
        <div>
          <div className="text-sm font-medium text-foreground mb-2">
            {t("importFlow.chatSessionsCount", { count: sessions.length })} 
          </div>
          <div className="space-y-2 max-h-[25vh] overflow-y-auto pr-1">
            {sessions.map((session) => (
              <SessionCard
                key={session.id}
                session={session}
                selected={selectedSessions.some((s) => s.id === session.id)}
                onToggle={() => toggleSession(session)}
              />
            ))}
          </div>
        </div>
      )}

      {advancedItems.length > 0 && (
        <div>
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="text-sm text-[var(--accent)] hover:underline"
          >
            {showAdvanced ? t("importFlow.hideAdvanced", { count: advancedItems.length }) : t("importFlow.showAdvanced", { count: advancedItems.length })} 
          </button>
          {showAdvanced && (
            <div className="space-y-3 mt-3 max-h-[30vh] overflow-y-auto pr-1">
              {advancedItems.map((item) => (
                <ItemCard
                  key={item.id}
                  item={item}
                  selected={selectedItems.some((s) => s.id === item.id)}
                  onToggle={() => toggleItem(item)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex justify-between pt-2">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeftIcon size={16} />
          {t("importFlow.back")}
        </button>
        <button
          onClick={() => onConfirm(selectedItems, selectedSessions)}
          className="inline-flex items-center gap-2 px-6 py-2 bg-[var(--accent)] text-white rounded-xl text-sm font-medium hover:opacity-90 transition-opacity"
        >
          {t("importFlow.confirmSelection")}
          <ArrowRightIcon size={16} />
        </button>
      </div>
    </div>
  );
}

function ItemCard({
  item,
  selected,
  onToggle,
}: {
  item: ImportItem;
  selected: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const risk = RISK_LABELS[item.riskLevel] ?? RISK_LABELS.safe;
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className={`p-3 border rounded-lg transition-colors ${
        selected ? "border-[var(--accent)] bg-[var(--accent)]/5" : "border-[var(--border)]"
      }`}
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          className="mt-1 accent-[var(--accent)]"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium truncate">{item.title}</span>
            <span className={`text-xs shrink-0 ${risk.color}`}>{t(risk.key as any)}</span>
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            {t("importFlow.fromScope", { path: item.sourcePath, scope: item.scope })} 
          </div>
          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{item.summary}</p>
          {expanded && (
            <pre className="text-xs text-muted-foreground mt-2 p-2 bg-[var(--bg-canvas)] rounded overflow-x-auto max-h-40">
              {item.contentPreview}
            </pre>
          )}
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-[var(--accent)] hover:underline mt-1"
          >
            {expanded ? t("importFlow.hide") : t("importFlow.viewFullContent")}
          </button>
        </div>
      </div>
    </div>
  );
}

function SessionCard({
  session,
  selected,
  onToggle,
}: {
  session: SessionImportItem;
  selected: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const sourceLabel = session.source === 'claude-code' ? 'Claude Code' : 'Codex';
  const sizeMB = (session.sizeBytes / (1024 * 1024)).toFixed(1);

  return (
    <div
      className={`p-3 border rounded-lg transition-colors ${
        selected ? "border-[var(--accent)] bg-[var(--accent)]/5" : "border-[var(--border)]"
      }`}
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          className="mt-1 accent-[var(--accent)]"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium truncate">{session.title}</span>
            <span className="text-xs text-[var(--accent)] shrink-0">{sourceLabel}</span>
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            {t("importFlow.sessionMeta", { count: session.messageCount, size: sizeMB, project: session.projectName || t("importFlow.unknownProject") })} 
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {new Date(session.createdAt).toLocaleDateString()} · {session.workingDirectory || t("importFlow.noWorkingDirectory")}
          </div>
        </div>
      </div>
    </div>
  );
}