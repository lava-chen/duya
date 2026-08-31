/**
 * sidebar-sections-store.ts — CRUD for the user-defined sidebar sections
 * (Plan 471). Sections wrap `workingDirectory` projects into top-level
 * groups in the sidebar. The schema lives on the legacy `duya-main.db`,
 * migration #53, not on the core `duya-core.db`, because sections are a
 * pure renderer UX concern with no agent-runtime impact.
 *
 * Mapping rule: a `working_directory` belongs to at most one user section.
 * `assignProject()` enforces this with `INSERT OR REPLACE` semantics at
 * the SQL layer; `unassignProject()` deletes the mapping row.
 *
 * No FTS, no soft delete. The store is a small, single-table aggregate
 * and follows the same pattern as the other aggregates in `stores.ts`.
 */

import type BetterSqlite3 from 'better-sqlite3';
// SidebarSectionsStore owns its tables on the LEGACY `duya-main.db` (not
// the core `duya-core.db`) because section metadata is renderer-only UX
// state with no agent-runtime impact. Migration #53 lives in
// `electron/db/schema.ts` so the legacy migration index stays the source
// of truth — the store is constructed at IPC registration time against
// the legacy connection returned by `getDatabase()`.

// ─── Inline types ───

export interface CoreSidebarSection {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
  sortOrder: number;
  collapsed: number;
  createdAt: number;
  updatedAt: number;
}

export interface CoreSidebarSectionProject {
  sectionId: string;
  workingDirectory: string;
  sortOrder: number;
  createdAt: number;
}

export interface SidebarSectionCreateInput {
  name: string;
  icon?: string | null;
  color?: string | null;
  /** Default sort_order = append (max + 1). */
  sortOrder?: number;
  collapsed?: boolean;
}

export interface SidebarSectionPatch {
  name?: string;
  icon?: string | null;
  color?: string | null;
  sortOrder?: number;
  collapsed?: boolean;
}

export interface SidebarSectionProjectPatch {
  sectionId?: string;
  sortOrder?: number;
}

// ─── SidebarSectionsStore ───

export class SidebarSectionsStore {
  private readonly db: BetterSqlite3.Database;

  constructor(db: BetterSqlite3.Database) {
    this.db = db;
  }

  // ─── Section CRUD ───

