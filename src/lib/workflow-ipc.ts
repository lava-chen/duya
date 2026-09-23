/**
 * workflow-ipc.ts — renderer-side IPC wrappers for workflow operations.
 * Mirrors the pattern from automation-ipc.ts.
 *
 * All workflow definitions are now in `.dwf.ts` format (frontmatter +
 * TypeScript script). The old YAML-based `defs.*` API has been removed.
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

/** Compact summary of a workflow definition, shown in lists + breadcrumb. */
export interface WorkflowDefinitionSummary {
  name: string;
  description: string;
  when_to_use?: string;
  args?: unknown;
  file?: string;
  scope: 'project' | 'global';
}

// ─── dwf saved workflow wrappers ─────────────────────────────────────────────

/**
 * List saved workflows (.dwf.ts) via the dwf surface.
 * Returns { entries, invalid, dirs } grouped by project + global scope.
 */
export async function listDwfWorkflowsIPC(projectDir?: string) {
  const api = window.electronAPI?.workflow as WorkflowApi | undefined;
  return api?.dwf?.list(projectDir) as Promise<{
    entries: Array<{
      name: string;
      description: string;
      whenToUse?: string;
      // `unknown` here used to make every consumer cast before it could read a
      // declared arg; the dwf list handler returns the frontmatter verbatim, so
      // the declaration shape is known.
      args?: Record<string, DwfArgDeclaration>;
      scope: 'project' | 'global';
      path: string;
    }>;
    invalid: Array<{ path: string; error: string }>;
    dirs: string[];
  }>;
}

// ─── definition library (YAML .yaml) ────────────────────────────────────────

/**
 * Get a single YAML workflow definition via `workflow:defs:get`.
 * Returns { summary, definition } where definition matches WorkflowDefView.
 */
export async function getWorkflowDefIPC(payload: {
  name: string;
  projectDir?: string;
}) {
  const api = window.electronAPI?.workflow as WorkflowApi | undefined;
  return api?.defs?.get(payload) as Promise<{
    summary: WorkflowDefinitionSummary;
    definition: {
      name: string;
      description: string;
      when_to_use?: string;
      params: Array<{ name: string; type: string; required?: boolean; default?: unknown }>;
      phases: Array<{ phase: string; title: string; detail?: string; nodes: unknown[] }>;
    };
  } | null>;
}

// ─── dwf saved workflow wrappers ─────────────────────────────────────────────

/**
 * Get a single saved workflow's full content (frontmatter meta + script).
 */
/**
 * Get a single saved workflow's full content (frontmatter meta + script).
 */
export async function getDwfWorkflowIPC(payload: {
  name: string;
  projectDir?: string;
  homeDir?: string;
}) {
  const api = window.electronAPI?.workflow as WorkflowApi | undefined;
  return api?.dwf?.get(payload) as Promise<{
    ok: true;
    name: string;
    path: string;
    scope: 'project' | 'global';
    meta: { description: string; whenToUse?: string; args?: unknown };
    script: string;
    source: string;
    bodyLineOffset: number;
  } | {
    ok: false;
    reason: 'invalid_name' | 'not_found' | 'parse_error' | 'read_error';
    detail?: string;
    path?: string;
  }>;
}

/**
 * Get a single saved workflow's detail as a WorkflowDefView.
 *
 * This bridges the dwf frontmatter surface → WorkflowDetailView's expected
 * `WorkflowDefView` shape.  The dwf frontmatter only carries metadata
 * (description / whenToUse / args); phase/graph data is only in the script
 * body which requires the agent worker to parse.  We return the metadata
 * with an empty phases array — the graph panel shows a placeholder until the
 * script is loaded through the conversation pipeline.
 */
/**
 * One entry of the frontmatter `args` record (mirrors the agent-side
 * `SavedWorkflowArgDeclaration`). Kept as a renderer-local structural type so
 * the detail page can edit the declaration without importing agent internals.
 */
export interface DwfArgDeclaration {
  type?: 'string' | 'number' | 'boolean' | 'json';
  /** Doc string shown in the detail table's 说明 column. */
  description?: string;
  required?: boolean;
  default?: unknown;
}

/** Frontmatter metadata block of a saved `.dwf.ts` workflow. */
export interface DwfMeta {
  description: string;
  whenToUse?: string;
  args?: Record<string, DwfArgDeclaration>;
}

export async function getWorkflowDwfDetailIPC(payload: {
  name: string;
  projectDir?: string;
  homeDir?: string;
}): Promise<{
  summary: WorkflowDefinitionSummary;
  definition: {
    name: string;
    description: string;
    when_to_use?: string;
    params: Array<{
      name: string;
      type: string;
      required?: boolean;
      default?: unknown;
      /** Arg declaration doc string — the detail table's 说明 column. */
      description?: string;
    }>;
    phases: Array<{ phase: string; title: string; detail?: string; nodes: unknown[] }>;
    /** Raw .dwf.ts body (frontmatter stripped) — read-only viewer. */
    script?: string;
  };
  /**
   * Frontmatter metadata verbatim. The detail page edits it and saves the
   * whole `{ meta, script }` pair back through `workflow:dwf:save`, so the
   * raw declaration (including per-arg `description`) must survive the trip.
   */
  meta: DwfMeta;
  /** Scope as resolved by the store (a shadowing project file wins). */
  resolvedScope: 'project' | 'global';
} | null> {
  const res = await getDwfWorkflowIPC(payload);
  if (!res || res.ok === false) return null;

  // Convert SavedWorkflowMeta args to WorkflowParamView shape.
  // args from frontmatter: { [name]: { type, description?, required?, default? } }
  const meta = res.meta as DwfMeta;
  const rawArgs = meta.args;
  const params = rawArgs
    ? Object.entries(rawArgs).map(([name, spec]) => ({
        name,
        type: spec?.type ?? 'string',
        required: spec?.required ?? false,
        default: spec?.default,
        description: spec?.description,
      }))
    : [];

  const summary: WorkflowDefinitionSummary = {
    name: res.name,
    description: meta.description,
    when_to_use: meta.whenToUse,
    args: meta.args,
    file: res.path,
    scope: res.scope,
  };

  return {
    summary,
    definition: {
      name: res.name,
      description: meta.description,
      when_to_use: meta.whenToUse,
      params,
      phases: [], // dwf frontmatter has no phase data — graph loads via conversation
      script: res.script, // raw .dwf.ts body for display
    },
    meta,
    resolvedScope: res.scope,
  };
}

