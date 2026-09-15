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
/**
 * Bumped whenever the seeded AGENTS.md body changes materially (e.g.
 * adding the project_id reminder). The reconcile path reads this token
 * from existing files and upgrades only files whose recorded version
 * is strictly less than `CURRENT_PROJECT_AGENTS_MD_VERSION`. Files
 * with no token (legacy) are treated as version 0.
 *
 * Version history (do not renumber existing entries — append only):
 *   1 — initial seed (table-formatted plan toolchain, "Home directory",
 *       stable project_id bullet, `Plan 525 §3` heading).
 *   2 — removed `(Plan 525 §3)` heading suffix; table → 3-bullet list;
 *       `Home directory` → `Project config directory`; dropped
 *       `project_id (UUID)` bullet.
 *   3 — added explicit `Project ID` row in §1, re-added `a project ID
 *       (UUID)` bullet in §2, added `Every call must include
 *       projectId: "<uuid>"` emphasis to §3.
 */
export const CURRENT_PROJECT_AGENTS_MD_VERSION = 3 as const;

/** Marker embedded as an HTML comment at the top of every seeded file. */
export const AGENTS_MD_VERSION_MARKER_PREFIX = '<!-- duya-agents-md:version ';

/** Regex matching the marker line; captures the integer version. */
export const AGENTS_MD_VERSION_REGEX = /<!-- duya-agents-md:version\s+(\d+)\s*-->/;

/**
 * Read the recorded version from an existing AGENTS.md body. Returns
 * 0 when the marker is absent (legacy file) or malformed.
 */