  listSections(): CoreSidebarSection[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, icon, color, sort_order, collapsed, created_at, updated_at
         FROM sidebar_sections
         ORDER BY sort_order ASC, id ASC`,
      )
      .all() as Array<{
      id: string;
      name: string;
      icon: string | null;
      color: string | null;
      sort_order: number;
      collapsed: number;
      created_at: number;
      updated_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      icon: r.icon,
      color: r.color,
      sortOrder: r.sort_order,
      collapsed: r.collapsed,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  createSection(input: SidebarSectionCreateInput): CoreSidebarSection {
    const id = cryptoUUID();
    const now = Date.now();
    // If sortOrder was not supplied, append after the current max so the
    // new section lands at the bottom.
    let sortOrder = input.sortOrder;
    if (sortOrder === undefined) {
      const maxRow = this.db
        .prepare(`SELECT COALESCE(MAX(sort_order), -1) AS max FROM sidebar_sections`)
        .get() as { max: number };
      sortOrder = (maxRow.max ?? -1) + 1;
    }
    this.db
      .prepare(
        `INSERT INTO sidebar_sections (
          id, name, icon, color, sort_order, collapsed, created_at, updated_at
        ) VALUES (@id, @name, @icon, @color, @sort_order, @collapsed, @created_at, @updated_at)`,
      )
      .run({
        id,
        name: input.name,
        icon: input.icon ?? null,
        color: input.color ?? null,
        sort_order: sortOrder,
        collapsed: input.collapsed ? 1 : 0,
        created_at: now,
        updated_at: now,
      });
    return {
      id,
      name: input.name,
      icon: input.icon ?? null,
      color: input.color ?? null,
      sortOrder,
      collapsed: input.collapsed ? 1 : 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  updateSection(id: string, patch: SidebarSectionPatch): CoreSidebarSection | null {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    if (patch.name !== undefined) {
      sets.push('name = @name');
      params.name = patch.name;
    }
    if (patch.icon !== undefined) {
      sets.push('icon = @icon');
      params.icon = patch.icon;
    }
    if (patch.color !== undefined) {
      sets.push('color = @color');
      params.color = patch.color;
    }
    if (patch.sortOrder !== undefined) {
      sets.push('sort_order = @sort_order');
      params.sort_order = patch.sortOrder;
    }
    if (patch.collapsed !== undefined) {
      sets.push('collapsed = @collapsed');
      params.collapsed = patch.collapsed ? 1 : 0;
    }
    if (sets.length === 0) {
      return this.getSection(id);
    }
    sets.push('updated_at = @updated_at');
    params.updated_at = Date.now();
    const result = this.db
      .prepare(
        `UPDATE sidebar_sections SET ${sets.join(', ')} WHERE id = @id`,
      )
      .run(params);
    if (result.changes === 0) return null;
    return this.getSection(id);
  }

  /** Cascade-deletes the section's project mappings via FK. */
  deleteSection(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM sidebar_sections WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  getSection(id: string): CoreSidebarSection | null {
    const row = this.db
      .prepare(
        `SELECT id, name, icon, color, sort_order, collapsed, created_at, updated_at
         FROM sidebar_sections WHERE id = ?`,
      )
      .get(id) as
      | {
          id: string;
          name: string;
          icon: string | null;
          color: string | null;
          sort_order: number;
          collapsed: number;
          created_at: number;
          updated_at: number;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      icon: row.icon,
      color: row.color,
      sortOrder: row.sort_order,
      collapsed: row.collapsed,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ─── Section-project mapping ───

  listSectionProjects(): CoreSidebarSectionProject[] {
    const rows = this.db
      .prepare(
        `SELECT section_id, working_directory, sort_order, created_at
         FROM sidebar_section_projects
         ORDER BY sort_order ASC, working_directory ASC`,
      )
      .all() as Array<{
      section_id: string;
      working_directory: string;
      sort_order: number;
      created_at: number;
    }>;
    return rows.map((r) => ({
      sectionId: r.section_id,
      workingDirectory: r.working_directory,
      sortOrder: r.sort_order,
      createdAt: r.created_at,
    }));
  }

  /**
   * Assign a project (workingDirectory) to a section. Each working directory
   * may belong to at most one user section at a time, so this effectively
   * moves the project if it already belonged elsewhere.
   */
  assignProject(sectionId: string, workingDirectory: string): CoreSidebarSectionProject {
    // First, remove any existing mapping for this workingDirectory to keep
    // the "at most one section" invariant.
    this.db
      .prepare(`DELETE FROM sidebar_section_projects WHERE working_directory = ?`)
      .run(workingDirectory);

    const result = this.db
      .prepare(
        `SELECT COALESCE(MAX(sort_order), -1) AS max
         FROM sidebar_section_projects WHERE section_id = ?`,
      )
      .get(sectionId) as { max: number };
    const sortOrder = (result.max ?? -1) + 1;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO sidebar_section_projects (
          section_id, working_directory, sort_order, created_at
        ) VALUES (?, ?, ?, ?)`,
      )
      .run(sectionId, workingDirectory, sortOrder, now);
    // Touch the parent section so the updatedAt moves even on pure mapping edits.
    this.db
      .prepare(`UPDATE sidebar_sections SET updated_at = ? WHERE id = ?`)
      .run(now, sectionId);
    return {
      sectionId,
      workingDirectory,
      sortOrder,
      createdAt: now,
    };
  }

  /** Unassign a project from its current section (no-op if not assigned). */
  unassignProject(workingDirectory: string): void {
    this.db
      .prepare(`DELETE FROM sidebar_section_projects WHERE working_directory = ?`)
      .run(workingDirectory);
  }

  /**
   * Bulk-reorder sections by id list. Updates sort_order to match the
   * array's position. Sections not in the list keep their existing order
   * (this method is a delta reorder, not a full rewrite).
   */
  reorderSections(orderedIds: string[]): void {
    const now = Date.now();
    const stmt = this.db.prepare(
      `UPDATE sidebar_sections SET sort_order = ?, updated_at = ? WHERE id = ?`,
    );
    const txn = this.db.transaction((ids: string[]) => {
      ids.forEach((id, index) => {
        stmt.run(index, now, id);
      });
    });
    txn(orderedIds);
  }

  /**
   * Bulk-reorder projects within a section. Working directories not in
   * the list keep their existing order.
   */
  reorderProjectsInSection(sectionId: string, orderedDirs: string[]): void {
    const stmt = this.db.prepare(
      `UPDATE sidebar_section_projects SET sort_order = ? WHERE section_id = ? AND working_directory = ?`,
    );
    const txn = this.db.transaction((dirs: string[]) => {
      dirs.forEach((dir, index) => {
        stmt.run(index, sectionId, dir);
      });
    });
    txn(orderedDirs);
  }

  /**
   * Find the section a project is currently in, or null if unassigned.
   * O(1) lookup via the working_directory index.
   */
  findSectionForProject(workingDirectory: string): string | null {
    const row = this.db
      .prepare(
        `SELECT section_id FROM sidebar_section_projects WHERE working_directory = ? LIMIT 1`,
      )
      .get(workingDirectory) as { section_id: string } | undefined;
    return row?.section_id ?? null;
  }
}

// ─── Utilities ───

/** crypto.randomUUID() with a deterministic fallback for non-secure contexts. */
function cryptoUUID(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return `sec-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
