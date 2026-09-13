'use strict';
/**
 * plans-core.cjs — storage/logic layer for the duya plans MCP server
 * (Plan 525 Phase 4; supersedes the storage location designed in plan
 * 522 with the global `~/.duya/projects/<project_id>/plans/` layout).
 *
 * Deliberately plain CommonJS with zero dependencies: the builtin
 * plugin directory ships verbatim (electron/plugins/catalog.ts copies
 * it into ~/.duya/plugins/cache/builtin/) and the server is spawned as
 * `node server/plans-server.cjs` — no bundling step, no native modules.
 *
 * index.json is a DERIVED cache: every read reconciles it against a
 * full directory scan (plan files are small and few, so a rebuild is
 * cheap). Plan files may be created/edited by ordinary file tools
 * behind the server's back; reconciliation makes that safe.
 *
 * Path safety: every user-supplied projectId is validated against a
 * strict identifier pattern before it ever touches the filesystem.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const PLAN_FILE_PATTERN = /^(\d+)-([a-z0-9-]+)\.md$/;

/** Resolve `~/.duya/projects` (DUYA_TEST-namespace aware, same semantics as memory-state). */
function resolveProjectsRoot() {
  const base = path.join(os.homedir(), '.duya');
  if (process.env.DUYA_TEST === '1') {
    const ns = process.env.DUYA_TEST_NAMESPACE;
    if (ns && /^[a-zA-Z0-9_-]+$/.test(ns)) return path.join(base, 'test-namespaces', ns, 'projects');
  }
  return path.join(base, 'projects');
}

class PlansError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'PlansError';
    this.code = code;
  }
}

function assertProjectId(projectId) {
  if (typeof projectId !== 'string' || !PROJECT_ID_PATTERN.test(projectId)) {
    throw new PlansError(
      `projectId must match ${PROJECT_ID_PATTERN} (got: ${JSON.stringify(projectId)})`,
      'invalid_project_id'
    );
  }
}

function plansDirFor(projectsRoot, projectId) {
  return path.join(projectsRoot, projectId, 'plans');
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Tolerant frontmatter parser for plan documents. Returns the fields
 * it recognizes ({id, title, priority, status, tags, created,
 * updated}) plus the raw body. Unparseable or missing frontmatter
 * yields `{ fields: {}, body }` — callers decide whether that is
 * fatal (plan_complete) or tolerable (search).
 */
function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { fields: {}, body: text };
  const fields = {};
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

function toEntry(projectId, dirName, fileName, fields) {
  const fileMatch = fileName.match(PLAN_FILE_PATTERN);
  const idNum = typeof fields.id === 'string' || typeof fields.id === 'number' ? Number(fields.id) : NaN;
  return {
    id: Number.isFinite(idNum) ? idNum : fileMatch ? Number(fileMatch[1]) : null,
    slug: fileMatch ? fileMatch[2] : fileName.replace(/\.md$/, ''),
    title: typeof fields.title === 'string' ? fields.title : fileName.replace(/\.md$/, ''),
    status: typeof fields.status === 'string' ? fields.status : dirName === 'completed' ? 'done' : 'active',
    priority: typeof fields.priority === 'string' ? fields.priority : undefined,
    tags: Array.isArray(fields.tags) ? fields.tags : undefined,
    file: `${dirName}/${fileName}`,
    created: typeof fields.created === 'string' ? fields.created : undefined,
    updated: typeof fields.updated === 'string' ? fields.updated : undefined,
  };
}

function normalizeEntry(entry) {
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

/**
 * Rebuild the plan index for one project by scanning
 * `plans/active/` and `plans/completed/`. Writes index.json only when
 * its content actually changed, so read-only tool calls do not churn
 * the file. Returns the fresh index.
 */
function buildIndex(projectsRoot, projectId) {
  assertProjectId(projectId);
  const plansDir = plansDirFor(projectsRoot, projectId);
  const entries = [];
  for (const dirName of ['active', 'completed']) {
    const dir = path.join(plansDir, dirName);
    let files = [];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue; // directory missing — no plans in this bucket
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
  const index = { projectId, plans: entries.map(normalizeEntry) };

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

/**
 * plan_status — list plans of one project.
 * `status` defaults to 'active'; 'all' returns every bucket.
 */
function planStatus(input) {
  assertProjectId(input.projectId);
  const status = input.status ?? 'active';
  if (status !== 'active' && status !== 'all') {
    throw new PlansError("status must be 'active' or 'all'", 'invalid_status');
  }
  const index = buildIndex(input.projectsRoot, input.projectId);
  const plans = status === 'all' ? index.plans : index.plans.filter((p) => p.status === 'active');
  return { projectId: input.projectId, plans };
}

/**
 * plan_search — keyword search across projects (or scoped to one).
 * Matches title / slug / tags / stringified id; body scanning is
 * intentionally not implemented (plan 525 §4.2: optional, default off).
 */
function planSearch(input) {
  const query = typeof input.query === 'string' ? input.query.trim().toLowerCase() : '';
  if (!query) throw new PlansError('query is required', 'invalid_query');
  const scope = input.scope ?? 'all';
  if (scope !== 'all' && scope !== 'project') {
    throw new PlansError("scope must be 'all' or 'project'", 'invalid_scope');
  }
  if (scope === 'project') assertProjectId(input.projectId);

  const root = input.projectsRoot;
  const results = [];
  let projectIds;
  if (scope === 'project') {
    projectIds = [input.projectId];
  } else {
    let dirents = [];
    try {
      dirents = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return { results: [] };
    }
    projectIds = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  }

  for (const projectId of projectIds) {
    if (!PROJECT_ID_PATTERN.test(projectId)) continue;
    let index;
    try {
      index = buildIndex(root, projectId);
    } catch {
      continue; // unreadable project dir — skip, never fail the search
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

/**
 * plan_complete — the only write tool: flip frontmatter status to
 * 'done' and move the file from active/ to completed/, then refresh
 * the index. Structured errors on unknown plan ids, missing
 * frontmatter, or already-completed plans.
 */
function planComplete(input) {
  assertProjectId(input.projectId);
  const planId = Number(input.planId);
  if (!Number.isInteger(planId)) {
    throw new PlansError('planId must be an integer', 'invalid_plan_id');
  }
  const plansDir = plansDirFor(input.projectsRoot, input.projectId);
  const index = buildIndex(input.projectsRoot, input.projectId);
  const entry = index.plans.find((p) => p.id === planId);
  if (!entry) {
    throw new PlansError(`plan ${planId} not found in project ${input.projectId}`, 'plan_not_found');
  }
  if (entry.status === 'done') {
    throw new PlansError(`plan ${planId} is already completed`, 'already_completed');
  }

  const sourcePath = path.join(plansDir, entry.file);
  let text;
  try {
    text = fs.readFileSync(sourcePath, 'utf8');
  } catch (err) {
    throw new PlansError(`plan file unreadable: ${err.message}`, 'file_unreadable');
  }
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!fm || !/(^|\n)status:/.test(fm[1])) {
    throw new PlansError(
      `plan file has no status frontmatter field — fix it manually (plan 522: files without frontmatter are not upgraded by tools)`,
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

  // Rebuild the index so it reflects the move immediately.
  buildIndex(input.projectsRoot, input.projectId);

  return { ok: true, newFile: targetPath };
}

module.exports = {
  resolveProjectsRoot,
  parseFrontmatter,
  buildIndex,
  planStatus,
  planSearch,
  planComplete,
  PlansError,
  PROJECT_ID_PATTERN,
};
