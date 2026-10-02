// run-display/workflow-preview-card.tsx — static flow preview card.
//
// Sits in WorkflowDetailView's definition tab for raw .dwf.ts scripts (which
// carry no declarative phases and would otherwise show only the source text).
// Steps come from parseDwfPreviewSteps — never-run, hence all 'pending'.
// The `typescript` module is lazy-imported (plan 565 Phase B) so the AST
// scanner's weight stays out of the main chunk; until it lands the card
// renders nothing, matching the old "no preview" behaviour.

'use client';

import { useEffect, useState } from 'react';
import type * as Ts from 'typescript';
import { parseDwfPreviewSteps, type DwfPreviewResult } from './dwf-preview';
import { StageColumns } from './stage-columns';
import { useTranslation } from '@/hooks/useTranslation';

export function WorkflowPreviewCard({ script }: { script: string }) {
  const { t } = useTranslation();
  const [result, setResult] = useState<DwfPreviewResult | null>(null);

  useEffect(() => {
    let alive = true;
    if (!script) {
      setResult(null);
      return;
    }
    import('typescript')
      .then((ts) => {
        if (alive) setResult(parseDwfPreviewSteps(script, ts));
      })
      .catch(() => {
        if (alive) setResult(null);
      });
    return () => {
      alive = false;
    };
  }, [script]);

  if (!result) return null;
  const { steps, diagnostics } = result;

  // Nothing parseable AND nothing to complain about — show nothing rather
  // than an empty card. Diagnostics alone (syntax error, unknown primitive)
  // still render: "broken" is information the author needs before launching.
  if (steps.length === 0 && diagnostics.length === 0) return null;

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
      {steps.length > 0 && <StageColumns steps={steps} />}
      {diagnostics.length > 0 && (
        <div className={steps.length > 0 ? 'pt-2' : ''} data-testid="workflow-preview-diagnostics">
          {diagnostics.slice(0, 8).map((d, i) => (
            <div key={i} className="text-[11px] leading-5 text-[var(--warning, #b45309)]">
              {t('workflow.preview.diagnosticLine', { line: d.line, message: d.message })}
            </div>
          ))}
          {diagnostics.length > 8 && (
            <div className="text-[10px] text-[var(--muted)]">
              {t('workflow.preview.diagnosticMore', { count: diagnostics.length - 8 })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
