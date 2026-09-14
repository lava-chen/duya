/**
 * PlanTool storage layer — TypeScript port of plans-core.cjs logic.
 *
 * Manages plan files under `~/.duya/projects/<projectId>/plans/`:
 * - active/  — currently active plans
 * - completed/ — archived plans
 * - index.json — derived cache, rebuilt on every write
 *
 * This is the shared logic used by PlanStatusTool, PlanSearchTool,
 * and PlanCompleteTool.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

export const PROJECT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const PLAN_FILE_PATTERN = /^(\d+)-([a-z0-9-]+)\.md$/;

export class PlansError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'PlansError';
  }
}

export function assertProjectId(projectId: string): void {
  if (typeof projectId !== 'string' || !PROJECT_ID_PATTERN.test(projectId)) {
    throw new PlansError(
      `projectId must match ${PROJECT_ID_PATTERN} (got: ${JSON.stringify(projectId)})`,
      'invalid_project_id'
    );
  }
}

function plansDirFor(projectsRoot: string, projectId: string): string {
  return path.join(projectsRoot, projectId, 'plans');
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Resolve `~/.duya/projects` (DUYA_TEST-namespace aware). */
export function resolveProjectsRoot(): string {
  const base = path.join(os.homedir(), '.duya');
  if (process.env.DUYA_TEST === '1') {
    const ns = process.env.DUYA_TEST_NAMESPACE;
    if (ns && /^[a-zA-Z0-9_-]+$/.test(ns)) {
      return path.join(base, 'test-namespaces', ns, 'projects');
    }
  }
  return path.join(base, 'projects');
}

interface PlanEntry {
  id: number | null;
  slug: string;
  title: string;
  status: string;
  priority?: string;
  tags?: string[];
  file: string;
  created?: string;
  updated?: string;
}

interface ParsedFrontmatter {
  fields: Record<string, unknown>;
  body: string;
}