export function readProjectAgentsMdVersion(body: string): number {
  const match = body.match(AGENTS_MD_VERSION_REGEX);
  if (!match) return 0;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/** Build the marker line for a given version. */
export function projectAgentsMdMarker(version: number): string {
  return `${AGENTS_MD_VERSION_MARKER_PREFIX}${version} -->`;
}

export const DEFAULT_PROJECT_AGENTS_MD_TEMPLATE = `${projectAgentsMdMarker(CURRENT_PROJECT_AGENTS_MD_VERSION)}
# Project: {projectName}

> Seeded by duya {duyaVersion} on {createdAt}. This is the project's home
> AGENTS.md — loaded as project-level instruction whenever an Agent
> session lands under this project. Edit freely; duya will not overwrite
> an existing file.

## 1. What this project is

_Describe the project: goal, scope, audience, success criteria._

- **Canonical root**: \`{canonicalRoot}\`
- **Project config directory**: \`~/.duya/projects/{projectId}/\` (duya-owned: plans/, AGENTS.md — your code never lives here)
- **Project ID**: \`{projectId}\` ← pass this to every \`plan\` tool call
- **Created**: {createdAt}

## 2. How duya manages projects

A duya project is a **long-lived entity**, not a one-off chat. It owns:

- a project ID (UUID) — stable across renames, moves, restarts
- a project config directory (\`~/.duya/projects/<id>/\`) — duya-internal storage for plans and this file
- a list of working paths (\`projects.paths\`) — your code/data locations
- a plans index (\`plans/index.json\`) — active and completed work

Anything that should outlive a single session lives in the project's
plans. Sessions come and go; plans persist.

## 3. The plan toolchain

duya exposes one built-in tool scoped to this project: \`plan\`. **Every
call must include \`projectId: "{projectId}"\`** — that's how duya
locates your plans on disk. Use it for three things:

- **\`plan status\`** — list which plans are active / completed /
  paused. First call in any session. If an active plan covers this
  work, extend it; otherwise open a new plan.
- **\`plan search <keywords>\`** — cross-plan lookup for a past
  decision, constraint, or reference. Pass an optional \`plan_id\`
  filter to scope the search.
- **\`plan complete\`** — finalize a plan. Call only after every
  checkbox is done and verification evidence is attached; this moves
  the plan from \`plans/active/\` to \`plans/completed/\`.

**Workflow**:

1. **Before coding**, run \`plan status\` (with this project's ID).
   If an active plan covers this work, extend it. If not, open a new
   plan (via duya's standard plan authoring flow — not in this file).
2. **During work**, keep the plan's checkboxes in sync with reality.
   Update the plan as you commit, not after the fact.
3. **Before declaring done**, grep the plan for leftover TODOs and
   investigation items. Only call \`plan complete\` (with this
   project's ID) when everything is resolved and verification evidence
   is in place.

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
 * Idempotently seed an empty `plans/index.json` for a project. Skips
 * when the file already exists so we never overwrite a real plan
 * index. Used by `ensureProjectPlansSkeleton` for projects that need
 * a complete skeleton (e.g. legacy rows repaired by `updateProject`
 * or `reconcileProjectPlansDirs`).
 */
export function ensurePlansIndex(
  projectId: string,
  opts?: ProjectServiceOptions
): { indexPath: string; written: boolean } {
  const plansDir = projectPlansDir(projectId, opts);
  const indexPath = path.join(plansDir, 'index.json');
  if (fs.existsSync(indexPath)) {
    return { indexPath, written: false };
  }
  writePlansIndex(projectId, [], opts);
  return { indexPath, written: true };
}

/**
 * Combined "first-time setup" for a project's plans storage:
 *   - `ensurePlansDirs`:  mkdir plans/active + plans/completed
 *   - `ensurePlansIndex`: write empty `plans/index.json` if absent
 *
 * Idempotent. Used both for freshly-created projects (from
 * `createProject`) and for legacy projects that get repaired in place
 * via `updateProject` / `reconcileProjectPlansDirs`. AGENTS.md is NOT
 * touched here because the placeholder template needs a project name
 * and canonical root that legacy migration rows may not have — that
 * stays in `createProject`'s explicit `ensureProjectAgentsMd` call.
 */
export function ensureProjectPlansSkeleton(
  projectId: string,
  opts?: ProjectServiceOptions
): { plansDir: string; indexWritten: boolean } {
  const { plansDir } = ensurePlansDirs(projectId, opts);
  const { written: indexWritten } = ensurePlansIndex(projectId, opts);
  return { plansDir, indexWritten };
}

/**
 * Best-effort reconciliation: ensure every project row in the core
 * ProjectStore has a complete plans skeleton
 * (`plans/active/` + `plans/completed/` + `plans/index.json`).
 *
 * Background — projects migrated in from the legacy
 * `project_path_aliases` era (Plan 525 Phase 2.4) never went through
 * `createProject`, so they exist as rows but lack `~/.duya/projects/<id>/`
 * entirely. `updateProject` repairs a single project the first time the
 * user edits it; this function repairs the rest in one shot.
 *
 * Semantics:
 *   - Only projects whose plans dir is missing get any directory or
 *     file created. Projects that already have a plans dir (and
 *     possibly a real `index.json`) are left untouched.
 *   - `ensureProjectPlansSkeleton` is idempotent: it writes an empty
 *     `index.json` only when the file is absent, so projects that
 *     already have a real plan index keep their entries.
 *   - Errors are swallowed and recorded; one bad project id must not
 *     prevent the rest from being repaired.
 *
 * Designed to be called once from `projects:list` (fire-and-forget) so
 * the renderer doesn't pay the disk-walk latency.
 */
export function reconcileProjectPlansDirs(opts?: ProjectServiceOptions): {
  scanned: number;
  repaired: number;
  indexSeeded: number;
  errors: string[];
} {
  const rows = store(opts).list();
  let repaired = 0;
  let indexSeeded = 0;
  const errors: string[] = [];
  for (const row of rows) {
    try {
      const dir = projectPlansDir(row.project_id, opts);
      if (!fs.existsSync(dir)) {
        const result = ensureProjectPlansSkeleton(row.project_id, opts);
        repaired += 1;
        if (result.indexWritten) indexSeeded += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${row.project_id}: ${message}`);
    }
  }
  return { scanned: rows.length, repaired, indexSeeded, errors };
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
  version?: number;
}): string {
  // The marker is hardcoded at the top of the template as
  // `CURRENT_PROJECT_AGENTS_MD_VERSION`; the optional `version` arg is
  // a defense-in-depth knob for future bumps — if the template itself
  // is updated to a higher version, callers don't need to also remember
  // to pass `version` here.
  const version = args.version ?? CURRENT_PROJECT_AGENTS_MD_VERSION;
  const placeholders: Record<string, string> = {
    projectName: args.projectName,
    projectId: args.projectId,
    canonicalRoot: args.canonicalRoot,
    createdAt: args.createdAt,
    duyaVersion: readDuyaVersion(),
  };
  // Re-stamp the marker with the resolved version. The template already
  // contains a marker line, but doing a second replace keeps the body
  // and marker honest if the template ever drifts.
  const body = DEFAULT_PROJECT_AGENTS_MD_TEMPLATE
    .replace(
      AGENTS_MD_VERSION_REGEX,
      projectAgentsMdMarker(version),
    )
    .replace(
      /\{(projectName|projectId|canonicalRoot|createdAt|duyaVersion)\}/g,
      (_, key: string) => placeholders[key] ?? '',
    );
  return body;
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
 * Idempotent seed for `~/.duya/projects/<projectId>/AGENTS.md`.
 *
 * Behavior matrix:
 *   - file absent                 → write the current template.
 *   - file present, no marker (v0) → upgrade to current version (legacy
 *                                    files are treated as 0 because the
 *                                    user never had a chance to author
 *                                    them before the marker existed).
 *   - file present, marker version < current → upgrade.
 *   - file present, marker version >= current → no-op (user may have
 *                                    edited; never overwrite).
 *
 * A user-edited file with the marker still records the version at
 * which they started editing; we never overwrite once the recorded
 * version is at-or-above current. This means a user who edits §4/§5 in
 * place keeps their edits across upgrades — only files we wrote (or
 * legacy files) get rewritten.
 */
export function ensureProjectAgentsMd(
  projectId: string,
  args: { projectName: string; canonicalRoot: string },
  opts?: ProjectServiceOptions
): { path: string; created: boolean; upgraded: boolean; version: number } {
  const homeDir = path.join(projectsBase(opts), projectId);
  fs.mkdirSync(homeDir, { recursive: true });
  const agentsPath = path.join(homeDir, 'AGENTS.md');
  if (fs.existsSync(agentsPath)) {
    const existing = fs.readFileSync(agentsPath, 'utf8');
    const recorded = readProjectAgentsMdVersion(existing);
    if (recorded >= CURRENT_PROJECT_AGENTS_MD_VERSION) {
      return { path: agentsPath, created: false, upgraded: false, version: recorded };
    }
    // Upgrade in place. Atomic temp + rename so a reader never sees a
    // half-written file. The user's edits to §4 / §5 are intentionally
    // NOT preserved — upgrading from a seeded version means we wrote
    // it, so it carries no user intent. (A file the user edited at v3+
    // would have been blocked above by `recorded >= current`.)
    const content = buildDefaultAgentsMd({
      projectName: args.projectName,
      projectId,
      canonicalRoot: args.canonicalRoot,
      createdAt: today(),
    });
    const tmpPath = `${agentsPath}.tmp`;
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, agentsPath);
    return { path: agentsPath, created: false, upgraded: true, version: CURRENT_PROJECT_AGENTS_MD_VERSION };
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
  return { path: agentsPath, created: true, upgraded: false, version: CURRENT_PROJECT_AGENTS_MD_VERSION };
}

/**
 * Background reconciliation: walk every project row and upgrade any
 * AGENTS.md whose recorded version is below the current one. Mirrors
 * `reconcileProjectPlansDirs` in shape — best-effort, errors swallowed
 * and recorded so one bad project never blocks the rest.
 *
 * Note: this rewrites legacy (unmarked) files too, which is intentional
 * — pre-marker AGENTS.md files were written by duya, not edited, so
 * overwriting them is the same risk profile as a fresh seed.
 *
 * Designed to be called from `projects:list` (fire-and-forget). The
 * caller guards against duplicate invocations via an in-flight flag
 * (see `reconcileProjectAgentsMdBestEffort` in the IPC handler).
 */
export function reconcileProjectAgentsMd(opts?: ProjectServiceOptions): {
  scanned: number;
  upgraded: number;
  skipped: number;
  errors: string[];
} {
  const rows = store(opts).list();
  let upgraded = 0;
  let skipped = 0;
  const errors: string[] = [];
  for (const row of rows) {
    try {
      const agentsPath = path.join(projectsBase(opts), row.project_id, 'AGENTS.md');
      if (!fs.existsSync(agentsPath)) {
        // Files we never wrote are also out of scope here — the
        // reconcile pass focuses on upgrading existing seeds, not
        // creating new ones for legacy rows. `updateProject` and
        // `createProject` both call `ensureProjectAgentsMd` for that.
        skipped += 1;
        continue;
      }
      const existing = fs.readFileSync(agentsPath, 'utf8');
      const recorded = readProjectAgentsMdVersion(existing);
      if (recorded >= CURRENT_PROJECT_AGENTS_MD_VERSION) {
        skipped += 1;
        continue;
      }
      const content = buildDefaultAgentsMd({
        projectName: row.name,
        projectId: row.project_id,
        canonicalRoot: row.canonical_root,
        createdAt: today(),
      });
      const tmpPath = `${agentsPath}.tmp`;
      fs.writeFileSync(tmpPath, content, 'utf8');
      fs.renameSync(tmpPath, agentsPath);
      upgraded += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${row.project_id}: ${message}`);
    }
  }
  return { scanned: rows.length, upgraded, skipped, errors };
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

  ensureProjectPlansSkeleton(row.project_id, opts);
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
  const existing = s.get(projectId);
  if (!existing) return null;

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
  // gets touched by an update. This is idempotent and safe even when
  // the project was migrated in from the legacy `project_path_aliases`
  // era and never went through `createProject` (Plan 525 Phase 3 only
  // ran `ensurePlansDirs` from `createProject`). The renderer surfaces
  // projects that pre-date the plans-dir layout (no
  // `~/.duya/projects/<id>/plans/`) and editing them via
  // ProjectsView → 编辑项目 was a no-op for directory creation; this
  // hook repairs that. `ensureProjectPlansSkeleton` is safe for
  // projects that already have a real plan index because the index
  // writer is gated by `existsSync(index.json)`.
  ensureProjectPlansSkeleton(projectId, opts);
  // Same idempotent seed for AGENTS.md — upgrades legacy / older
  // versions in place; never touches files the user has authored past
  // the current version.
  ensureProjectAgentsMd(
    projectId,
    {
      projectName: patch.name ?? existing.name,
      canonicalRoot: Array.isArray(patch.paths) && patch.paths.length > 0
        ? normalizeProjectPathEntries(patch.paths)[0].path
        : existing.canonical_root,
    },
    opts
  );
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