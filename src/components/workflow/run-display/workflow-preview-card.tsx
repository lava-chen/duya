// run-display/workflow-preview-card.tsx — static flow preview card.
//
// Sits in WorkflowDetailView's definition tab for raw .dwf.ts scripts (which
// carry no declarative phases and would otherwise show only the source text).
// Steps come from parseDwfPreviewSteps — never-run, hence all 'pending'.

'use client';

import { useMemo } from 'react';
import { parseDwfPreviewSteps } from './dwf-preview';
import { StageColumns } from './stage-columns';
import { useTranslation } from '@/hooks/useTranslation';

export function WorkflowPreviewCard({ script }: { script: string }) {
  const { t } = useTranslation();
  const steps = useMemo(() => parseDwfPreviewSteps(script), [script]);

  // Nothing parseable (no wf.* calls, or a stripped/foreign script) — show
  // nothing rather than an empty card.
  if (steps.length === 0) return null;

  return (
    <div
      className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5"
      data-testid="workflow-preview-card"
    >
      <div className="flex items-baseline gap-2 pb-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">
          {t('workflow.preview.title')}
        </span>
        <span className="min-w-0 truncate text-[10px] text-[var(--muted)]" title={t('workflow.preview.hint')}>
          {t('workflow.preview.hint')}
        </span>
      </div>
      <StageColumns steps={steps} />
    </div>
  );
}
