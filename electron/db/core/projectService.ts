import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Database } from 'better-sqlite3';
import { getCoreStores } from '../core-connection';
import { getDb as getMemoryStateDb } from '../../memory-state/db';
import {
  ProjectStore,
  serializeProjectPaths,
  parseProjectPaths,
} from './project-store';
import type { ProjectPathEntry, ProjectRow } from './project-store';
import { normalizeProjectPathEntries, MAX_PROJECT_PATH_LENGTH } from './project-service-paths';

/**
 * Project entity service (ex Plan 525 Phase 3, moved to core in plan 534).
 *
 * The projects / project_bots rows now live in `duya-core.db` (ProjectStore).
 * The service owns the global plans directory layout:
 *
 *   ~/.duya/projects/<project_id>/
 *     plans/
 *       index.json          — plan index for this project
 *       active/<NNN>-slug.md
 *       completed/<NNN>-slug.md
 *     AGENTS.md             — seeded project-level instructions
 *
 * The `projectsRoot` option exists for tests; production resolves
 * `~/.duya/projects` (DUYA_TEST-namespace aware).
 *
 * DB routing:
 *   - `projects.*` / `project_bots`  → core ProjectStore (default `getCoreStores()`).
 *   - `rollout_catalog` unbind on delete → memory DB (memory-state catalog).
 *
 * `normalizeProjectPathEntries` is imported locally (so `createProject` can
 * call it) and re-exported — it remains a public entry point for consumers
 * that previously imported it from the memory-state service. Its
 * implementation lives in `./project-service-paths`.
 */

export { normalizeProjectPathEntries, MAX_PROJECT_PATH_LENGTH };

export type PlanStatus = 'active' | 'paused' | 'done' | 'blocked';

/** One plan entry inside a project's plans/index.json (Plan 525 §3.4). */
export interface PlansIndexEntry {
  id: number;
  slug: string;
  title: string;
  status: PlanStatus;
  priority?: string;
  tags?: string[];
  /** Relative to the plans dir, e.g. `active/525-project-entity.md`. */
  file: string;
  /** YYYY-MM-DD. */
  created: string;
  /** YYYY-MM-DD. */
  updated: string;
}

export interface PlansIndex {
  projectId: string;
  plans: PlansIndexEntry[];
}

export interface CreateProjectInput {
  name: string;
  description?: string | null;
  /**
   * Path entries for the project; `paths[0].path` implicitly derives
   * `canonical_root` (Plan 525 §7). At least one path is required.
   */
  paths: Array<{ path: string; description?: string | null }>;
  /** Avatar icon name (migration 0013). NULL/undefined = default folder icon. */
  icon?: string | null;
  /** Avatar accent color keyword (migration 0013). NULL/undefined = default. */
  color?: string | null;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string | null;
  /** Replacement path list; paths[0].path becomes the new canonical_root. */
  paths?: Array<{ path: string; description?: string | null }>;
  icon?: string | null;
  color?: string | null;
}

export interface ProjectServiceOptions {
  /** Core projects DB handle. Defaults to `getCoreStores().coreDb.db`. */
  projectsDb?: Database;
  /** Memory DB handle (rollout_catalog). Defaults to memory-state `getDb()`. */
  memoryDb?: Database;
  /** Test injection: overrides `~/.duya/projects` (or its test-namespace root). */
  projectsRoot?: string;
}

function defaultProjectsDb(): Database {
  return getCoreStores().coreDb.db;
}

function getMemoryDb(): Database {
  return getMemoryStateDb();
}

function store(opts?: ProjectServiceOptions): ProjectStore {
  const pdb = opts?.projectsDb ?? opts?.memoryDb ?? defaultProjectsDb();
  return new ProjectStore(pdb);
}

/**
 * Default AGENTS.md body seeded into `~/.duya/projects/<projectId>/AGENTS.md`
 * when a project is first created.
 */
