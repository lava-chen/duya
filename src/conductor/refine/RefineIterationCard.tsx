"use client";

import { CheckCircle, WarningCircle } from "@phosphor-icons/react";
import type { RefineIteration } from "./types";

interface RefineIterationCardProps {
  iteration: RefineIteration;
}

export function RefineIterationCard({ iteration }: RefineIterationCardProps) {
  const hasError = !!iteration.errorMessage;
  const response = iteration.llmResponse;
  return (
    <div
      data-testid={`refine-iter-${iteration.index}`}
      className="rounded-md border border-[var(--border)] bg-[var(--surface)] overflow-hidden"
    >
      <div className="flex items-center justify-between px-2 py-1 border-b border-[var(--border)] bg-[var(--main-bg)]">
        <div className="flex items-center gap-1.5">
          {hasError ? (
            <WarningCircle size={10} className="text-[var(--error)]" weight="fill" />
          ) : (
            <CheckCircle size={10} className="text-[var(--success)]" weight="fill" />
          )}
          <span className="text-[10px] font-medium text-[var(--text)]">
            Iter {iteration.index}
          </span>
        </div>
        <span className="text-[10px] text-[var(--muted)]">
          {iteration.appliedAt
            ? new Date(iteration.appliedAt).toLocaleTimeString()
            : iteration.errorMessage
              ? "not applied"
              : "applying…"}
        </span>
      </div>

      {iteration.screenshotBase64 && (
        <img
          src={`data:image/png;base64,${iteration.screenshotBase64}`}
          alt={`iteration ${iteration.index}`}
          className="block w-full"
        />
      )}

      <div className="px-2 py-1.5 space-y-1">
        {response && (
          <div className="text-[10px] text-[var(--text)]">
            <span className="text-[var(--muted)]">rationale: </span>
            {response.rationale}
          </div>
        )}
        <div
          data-testid={`refine-iter-${iteration.index}-diff`}
          className="text-[10px] text-[var(--muted)]"
        >
          {iteration.diffSummary || (hasError ? iteration.errorMessage : "—")}
        </div>
        {response && response.warnings.length > 0 && (
          <ul className="text-[10px] text-[var(--warning)] list-disc pl-4">
            {response.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}