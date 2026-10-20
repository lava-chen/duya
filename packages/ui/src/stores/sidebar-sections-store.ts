/**
 * sidebar-sections-store.ts — Zustand store for user-defined sidebar sections
 * (Plan 471). Backed by SQLite through `sidebar-sections-ipc.ts`. The store is
 * the renderer's source of truth between IPC roundtrips; mutations update
 * local state optimistically and reconcile from the IPC return.
 *
 * Sections and section-project mappings are separate arrays (`sections[]` and
 * `sectionProjects[]`) so the renderer can use the mapping for arbitrary O(1)
 * lookups (e.g. "is this working directory assigned to a section?") without
 * a second pass.
 *
 * Crash-safety: the SQLite DB is the durable store. Renderer state is
 * in-memory only and re-hydrates from DB on every boot via `loadFromDatabase`.
 * No `persist()` middleware.
 */

import { create } from 'zustand';
import {
  type CreateSidebarSectionInput,
  type SidebarSection,
  type SidebarSectionProject,
  assignProjectToSectionIPC,
  createSidebarSectionIPC,
  findSectionForProjectIPC,
  listSidebarSectionsIPC,
  removeSidebarSectionIPC,
  reorderProjectsInSectionIPC,
  reorderSectionsIPC,
  unassignProjectIPC,
  updateSidebarSectionIPC,
} from '@/lib/sidebar-sections-ipc';

interface SidebarSectionsState {
  sections: SidebarSection[];
  sectionProjects: SidebarSectionProject[];
  hydrated: boolean;
  loading: boolean;

  // ─── Hydration ───
  loadFromDatabase: () => Promise<void>;

  // ─── Section CRUD ───
  createSection: (input: CreateSidebarSectionInput) => Promise<SidebarSection | null>;
  updateSection: (
    id: string,
    patch: Partial<Pick<SidebarSection, 'name' | 'icon' | 'color' | 'sortOrder' | 'collapsed'>>,
  ) => Promise<void>;
  removeSection: (id: string) => Promise<void>;
  toggleSectionCollapsed: (id: string) => Promise<void>;
  reorderSections: (orderedIds: string[]) => Promise<void>;

  // ─── Section-project mapping ───
  assignProjectToSection: (sectionId: string, workingDirectory: string) => Promise<void>;
  unassignProject: (workingDirectory: string) => Promise<void>;
  reorderProjectsInSection: (sectionId: string, orderedDirs: string[]) => Promise<void>;

  // ─── Selectors ───
  /** Working directory → section id (or null if unassigned). */
  findSectionForProject: (workingDirectory: string) => string | null;
  /** Working directories assigned to a section, sorted by sortOrder. */
  getProjectsForSection: (sectionId: string) => string[];
}