export const DEFAULT_PROJECT_AGENTS_MD_TEMPLATE = `# Project: {projectName}

> Seeded by duya {duyaVersion} on {createdAt}. This is the project's home
> AGENTS.md — loaded as project-level instruction whenever an Agent
> session lands under this project. Edit freely; duya will not overwrite
> an existing file.

## 1. What this project is

_Describe the project: goal, scope, audience, success criteria._

- **Project ID**: \`{projectId}\`
- **Canonical root**: \`{canonicalRoot}\`
- **Home directory**: \`~/.duya/projects/{projectId}/\` (duya-owned: plans/, AGENTS.md)
- **Created**: {createdAt}

## 2. How duya manages projects

A duya project is a **long-lived entity**, not a one-off chat. It owns:

- a stable \`project_id\` (UUID) — survives renames, moves, restarts
- a home directory (\`~/.duya/projects/<id>/\`) — duya-internal storage
- a list of working paths (\`projects.paths\`) — your code/data locations
- a plans index (\`plans/index.json\`) — active and completed work

Anything that should outlive a single session lives in the project's
plans. Sessions come and go; plans persist.

## 3. The plan toolchain (Plan 525 §3)

duya exposes one built-in tool scoped to this project:

| Tool | Action | When to call |
| --- | --- | --- |
| \`plan\` | \`action: 'status'\` | Start of a new session, or whenever you need to know which plans are active / completed / paused. First call in any session should be \`plan({ action: 'status', projectId: '...' })\`. |
| \`plan\` | \`action: 'search'\` | Cross-plan lookup: find a past decision, constraint, or reference. Pass keywords and (optionally) a \`plan_id\` filter. |
| \`plan\` | \`action: 'complete'\` | After every checkbox is done and verification evidence is attached. Moves the plan from \`plans/active/\` to \`plans/completed/\`. |

**Workflow**:

1. **Before coding**, run \`plan({ action: 'status', projectId: '...' })\`. If an active plan covers this
   work, extend it. If not, open a new plan (via duya's standard plan
   authoring flow — not in this file).
2. **During work**, keep the plan's checkboxes in sync with reality.
   Update the plan as you commit, not after the fact.
3. **Before declaring done**, grep the plan for leftover TODOs and
   investigation items. Only call \`plan({ action: 'complete', ... })\` when everything is
   resolved and verification evidence is in place.

## 4. Long-term project hygiene

- **One plan = one milestone.** Don't bundle "refactor X + ship Y +
  investigate Z" into a single plan — split them.
- **Every plan has**: goal, phased checkboxes, a \`## Decisions\` log
  (append-only), a \`## Verification\` section, and a handoff note for
  the next session.
- **Sessions are connected via plans, not chat history.** Agents have
  no memory; the plan is the only durable handoff between sessions.
- **\`plans/completed/\` over time IS the project timeline.** Six months
  from now, the \`plans/completed/\` tree tells the story of what shipped
  and why.
- **Commit + plan updates in the same change.** Code, plan checkbox,
  and (if applicable) \`## Decisions\` entry move together.

## 5. Don't

- Don't edit \`plans/index.json\` by hand — duya writes it atomically.
- Don't put code or non-plan files in the home directory
  (\`~/.duya/projects/<id>/\`). Code lives under the canonical root.
- Don't start architectural changes without a plan. \`plan_status\` first,
  then decide: extend an existing plan, or open a new one.
`;

/** Resolve `~/.duya/projects` (test-namespace aware). */
export function resolveProjectsRoot(): string {
  const base = path.join(os.homedir(), '.duya');
  if (process.env.DUYA_TEST === '1') {
    const ns = process.env.DUYA_TEST_NAMESPACE;
    if (ns && /^[a-zA-Z0-9_-]+$/.test(ns)) return path.join(base, 'test-namespaces', ns, 'projects');
  }
  return path.join(base, 'projects');
}

function projectsBase(opts?: ProjectServiceOptions): string {
  return opts?.projectsRoot ?? resolveProjectsRoot();
}