function parseFrontmatter(text: string): ParsedFrontmatter {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { fields: {}, body: text };
  const fields: Record<string, unknown> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1).trim();
      fields[key] = inner ? inner.split(',').map((t) => t.trim().replace(/^['"]|['"]$/g, '')) : [];
      continue;
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }
  return { fields, body: text.slice(match[0].length) };
}

function toEntry(projectId: string, dirName: string, fileName: string, fields: Record<string, unknown>): PlanEntry {
  const fileMatch = fileName.match(PLAN_FILE_PATTERN);
  const idNum = typeof fields.id === 'string' || typeof fields.id === 'number' ? Number(fields.id) : NaN;
  return {
    id: Number.isFinite(idNum) ? idNum : fileMatch ? Number(fileMatch[1]) : null,
    slug: fileMatch ? fileMatch[2] : fileName.replace(/\.md$/, ''),
    title: typeof fields.title === 'string' ? fields.title : fileName.replace(/\.md$/, ''),
    status: typeof fields.status === 'string' ? fields.status : dirName === 'completed' ? 'done' : 'active',
    priority: typeof fields.priority === 'string' ? fields.priority : undefined,
    tags: Array.isArray(fields.tags) ? fields.tags as string[] : undefined,
    file: `${dirName}/${fileName}`,
    created: typeof fields.created === 'string' ? fields.created as string : undefined,
    updated: typeof fields.updated === 'string' ? fields.updated as string : undefined,
  };
}

function normalizeEntry(entry: PlanEntry): PlanEntry {
  return {
    id: entry.id,
    slug: entry.slug,
    title: entry.title,
    status: entry.status,
    priority: entry.priority,
    tags: entry.tags,
    file: entry.file,
    created: entry.created,
    updated: entry.updated,
  };
}

interface PlansIndex {
  projectId: string;
  plans: PlanEntry[];
}

/**
 * Rebuild the plan index for one project by scanning active/ and completed/.
 * Writes index.json only when its content actually changed.
 */
function buildIndex(projectsRoot: string, projectId: string): PlansIndex {
  assertProjectId(projectId);
  const plansDir = plansDirFor(projectsRoot, projectId);
  const entries: PlanEntry[] = [];
  for (const dirName of ['active', 'completed'] as const) {
    const dir = path.join(plansDir, dirName);
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const fileName of files.filter((f) => f.endsWith('.md')).sort()) {
      let text = '';
      try {
        text = fs.readFileSync(path.join(dir, fileName), 'utf8');
      } catch {
        continue;
      }
      const { fields } = parseFrontmatter(text);
      entries.push(toEntry(projectId, dirName, fileName, fields));
    }
  }
  entries.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  const index: PlansIndex = { projectId, plans: entries.map(normalizeEntry) };

  const indexPath = path.join(plansDir, 'index.json');
  const serialized = JSON.stringify(index, null, 2);
  let existing = '';
  try {
    existing = fs.readFileSync(indexPath, 'utf8');
  } catch {
    // missing index — write it below
  }
  if (existing !== serialized) {
    fs.mkdirSync(plansDir, { recursive: true });
    const tmp = `${indexPath}.tmp`;
    fs.writeFileSync(tmp, serialized, 'utf8');
    fs.renameSync(tmp, indexPath);
  }
  return index;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PlanStatusInput {
  projectId: string;
  status?: 'active' | 'all';
}

export interface PlanStatusResult {
  projectId: string;
  plans: PlanEntry[];
  /** ID health check — only present when there are plans with numeric IDs. */
  idHealth?: {
    /** true if any ID gaps or skips were detected. */
    hasIssues: boolean;
    /** Sorted array of all missing IDs in the sequence. */
    missingIds: number[];
    /** Each skip point: from ID → to ID and how many are missing between them. */
    skips: Array<{ from: number; to: number; missing: number[] }>;
    /** Human-readable warning message. */
    warning: string | null;
  };
}

/**
 * plan_status — list plans of one project.
 * `status` defaults to 'active'; 'all' returns every bucket.
 *
 * Also computes ID health: checks for missing IDs and skip points in the
 * numeric ID sequence, and surfaces a warning when issues are found.
 */
export function planStatus(input: PlanStatusInput): PlanStatusResult {
  assertProjectId(input.projectId);
  const status = input.status ?? 'active';
  if (status !== 'active' && status !== 'all') {
    throw new PlansError("status must be 'active' or 'all'", 'invalid_status');
  }
  const projectsRoot = resolveProjectsRoot();
  const index = buildIndex(projectsRoot, input.projectId);
  const plans = status === 'all' ? index.plans : index.plans.filter((p) => p.status === 'active');

  // Compute ID health — check for gaps and skips in numeric IDs
  const idHealth = computeIdHealth(plans.map((p) => p.id).filter((id): id is number => id !== null));

  return { projectId: input.projectId, plans, ...(idHealth ? { idHealth } : {}) };
}

/**
 * Analyze a sorted list of plan IDs and detect gaps / skips.
 * Returns undefined when there are fewer than 2 plans (nothing to check).
 */
function computeIdHealth(ids: number[]): PlanStatusResult['idHealth'] | undefined {
  if (ids.length < 2) return undefined;

  const missingIds: number[] = [];
  const skips: PlanStatusResult['idHealth'] extends undefined ? never : NonNullable<PlanStatusResult['idHealth']>['skips'] = [];

  for (let i = 1; i < ids.length; i++) {
    const prev = ids[i - 1];
    const curr = ids[i];
    const expected = prev + 1;
    if (curr > expected) {
      const missing: number[] = [];
      for (let m = expected; m < curr; m++) {
        missing.push(m);
        missingIds.push(m);
      }
      skips.push({ from: prev, to: curr, missing });
    }
  }

  if (missingIds.length === 0) return undefined;

  const missingLabel = missingIds.length <= 5
    ? missingIds.join(', ')
    : `${missingIds.slice(0, 5).join(', ')}, ... (+${missingIds.length - 5} more)`;

  const warning =
    skips.length === 1
      ? `Plan ID sequence has ${missingIds.length} gap(s): missing ${missingLabel}. Check if any plan was deleted or if the ID counter drifted.`
      : `Plan ID sequence has ${skips.length} skip point(s) with ${missingIds.length} total gaps: missing ${missingLabel}. Check if any plan was deleted or if the ID counter drifted.`;

  return {
    hasIssues: true,
    missingIds,
    skips,
    warning,
  };
}

export interface PlanSearchInput {
  query: string;
  scope?: 'all' | 'project';
  projectId?: string;
}

export interface PlanSearchResult {
  results: Array<{
    projectId: string;
    id: number | null;
    slug: string;
    title: string;
    status: string;
    file: string;
    snippet: string;
  }>;
}

/**
 * plan_search — keyword search across projects (or scoped to one).
 */
export function planSearch(input: PlanSearchInput): PlanSearchResult {
  const query = typeof input.query === 'string' ? input.query.trim().toLowerCase() : '';
  if (!query) throw new PlansError('query is required', 'invalid_query');
  const scope = input.scope ?? 'all';
  if (scope !== 'all' && scope !== 'project') {
    throw new PlansError("scope must be 'all' or 'project'", 'invalid_scope');
  }
  if (scope === 'project') assertProjectId(input.projectId!);

  const projectsRoot = resolveProjectsRoot();
  const results: PlanSearchResult['results'] = [];
  let projectIds: string[];

  if (scope === 'project' && input.projectId) {
    projectIds = [input.projectId];
  } else {
    let dirents: fs.Dirent[] = [];
    try {
      dirents = fs.readdirSync(projectsRoot, { withFileTypes: true });
    } catch {
      return { results: [] };
    }
    projectIds = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  }

  for (const projectId of projectIds) {
    if (!PROJECT_ID_PATTERN.test(projectId)) continue;
    let index: PlansIndex;
    try {
      index = buildIndex(projectsRoot, projectId);
    } catch {
      continue;
    }
    for (const plan of index.plans) {
      const haystack = [plan.title, plan.slug, plan.id !== null ? String(plan.id) : '', ...(plan.tags ?? [])]
        .join(' ')
        .toLowerCase();
      if (haystack.includes(query)) {
        results.push({
          projectId,
          id: plan.id,
          slug: plan.slug,
          title: plan.title,
          status: plan.status,
          file: plan.file,
          snippet: plan.tags && plan.tags.length ? `${plan.title} — [${plan.tags.join(', ')}]` : plan.title,
        });
      }
    }
  }
  results.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  return { results: results.slice(0, 50) };
}

export interface PlanCompleteInput {
  projectId: string;
  planId: number;
}

export interface PlanCompleteResult {
  ok: boolean;
  newFile: string;
}

/**
 * plan_complete — flip frontmatter status to 'done' and move file from active/ to completed/.
 */
export function planComplete(input: PlanCompleteInput): PlanCompleteResult {
  assertProjectId(input.projectId);
  const planId = Number(input.planId);
  if (!Number.isInteger(planId)) {
    throw new PlansError('planId must be an integer', 'invalid_plan_id');
  }

  const projectsRoot = resolveProjectsRoot();
  const plansDir = plansDirFor(projectsRoot, input.projectId);
  const index = buildIndex(projectsRoot, input.projectId);
  const entry = index.plans.find((p) => p.id === planId);
  if (!entry) {
    throw new PlansError(`plan ${planId} not found in project ${input.projectId}`, 'plan_not_found');
  }
  if (entry.status === 'done') {
    throw new PlansError(`plan ${planId} is already completed`, 'already_completed');
  }

  const sourcePath = path.join(plansDir, entry.file);
  let text: string;
  try {
    text = fs.readFileSync(sourcePath, 'utf8');
  } catch (err) {
    throw new PlansError(`plan file unreadable: ${(err as Error).message}`, 'file_unreadable');
  }
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!fm || !/(^|\n)status:/.test(fm[1])) {
    throw new PlansError(
      `plan file has no status frontmatter field — fix it manually`,
      'missing_frontmatter'
    );
  }
  const updatedFm = fm[1].replace(/(^|\n)status:[^\n]*/, '$1status: done') +
    (/(^|\n)updated:/.test(fm[1]) ? '' : `\nupdated: ${today()}`);
  const updatedText = text.replace(fm[0], `---\n${updatedFm}\n---\n`);

  const targetRel = path.join('completed', path.basename(entry.file));
  const targetPath = path.join(plansDir, targetRel);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(sourcePath, updatedText, 'utf8');
  fs.renameSync(sourcePath, targetPath);

  buildIndex(projectsRoot, input.projectId);

  return { ok: true, newFile: targetPath };
}