export const useSidebarSectionsStore = create<SidebarSectionsState>()((set, get) => ({
  sections: [],
  sectionProjects: [],
  hydrated: false,
  loading: false,

  loadFromDatabase: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const result = await listSidebarSectionsIPC();
      set({
        sections: result.sections.sort((a, b) => a.sortOrder - b.sortOrder),
        sectionProjects: result.projects.sort((a, b) => a.sortOrder - b.sortOrder),
        hydrated: true,
      });
    } catch (error) {
      console.error('[SidebarSectionsStore] loadFromDatabase failed:', error);
      set({ hydrated: true });
    } finally {
      set({ loading: false });
    }
  },

  createSection: async (input) => {
    try {
      const created = await createSidebarSectionIPC(input);
      set((state) => ({
        sections: [...state.sections, created].sort((a, b) => a.sortOrder - b.sortOrder),
      }));
      return created;
    } catch (error) {
      console.error('[SidebarSectionsStore] createSection failed:', error);
      return null;
    }
  },

  updateSection: async (id, patch) => {
    try {
      const updated = await updateSidebarSectionIPC(id, patch);
      if (!updated) return;
      set((state) => ({
        sections: state.sections
          .map((s) => (s.id === id ? { ...s, ...updated } : s))
          .sort((a, b) => a.sortOrder - b.sortOrder),
      }));
    } catch (error) {
      console.error('[SidebarSectionsStore] updateSection failed:', error);
    }
  },

  removeSection: async (id) => {
    try {
      const removed = await removeSidebarSectionIPC(id);
      if (!removed) return;
      set((state) => ({
        sections: state.sections.filter((s) => s.id !== id),
        // FK cascade on the DB side already removed the mappings, so the
        // local mirror must drop them too — otherwise an orphan row would
        // make the project falsely appear assigned when the page reloads.
        sectionProjects: state.sectionProjects.filter((p) => p.sectionId !== id),
      }));
    } catch (error) {
      console.error('[SidebarSectionsStore] removeSection failed:', error);
    }
  },

  toggleSectionCollapsed: async (id) => {
    const section = get().sections.find((s) => s.id === id);
    if (!section) return;
    const nextCollapsed = !section.collapsed;
    // Optimistic local update — the user clicks → state flips → IPC persists
    // in the background. A persistence failure reverts via the catch.
    set((state) => ({
      sections: state.sections.map((s) =>
        s.id === id ? { ...s, collapsed: nextCollapsed } : s,
      ),
    }));
    try {
      await updateSidebarSectionIPC(id, { collapsed: nextCollapsed });
    } catch (error) {
      console.error('[SidebarSectionsStore] toggleSectionCollapsed failed:', error);
      set((state) => ({
        sections: state.sections.map((s) =>
          s.id === id ? { ...s, collapsed: section.collapsed } : s,
        ),
      }));
    }
  },

  reorderSections: async (orderedIds) => {
    const previousOrder = get().sections.map((s) => s.id);
    // Optimistic reorder by rebuilding the section array with the new order.
    const byId = new Map(get().sections.map((s) => [s.id, s]));
    const reordered: SidebarSection[] = [];
    orderedIds.forEach((id, index) => {
      const section = byId.get(id);
      if (section) {
        reordered.push({ ...section, sortOrder: index });
        byId.delete(id);
      }
    });
    // Any sections not in `orderedIds` keep their existing order at the end.
    byId.forEach((section) => reordered.push(section));
    set({ sections: reordered });
    try {
      await reorderSectionsIPC(orderedIds);
    } catch (error) {
      console.error('[SidebarSectionsStore] reorderSections failed:', error);
      // Roll back to previous order on failure.
      set({ sections: get().sections.sort((a, b) => previousOrder.indexOf(a.id) - previousOrder.indexOf(b.id)) });
    }
  },

  assignProjectToSection: async (sectionId, workingDirectory) => {
    try {
      await assignProjectToSectionIPC(sectionId, workingDirectory);
      // Optimistic local update: the IPC handler has already written the row
      // server-side, so mirror it here with a fresh sortOrder (max+1 in
      // the section). One working directory ⇒ at most one section.
      set((state) => {
        const filtered = state.sectionProjects.filter(
          (p) => p.workingDirectory !== workingDirectory,
        );
        const sectionMax = state.sectionProjects
          .filter((p) => p.sectionId === sectionId)
          .reduce((m, p) => Math.max(m, p.sortOrder), -1);
        return {
          sectionProjects: [
            ...filtered,
            {
              sectionId,
              workingDirectory,
              sortOrder: sectionMax + 1,
              createdAt: Date.now(),
            },
          ].sort((a, b) => a.sortOrder - b.sortOrder),
        };
      });
    } catch (error) {
      console.error('[SidebarSectionsStore] assignProjectToSection failed:', error);
    }
  },

  unassignProject: async (workingDirectory) => {
    try {
      await unassignProjectIPC(workingDirectory);
      set((state) => ({
        sectionProjects: state.sectionProjects.filter(
          (p) => p.workingDirectory !== workingDirectory,
        ),
      }));
    } catch (error) {
      console.error('[SidebarSectionsStore] unassignProject failed:', error);
    }
  },

  reorderProjectsInSection: async (sectionId, orderedDirs) => {
    try {
      await reorderProjectsInSectionIPC(sectionId, orderedDirs);
      // Update local mirror to reflect the new sort orders.
      set((state) => {
        const map = new Map(orderedDirs.map((dir, index) => [dir, index]));
        const next = state.sectionProjects.map((p) =>
          p.sectionId === sectionId && map.has(p.workingDirectory)
            ? { ...p, sortOrder: map.get(p.workingDirectory)! }
            : p,
        );
        return {
          sectionProjects: next.sort((a, b) => a.sortOrder - b.sortOrder),
        };
      });
    } catch (error) {
      console.error('[SidebarSectionsStore] reorderProjectsInSection failed:', error);
    }
  },

  findSectionForProject: (workingDirectory) => {
    const found = get().sectionProjects.find(
      (p) => p.workingDirectory === workingDirectory,
    );
    return found?.sectionId ?? null;
  },

  getProjectsForSection: (sectionId) => {
    return get()
      .sectionProjects.filter((p) => p.sectionId === sectionId)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((p) => p.workingDirectory);
  },
}));

/**
 * Async variant of `findSectionForProject` used after a thread list refresh
 * (when the local store may not yet be hydrated). Falls back to the IPC.
 */
export async function findSectionForProjectAsync(workingDirectory: string): Promise<string | null> {
  const local = useSidebarSectionsStore.getState().findSectionForProject(workingDirectory);
  if (local !== null) return local;
  return findSectionForProjectIPC(workingDirectory);
}