export function projectPlansDir(projectId: string, opts?: ProjectServiceOptions): string {
  return path.join(projectsBase(opts), projectId, 'plans');
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Create the plans directory skeleton for a project:
 * `plans/`, `plans/active/`, `plans/completed/`. Idempotent.
 */
export function ensurePlansDirs(
  projectId: string,
  opts?: ProjectServiceOptions
): { plansDir: string; activeDir: string; completedDir: string } {
  const plansDir = projectPlansDir(projectId, opts);
  const activeDir = path.join(plansDir, 'active');
  const completedDir = path.join(plansDir, 'completed');
  fs.mkdirSync(activeDir, { recursive: true });
  fs.mkdirSync(completedDir, { recursive: true });
  return { plansDir, activeDir, completedDir };
}

/**
 * Best-effort reconciliation: ensure every project row in the core
 * ProjectStore has a `plans/active/` + `plans/completed/` directory.
 *
 * Background — projects migrated in from the legacy
 * `project_path_aliases` era (Plan 525 Phase 2.4) never went through
 * `createProject`, so they exist as rows but lack `~/.duya/projects/<id>/`
 * entirely. `updateProject` repairs a single project the first time the
 * user edits it; this function repairs the rest in one shot.
 *
 * Semantics:
 *   - Only projects whose plans dir is missing get a directory created.
 *   - We do NOT touch `index.json` — projects that already have a real
 *     plan index keep their existing entries.
 *   - Errors are swallowed and logged; one bad project id must not
 *     prevent the rest from being repaired.
 *
 * Designed to be called once from `projects:list` (fire-and-forget) so
 * the renderer doesn't pay the disk-walk latency.
 */
export function reconcileProjectPlansDirs(opts?: ProjectServiceOptions): {
  scanned: number;
  repaired: number;
  errors: string[];
} {
  const rows = store(opts).list();
  let repaired = 0;
  const errors: string[] = [];
  for (const row of rows) {
    try {
      const dir = projectPlansDir(row.project_id, opts);
      if (!fs.existsSync(dir)) {
        ensurePlansDirs(row.project_id, opts);
        repaired += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${row.project_id}: ${message}`);
    }
  }
  return { scanned: rows.length, repaired, errors };
}

/** Write a project's plans/index.json (temp + rename, atomic single-writer). */
export function writePlansIndex(
  projectId: string,
  plans: PlansIndexEntry[],
  opts?: ProjectServiceOptions
): PlansIndex {
  ensurePlansDirs(projectId, opts);
  const index: PlansIndex = { projectId, plans };
  const indexPath = path.join(projectPlansDir(projectId, opts), 'index.json');
  const tmpPath = `${indexPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(index, null, 2), 'utf8');
  fs.renameSync(tmpPath, indexPath);
  return index;
}

function buildDefaultAgentsMd(args: {
  projectName: string;
  projectId: string;
  canonicalRoot: string;
  createdAt: string;
}): string {
  const placeholders: Record<string, string> = {
    projectName: args.projectName,
    projectId: args.projectId,
    canonicalRoot: args.canonicalRoot,
    createdAt: args.createdAt,
    duyaVersion: readDuyaVersion(),
  };
  return DEFAULT_PROJECT_AGENTS_MD_TEMPLATE.replace(
    /\{(projectName|projectId|canonicalRoot|createdAt|duyaVersion)\}/g,
    (_, key: string) => placeholders[key] ?? '',
  );
}

let _cachedDuyaVersion: string | null = null;
function readDuyaVersion(): string {
  if (_cachedDuyaVersion !== null) return _cachedDuyaVersion;
  try {
    const pkgPath = require.resolve('../../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    _cachedDuyaVersion = pkg.version ?? 'unknown';
  } catch {
    _cachedDuyaVersion = 'unknown';
  }
  return _cachedDuyaVersion;
}

/**
 * Idempotent: if `~/.duya/projects/<projectId>/AGENTS.md` already exists
 * (user edited, or a previous create partially ran), do nothing.
 */
export function ensureProjectAgentsMd(
  projectId: string,
  args: { projectName: string; canonicalRoot: string },
  opts?: ProjectServiceOptions
): { path: string; created: boolean } {
  const homeDir = path.join(projectsBase(opts), projectId);
  fs.mkdirSync(homeDir, { recursive: true });
  const agentsPath = path.join(homeDir, 'AGENTS.md');
  if (fs.existsSync(agentsPath)) {
    return { path: agentsPath, created: false };
  }
  const content = buildDefaultAgentsMd({
    projectName: args.projectName,
    projectId,
    canonicalRoot: args.canonicalRoot,
    createdAt: today(),
  });
  const tmpPath = `${agentsPath}.tmp`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, agentsPath);
  return { path: agentsPath, created: true };
}

/** Read a project's plans/index.json. Missing/corrupt → empty index. */
export function readPlansIndex(projectId: string, opts?: ProjectServiceOptions): PlansIndex {
  const indexPath = path.join(projectPlansDir(projectId, opts), 'index.json');
  let raw: string;
  try {
    raw = fs.readFileSync(indexPath, 'utf8');
  } catch {
    return { projectId, plans: [] };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PlansIndex>;
    if (!Array.isArray(parsed.plans)) return { projectId, plans: [] };
    return { projectId, plans: parsed.plans as PlansIndexEntry[] };
  } catch {
    return { projectId, plans: [] };
  }
}

/**
 * Create a project row (core ProjectStore) and its plans directory skeleton.
 * `canonical_root` derives from `paths[0].path`. Not idempotent — each call
 * mints a new UUID.
 */
export function createProject(input: CreateProjectInput, opts?: ProjectServiceOptions): ProjectRow {
  if (!Array.isArray(input.paths) || input.paths.length === 0) {
    throw new Error('project-service: at least one path entry is required (canonical_root derives from paths[0])');
  }
  const entries = normalizeProjectPathEntries(input.paths);
  const canonicalRoot = entries[0].path;
  const s = store(opts);

  const row = s.insert({
    canonical_root: canonicalRoot,
    name: input.name,
    description: input.description ?? null,
    paths: serializeProjectPaths(entries),
    icon: input.icon ?? null,
    color: input.color ?? null,
  });

  ensurePlansDirs(row.project_id, opts);
  writePlansIndex(row.project_id, [], opts);
  ensureProjectAgentsMd(row.project_id, { projectName: input.name, canonicalRoot }, opts);

  return row;
}

/** List all project rows (raw). */
export function listProjects(opts?: { projectsDb?: Database; memoryDb?: Database }): ProjectRow[] {
  return store(opts).list();
}

/** Fetch a single project row by id. Returns null when not found. */
export function getProject(
  projectId: string,
  opts?: { projectsDb?: Database; memoryDb?: Database }
): ProjectRow | null {
  return store(opts).get(projectId);
}

/** Convenience: parsed path entries of a project row. */
export function projectPaths(row: ProjectRow): ProjectPathEntry[] {
  return parseProjectPaths(row.paths);
}

/**
 * Patch a project row. When `paths` is replaced, canonical_root is re-derived
 * from paths[0].path. Returns the updated row, or null when missing.
 */
export function updateProject(
  projectId: string,
  patch: UpdateProjectInput,
  opts?: ProjectServiceOptions
): ProjectRow | null {
  if (!projectId || typeof projectId !== 'string') return null;
  const s = store(opts);
  if (!s.get(projectId)) return null;

  const resultPatch: Record<string, unknown> = {};
  if (typeof patch.name === 'string') resultPatch.name = patch.name;
  if (patch.description !== undefined) resultPatch.description = patch.description;
  if (Array.isArray(patch.paths) && patch.paths.length > 0) {
    const entries = normalizeProjectPathEntries(patch.paths);
    resultPatch.paths = serializeProjectPaths(entries);
    resultPatch.canonical_root = entries[0].path;
  }
  if (patch.icon !== undefined) resultPatch.icon = patch.icon;
  if (patch.color !== undefined) resultPatch.color = patch.color;

  if (Object.keys(resultPatch).length > 0) {
    s.update(projectId, resultPatch as Parameters<ProjectStore['update']>[1]);
  }
  // Ensure the plans directory skeleton exists for every project that
  // gets touched by an update. This is idempotent (mkdir recursive) and
  // safe even when the project was migrated in from the legacy
  // `project_path_aliases` era and never went through `createProject`
  // (Plan 525 Phase 3 only ran `ensurePlansDirs` from `createProject`).
  // The renderer surfaces projects that pre-date the plans-dir layout
  // (no `~/.duya/projects/<id>/plans/`) and editing them via
  // ProjectsView → 编辑项目 was a no-op for directory creation; this
  // hook repairs that. We do NOT call `writePlansIndex` here — if a
  // project already has real plans we'd overwrite them with `[]`.
  ensurePlansDirs(projectId, opts);
  return s.get(projectId);
}

/**
 * Delete a project row. Sessions, threads and rollout files are NOT touched.
 * `rollout_catalog` rows referencing the project are unbound
 * (scope_kind → 'global', project_id → NULL).
 */
export function deleteProject(projectId: string, opts?: ProjectServiceOptions): boolean {
  if (!projectId || typeof projectId !== 'string') return false;
  const s = store(opts);
  if (!s.get(projectId)) return false;
  const memoryDb = opts?.memoryDb ?? getMemoryDb();
  const txn = memoryDb.transaction(() => {
    memoryDb
      .prepare(
        `UPDATE rollout_catalog
         SET project_id = NULL, scope_kind = 'global'
         WHERE project_id = ?`
      )
      .run(projectId);
    return true;
  });
  txn.immediate();
  s.deleteBotsByProject(projectId);
  return s.delete(projectId);
}