/**
 * Save a dwf workflow (.dwf.ts) through `workflow:dwf:save`.
 */
export async function saveDwfWorkflowIPC(
  payload: { name: string; meta: unknown; script: string; scope?: string; projectDir?: string },
) {
  const api = window.electronAPI?.workflow as WorkflowApi | undefined;
  if (!api?.dwf?.save) {
    return { ok: false, error: 'workflow bridge unavailable' } as { ok: boolean; file?: string; shadowing?: string; error: string };
  }
  return api.dwf.save(payload) as Promise<{ ok: boolean; file?: string; shadowing?: string; error?: string }>;
}

/**
 * Delete a saved workflow (.dwf.ts).
 */
export async function deleteDwfWorkflowIPC(
  payload: { name: string; scope?: string; projectDir?: string; homeDir?: string },
) {
  const api = window.electronAPI?.workflow as WorkflowApi | undefined;
  return api?.dwf?.delete(payload) as Promise<{ ok: boolean; error?: string }>;
}

// ─── run operations ──────────────────────────────────────────────────────────

/**
 * Session-anchor counterpart of {@link triggerLibraryRunIPC}: the channel itself
 * is unchanged and still live (`workflow:run`), but since plan 560 §7.5 no UI
 * entry point submits through it any more — the three ▶ buttons all open the
 * launch dialog, which uses the run anchor. Kept as the documented wrapper for
 * the in-session path.
 */
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
  return api?.cancel(id) as Promise<{ ok: boolean; reason?: string; error?: string }>;
}

export async function getWorkflowRunJournalIPC(runId: string) {
  const api = window.electronAPI?.workflow as WorkflowApi | undefined;
  return api?.journal(runId) as Promise<unknown[]>;
}

// ─── plan 560: run-anchored surface ─────────────────────────────────────────

export type WorkflowRunOrigin = 'library' | 'session' | 'agent' | 'cron';

/** One published artifact of a run — bytes live at `<root>/<runId>/<name>`. */
export interface WorkflowArtifactRef {
  id: string;
  name: string;
  contentType: string;
  bytes: number;
  relPath: string;
}

/**
 * A run as the library sees it (plan 560 §5.1). Mirrors the core store's
 * `WorkflowRun` — including the run-anchoring columns — so the run card can
 * render origin / scope / projectDir without a second lookup.
 */
export interface WorkflowRunRecord {
  id: string;
  workflowName: string;
  status: string;
  origin: WorkflowRunOrigin;
  scope: 'global' | 'project' | null;
  projectDir: string | null;
  parentSessionId: string | null;
  params: Record<string, unknown>;
  artifacts: WorkflowArtifactRef[];
  summary: string | null;
  spentTokens: number | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

/**
 * Launch a library run (run anchor). Returns the new runId, which is the key
 * the caller then subscribes to on the run's SSE stream (D5) — no session is
 * created and nothing lands in a chat transcript.
 */
export async function triggerLibraryRunIPC(payload: {
  name: string;
  params?: Record<string, unknown>;
  projectDir?: string;
  scope?: 'project' | 'global' | null;
}) {
  const api = window.electronAPI?.workflow as WorkflowApi | undefined;
  if (!api?.trigger) {
    return { ok: false, error: 'workflow bridge unavailable' } as {
      ok: boolean;
      runId?: string;
      error?: string;
    };
  }
  return api.trigger(payload);
}

export async function getWorkflowRunRecordIPC(runId: string) {
  const api = window.electronAPI?.workflow as WorkflowApi | undefined;
  return (await api?.status?.(runId)) as WorkflowRunRecord | null | undefined;
}

export async function listWorkflowRunRecordsIPC(filter?: {
  workflowName?: string;
  origin?: WorkflowRunOrigin;
  status?: string;
  limit?: number;
  offset?: number;
}) {
  const api = window.electronAPI?.workflow as WorkflowApi | undefined;
  return (await api?.listRuns?.(filter)) as WorkflowRunRecord[] | undefined;
}

/** Journal backfill — merged with the live SSE stream by `seq` (D5). */
export async function getWorkflowRunEventsIPC(payload: { runId: string; afterSeq?: number }) {
  const api = window.electronAPI?.workflow as WorkflowApi | undefined;
  return (await api?.getEvents?.(payload)) as WorkflowJournalRecord[] | undefined;
}

/** Answer an approval that arrived on the run's SSE stream (D6). */
export async function resolveWorkflowPermissionIPC(payload: {
  runId: string;
  requestId: string;
  decision: 'allow' | 'deny';
}) {
  const api = window.electronAPI?.workflow as WorkflowApi | undefined;
  if (!api?.resolvePermission) return { ok: false, error: 'workflow bridge unavailable' };
  return api.resolvePermission(payload);
}
