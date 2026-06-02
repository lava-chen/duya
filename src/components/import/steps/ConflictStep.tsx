"use client";

import { useState } from "react";
import { ArrowRightIcon, ArrowLeftIcon } from "@/components/icons";
import type { ConflictResolution } from "@/types/import";

interface ConflictStepProps {
  resolutions: ConflictResolution[];
  onConfirm: (resolutions: ConflictResolution[]) => void;
  onBack: () => void;
}

export function ConflictStep({ resolutions, onConfirm, onBack }: ConflictStepProps) {
  const [current, setCurrent] = useState<ConflictResolution[]>(resolutions);

  const updateResolution = (itemId: string, resolution: ConflictResolution["resolution"]) => {
    setCurrent((prev) =>
      prev.map((r) => (r.itemId === itemId ? { ...r, resolution } : r)),
    );
  };

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="text-xl font-semibold mb-2">
          {resolutions.length > 0
            ? `Found ${resolutions.length} conflict${resolutions.length > 1 ? "s" : ""}`
            : "No Conflicts"}
        </h2>
        <p className="text-sm text-muted-foreground">
          {resolutions.length > 0
            ? "Choose how to resolve each conflict"
            : "All items are ready to import"}
        </p>
      </div>

      {current.map((resolution) => (
        <div
          key={resolution.itemId}
          className="p-4 border border-[var(--border)] rounded-xl space-y-3"
        >
          <p className="text-sm font-medium">Item: {resolution.itemId}</p>
          <div className="space-y-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name={`conflict-${resolution.itemId}`}
                checked={resolution.resolution === "keep_duya"}
                onChange={() => updateResolution(resolution.itemId, "keep_duya")}
                className="accent-[var(--accent)]"
              />
              <span className="text-sm">Keep current DUYA settings</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name={`conflict-${resolution.itemId}`}
                checked={resolution.resolution === "use_imported"}
                onChange={() => updateResolution(resolution.itemId, "use_imported")}
                className="accent-[var(--accent)]"
              />
              <span className="text-sm">Use imported version</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name={`conflict-${resolution.itemId}`}
                checked={resolution.resolution === "keep_both_as_note"}
                onChange={() => updateResolution(resolution.itemId, "keep_both_as_note")}
                className="accent-[var(--accent)]"
              />
              <span className="text-sm">Keep both as notes (don't apply as rules)</span>
            </label>
          </div>
        </div>
      ))}

      <div className="flex justify-between">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeftIcon size={16} />
          Back
        </button>
        <button
          onClick={() => onConfirm(current)}
          className="inline-flex items-center gap-2 px-6 py-2 bg-[var(--accent)] text-white rounded-xl text-sm font-medium hover:opacity-90 transition-opacity"
        >
          Apply Import
          <ArrowRightIcon size={16} />
        </button>
      </div>
    </div>
  );
}