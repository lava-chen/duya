/**
 * workflow-ipc.ts — renderer-side IPC wrappers for workflow operations.
 * Mirrors the pattern from automation-ipc.ts.
 */

import type {
  WorkflowApi,
  WorkflowRunRow,
  WorkflowDefinitionSummary,
  WorkflowJournalRecord,
} from '@/components/layout/panels/WorkflowPanel';

// Re-export shared shapes from WorkflowPanel
export type {
  WorkflowRunRow,
  WorkflowDefinitionSummary,
  WorkflowJournalRecord,
} from '@/components/layout/panels/WorkflowPanel';

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

// ─── run operations ──────────────────────────────────────────────────────────

export async function triggerWorkflowRunIPC(
  payload: { name: string; params?: Record<string, unknown>; projectDir?: string },
) {
  const api = window.electronAPI?.workflow as WorkflowApi | undefined;
  return api?.run(payload) as Promise<{ ok: boolean; runId?: string; error?: string }>;
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
