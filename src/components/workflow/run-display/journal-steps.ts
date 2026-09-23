// run-display/journal-steps.ts — adapter from the durable journal to the
// stage-rail view (plan 560 §6.2 follow-up).
//
// The chat run card is fed by live SSE `steps` (RunStepView[]). Run HISTORY
// surfaces (WorkflowPanel runs tab / detail) read the same run's persisted
// journal instead — different shape, same information. This adapter folds
// WorkflowJournalRecord[] into the exact view the card already renders, so a
// historical run and its live twin look identical:
//
//   kind 'phase'                  → nodeKind:'phase' divider (start/end pairs
//                                   dedupe to one divider per nodeId)
//   kind node_result/decision/
//        approval                 → a step chip (tool/agent/gui/decision/human)
//   kind 'artifact'               → an artifact name chip (not a rail step)
//
// Status mapping is honest: succeeded/skipped → success, every terminal
// non-success → failed, everything still moving → running.

import type { RunArtifactNameView, RunStepNodeKind, RunStepStatus, RunStepView } from '@/types/stream';

/** Minimal journal-record shape (mirrors WorkflowPanel's WorkflowJournalRecord
 *  — re-declared here so run-display stays decoupled from the panel file). */
export interface JournalRecordLike {
  seq: number;
  kind: string;
  nodeId: string;
  status: string;
  nodeKind?: string;
  action?: string;
  result?: unknown;
}

/** Journal status → the card's 3-lamp vocabulary. */
export function journalStatusToStepStatus(status: string): RunStepStatus {
  if (status === 'succeeded' || status === 'skipped') return 'success';
  if (
    status === 'failed' ||
    status === 'interrupted' ||
    status === 'stopped' ||
    status === 'cancelled'
  ) {
    return 'failed';
  }
  return 'running';
}

function journalNodeKind(nodeKind: string | undefined, kind: string): RunStepNodeKind {
  if (nodeKind === 'tool' || nodeKind === 'agent' || nodeKind === 'gui' || nodeKind === 'decision' || nodeKind === 'human' || nodeKind === 'noop') {
    return nodeKind;
  }
  // Records whose kind already is the node kind (decision / approval rows).
  if (kind === 'decision') return 'decision';
  if (kind === 'approval') return 'human';
  return 'noop';
}

/**
 * Fold the journal into the card's step list. Phase start/end pairs collapse
 * into a single divider (the first occurrence wins — its end record only
 * updates status, which the divider never renders anyway).
 */
export function journalToSteps(records: JournalRecordLike[]): RunStepView[] {
  const steps: RunStepView[] = [];
  const seenPhases = new Set<string>();
  for (const r of records) {
    if (r.kind === 'phase') {
      if (seenPhases.has(r.nodeId)) continue;
      seenPhases.add(r.nodeId);
      steps.push({
        id: r.nodeId,
        label: r.action ?? r.nodeId,
        nodeKind: 'phase',
        status: 'success',
      });
      continue;
    }
    if (r.kind !== 'node_result' && r.kind !== 'decision' && r.kind !== 'approval') continue;
    steps.push({
      id: r.nodeId,
      label: r.action ?? r.nodeId,
      nodeKind: journalNodeKind(r.nodeKind, r.kind),
      status: journalStatusToStepStatus(r.status),
    });
  }
  return steps;
}

/** `r1/capture-0.png` → `capture-0.png` (chips name the file, not the path). */
export function artifactRefToName(ref: string): string {
  const base = ref.split(/[\\/]/).pop() ?? ref;
  return base;
}

/** Artifact records → the card's name-only chips, in emission order. */
export function journalToArtifacts(records: JournalRecordLike[]): RunArtifactNameView[] {
  const out: RunArtifactNameView[] = [];
  for (const r of records) {
    if (r.kind !== 'artifact') continue;
    const ref =
      r.result && typeof r.result === 'object' && typeof (r.result as { ref?: unknown }).ref === 'string'
        ? (r.result as { ref: string }).ref
        : undefined;
    const name = ref ? artifactRefToName(ref) : r.action ?? r.nodeId;
    if (name && !out.some((a) => a.name === name)) out.push({ name });
  }
  return out;
}
