"use client";

import { useState } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import { SelectSourceStep } from "./steps/SelectSourceStep";
import { ScanResultStep } from "./steps/ScanResultStep";
import { PreviewStep } from "./steps/PreviewStep";
import { ConflictStep } from "./steps/ConflictStep";
import { CompleteStep } from "./steps/CompleteStep";
import type { ImportSource, ImportItem, ScanResult, ImportManifest, ConflictResolution, SessionImportItem } from "@/types/import";

interface ImportFlowProps {
  onComplete?: () => void;
  onClose?: () => void;
}

export function ImportFlow({ onComplete, onClose }: ImportFlowProps) {
  const { t } = useTranslation();
  const [currentStep, setCurrentStep] = useState(0);
  const [selectedSource, setSelectedSource] = useState<ImportSource | null>(null);
  const [projectPath, setProjectPath] = useState<string | undefined>();
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [selectedItems, setSelectedItems] = useState<ImportItem[]>([]);
  const [selectedSessions, setSelectedSessions] = useState<SessionImportItem[]>([]);
  const [conflictResolutions, setConflictResolutions] = useState<ConflictResolution[]>([]);
  const [manifest, setManifest] = useState<ImportManifest | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSourceSelected = (source: ImportSource, path?: string) => {
    setSelectedSource(source);
    setProjectPath(path);
    setError(null);
  };

  const handleScanComplete = (result: ScanResult) => {
    setScanResult(result);
    const allItems = [...result.userScopeItems, ...result.projectScopeItems];
    setSelectedItems(allItems.filter((item) => item.defaultSelected));
    setSelectedSessions(result.sessions?.filter((s) => s.defaultSelected) ?? []);
    setCurrentStep(2);
  };

  const handlePreviewConfirm = (items: ImportItem[], sessions: SessionImportItem[]) => {
    setSelectedItems(items);
    setSelectedSessions(sessions);
    const conflicts = findConflicts(items);
    if (conflicts.length > 0) {
      setConflictResolutions(conflicts);
      setCurrentStep(3);
    } else {
      setCurrentStep(4);
    }
  };

  const handleConflictsResolved = (resolutions: ConflictResolution[]) => {
    setConflictResolutions(resolutions);
    setCurrentStep(4);
  };

  const handleImportComplete = (result: ImportManifest) => {
    setManifest(result);
  };

  const handleFinish = () => {
    onComplete?.();
  };

  const handleBack = () => {
    if (currentStep > 0) {
      setCurrentStep((s) => s - 1);
    }
  };

  const handleSkip = () => {
    onClose?.();
  };

  return (
    <div className="fixed inset-0 bg-[var(--bg-canvas)] z-50 flex items-center justify-center p-4">
      <div className="w-full max-w-2xl">
        <div className="flex items-center justify-between mb-6">
          <span
            className="font-semibold text-lg"
            style={{ fontFamily: "'Copernicus', Georgia, 'Times New Roman', serif" }}
          >
            DUYA
          </span>
          {currentStep < 4 && (
            <button
              onClick={handleSkip}
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              {t("importFlow.skip")}
            </button>
          )}
        </div>

        <div className="flex items-center justify-center gap-2 mb-8">
          {[0, 1, 2, 3, 4].map((index) => (
            <div
              key={index}
              className={`h-2 rounded-full transition-all duration-300 ${
                index === currentStep
                  ? "w-8 bg-[var(--accent)]"
                  : index < currentStep
                  ? "w-2 bg-[var(--accent)]/60"
                  : "w-2 bg-[var(--border)]"
              }`}
            />
          ))}
        </div>

        <div className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-2xl shadow-xl overflow-hidden">
          <div className="p-8">
            {currentStep === 0 && (
              <SelectSourceStep
                onSelect={handleSourceSelected}
                onNext={() => setCurrentStep(1)}
              />
            )}
            {currentStep === 1 && selectedSource && (
              <ScanResultStep
                source={selectedSource}
                projectPath={projectPath}
                onComplete={handleScanComplete}
                onBack={handleBack}
                error={error}
                setError={setError}
              />
            )}
            {currentStep === 2 && scanResult && (
              <PreviewStep
                scanResult={scanResult}
                selectedItems={selectedItems}
                selectedSessions={selectedSessions}
                onConfirm={handlePreviewConfirm}
                onBack={handleBack}
              />
            )}
            {currentStep === 3 && (
              <ConflictStep
                resolutions={conflictResolutions}
                onConfirm={handleConflictsResolved}
                onBack={handleBack}
              />
            )}
            {currentStep === 4 && selectedSource && (
              <CompleteStep
                items={selectedItems}
                sessions={selectedSessions}
                source={selectedSource}
                conflictResolutions={conflictResolutions}
                projectPath={projectPath}
                manifest={manifest}
                onComplete={handleImportComplete}
                onFinish={handleFinish}
                error={error}
                setError={setError}
              />
            )}
          </div>
        </div>

        <div className="text-center mt-4">
          <span className="text-xs text-muted-foreground">
            {t("importFlow.stepOf", { step: currentStep + 1, total: 5 })} 
          </span>
        </div>
      </div>
    </div>
  );
}

function findConflicts(items: ImportItem[]): ConflictResolution[] {
  const resolutions: ConflictResolution[] = [];
  const seen = new Map<string, ImportItem>();

  for (const item of items) {
    const key = `${item.type}:${item.title}`;
    if (seen.has(key)) {
      resolutions.push({ itemId: item.id, resolution: "keep_both_as_note" });
    } else {
      seen.set(key, item);
    }
  }

  return resolutions;
}

export default ImportFlow;