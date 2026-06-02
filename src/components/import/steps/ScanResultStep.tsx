"use client";

import { useEffect, useState } from "react";
import { scanImportIPC } from "@/lib/import-ipc";
import { ArrowRightIcon, ArrowLeftIcon } from "@/components/icons";
import type { ImportSource, ScanResult } from "@/types/import";

interface ScanResultStepProps {
  source: ImportSource;
  projectPath?: string;
  onComplete: (result: ScanResult) => void;
  onBack: () => void;
  error: string | null;
  setError: (error: string | null) => void;
}

export function ScanResultStep({
  source,
  projectPath,
  onComplete,
  onBack,
  error,
  setError,
}: ScanResultStepProps) {
  const [scanning, setScanning] = useState(true);
  const [result, setResult] = useState<ScanResult | null>(null);

  useEffect(() => {
    setScanning(true);
    setError(null);
    scanImportIPC(source, projectPath)
      .then((res) => {
        setResult(res);
        setScanning(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        setScanning(false);
      });
  }, [source, projectPath]);

  if (scanning) {
    return (
      <div className="flex flex-col items-center justify-center py-12 space-y-4">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-[var(--accent)] border-t-transparent" />
        <p className="text-muted-foreground">Scanning workspace...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-8 space-y-4">
        <p className="text-red-500">Scan failed: {error}</p>
        <button
          onClick={onBack}
          className="text-sm text-[var(--accent)] hover:underline"
        >
          Go back
        </button>
      </div>
    );
  }

  if (!result) return null;

  const allItems = [...result.userScopeItems, ...result.projectScopeItems];
  const total = allItems.length;
  const sessionCount = result.sessions?.length ?? 0;

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="text-xl font-semibold mb-2">
          Found {total} transferable items{total > 0 && sessionCount > 0 ? ` + ${sessionCount} sessions` : ''}
        </h2>
        <p className="text-sm text-muted-foreground">
          Source files will not be modified. Review everything before import.
        </p>
      </div>

      <div className="space-y-2">
        {result.summary.projectInstructions > 0 && (
          <div className="flex items-center justify-between p-3 bg-[var(--bg-canvas)] rounded-lg">
            <span className="text-sm">Project Rules & Instructions</span>
            <span className="text-sm font-medium">{result.summary.projectInstructions} items</span>
          </div>
        )}
        {result.summary.projectMemory > 0 && (
          <div className="flex items-center justify-between p-3 bg-[var(--bg-canvas)] rounded-lg">
            <span className="text-sm">Project Memory</span>
            <span className="text-sm font-medium">{result.summary.projectMemory} items</span>
          </div>
        )}
        {result.summary.skills > 0 && (
          <div className="flex items-center justify-between p-3 bg-[var(--bg-canvas)] rounded-lg">
            <span className="text-sm">Workflows & Skills</span>
            <span className="text-sm font-medium">{result.summary.skills} items</span>
          </div>
        )}
        {result.summary.mcp > 0 && (
          <div className="flex items-center justify-between p-3 bg-[var(--bg-canvas)] rounded-lg">
            <span className="text-sm">Tool Connections</span>
            <span className="text-sm font-medium">{result.summary.mcp} items</span>
          </div>
        )}
        {sessionCount > 0 && (
          <div className="flex items-center justify-between p-3 bg-[var(--bg-canvas)] rounded-lg border border-[var(--accent)]/30">
            <span className="text-sm">Chat Sessions</span>
            <span className="text-sm font-medium text-[var(--accent)]">{sessionCount} sessions</span>
          </div>
        )}
        {result.summary.restricted > 0 && (
          <div className="flex items-center justify-between p-3 bg-[var(--bg-canvas)] rounded-lg border border-yellow-500/30">
            <span className="text-sm text-yellow-600">Restricted Items</span>
            <span className="text-sm font-medium text-yellow-600">{result.summary.restricted} items</span>
          </div>
        )}
      </div>

      <div className="flex justify-between">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeftIcon size={16} />
          Back
        </button>
        <button
          onClick={() => onComplete(result)}
          className="inline-flex items-center gap-2 px-6 py-2 bg-[var(--accent)] text-white rounded-xl text-sm font-medium hover:opacity-90 transition-opacity"
        >
          Preview Content
          <ArrowRightIcon size={16} />
        </button>
      </div>
    </div>
  );
}