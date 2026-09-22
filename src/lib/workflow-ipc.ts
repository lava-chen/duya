/**
 * workflow-ipc.ts — renderer-side IPC wrappers for workflow operations.
 * Mirrors the pattern from automation-ipc.ts.
 */

import type {
  WorkflowApi,
  WorkflowRunRow,
  WorkflowJournalRecord,
} from '@/components/layout/panels/WorkflowPanel';

// Re-export shared shapes from WorkflowPanel
export type {
  WorkflowRunRow,
  WorkflowJournalRecord,
} from '@/components/layout/panels/WorkflowPanel';

/**
 * Console summary of a YAML workflow definition (`workflow:defs:list/get`).
 * Mirrors `WorkflowDefinitionSummary` in `packages/agent/src/modes/workflow/
 * workflow-files.ts` — duplicated here because @duya/agent exposes no subpath
 * for it. Keep in sync if the source shape changes.
 */
export interface WorkflowDefinitionSummary {
  name: string;
  scope: 'project' | 'global';
  description: string;
  whenToUse?: string;
  /** File path — the authoritative source (console shows it verbatim). */
  file: string;
  params: Array<{ name: string; type: string; required: boolean; default?: unknown }>;
  /** Trigger channels the definition declares (manual is implicit). */
  triggers: Array<'cron' | 'bot' | 'http'>;
  phaseCount: number;
  nodeCount: number;
  /** Only present when the file parsed AND validated. */
  valid: boolean;
  error?: string;
}

// ─── definition CRUD ─────────────────────────────────────────────────────────

export async function listWorkflowDefsIPC(projectDir?: string) {
  const api = window.electronAPI?.workflow as WorkflowApi | undefined;
  return api?.defs.list(projectDir) as Promise<WorkflowDefinitionSummary[]>;
}

export async function getWorkflowDefIPC(
  payload: { name: string; projectDir?: string },
) {
  const api = window.electronAPI?.workflow as WorkflowApi | undefined;
  return api?.defs.get(payload) as Promise<{ summary: WorkflowDefinitionSummary | null; definition: unknown } | { error: string }>;
}

export async function createWorkflowDefIPC(
  payload: { def: unknown; scope?: string; projectDir?: string },
) {
  const api = window.electronAPI?.workflow as WorkflowApi | undefined;
  return api?.defs.create(payload) as Promise<{ ok: boolean; file?: string; name?: string; error?: string }>;
}

export async function updateWorkflowDefIPC(
  name: string,
  payload: { def: unknown; scope?: string; projectDir?: string },
) {
  const api = window.electronAPI?.workflow as WorkflowApi | undefined;
  return api?.defs.update({ name, ...payload }) as Promise<{ ok: boolean; file?: string; name?: string; error?: string }>;
}

export async function deleteWorkflowDefIPC(
  payload: { name: string; scope?: string; projectDir?: string },
) {
  const api = window.electronAPI?.workflow as WorkflowApi | undefined;
  return api?.defs.delete(payload) as Promise<{ ok: boolean; error?: string }>;
}

/**
 * Save a dwf workflow (.dwf.ts) through `workflow:dwf:save` — the same
 * validated store path a hand-written script travels. The recorder
 * convert panel and any other producer converge here.
 */
export async function saveDwfWorkflowIPC(
  payload: { name: string; meta: unknown; script: string; scope?: string; projectDir?: string },
) {
  const api = window.electronAPI?.workflow as WorkflowApi | undefined;
  if (!api?.dwf?.save) {
    return { ok: false, error: 'workflow bridge unavailable' } as { ok: boolean; file?: string; shadowing?: string; error?: string };
  }
  return api.dwf.save(payload) as Promise<{ ok: boolean; file?: string; shadowing?: string; error?: string }>;
}

// ─── run operations ──────────────────────────────────────────────────────────

export async function triggerWorkflowRunIPC(
  payload: { name: string; params?: Record<string, unknown>; projectDir?: string },
) {
  const api = window.electronAPI?.workflow as WorkflowApi | undefined;
  return api?.run(payload) as Promise<{ ok: boolean; runId?: string; sessionId?: string; error?: string }>;
}

export async function listWorkflowRunsIPC(
  filter?: { status?: string; workflowName?: string; limit?: number; offset?: number },
) {
  const api = window.electronAPI?.workflow as WorkflowApi | undefined;
  return api?.list(filter) as Promise<WorkflowRunRow[]>;
}

export async function deleteWorkflowRunIPC(id: string) {
  const api = window.electronAPI?.workflow as WorkflowApi | undefined;
  return api?.delete(id) as Promise<boolean>;
}

export async function cancelWorkflowRunIPC(
  id: string,
) {
  const api = window.electronAPI?.workflow as WorkflowApi | undefined;
  return api?.cancel(id) as Promise<{ ok: boolean; reason?: string }>;
}

export async function getWorkflowRunJournalIPC(runId: string) {
  const api = window.electronAPI?.workflow as WorkflowApi | undefined;
  return api?.journal(runId) as Promise<unknown[]>;
}
