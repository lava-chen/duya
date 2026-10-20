/**
 * sidebar-sections-ipc.ts — thin async wrappers around `window.electronAPI.sidebarSections.*`.
 * Matches the structural shape returned by the Electron preload, with
 * camelCase renames so the renderer's Zustand store can consume it directly.
 *
 * Plan 471: user-defined sidebar sections. Sessions themselves are NOT moved
 * across kind boundaries; only the sidebar render group changes.
 */

export interface SidebarSection {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
  sortOrder: number;
  collapsed: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface SidebarSectionProject {
  sectionId: string;
  workingDirectory: string;
  sortOrder: number;
  createdAt: number;
}

export interface SidebarSectionsListResult {
  sections: SidebarSection[];
  projects: SidebarSectionProject[];
}

export interface CreateSidebarSectionInput {
  name: string;
  icon?: string | null;
  color?: string | null;
  collapsed?: boolean;
}

function toSection(raw: {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
  sortOrder: number;
  collapsed: number;
  createdAt: number;
  updatedAt: number;
}): SidebarSection {
  return {
    id: raw.id,
    name: raw.name,
    icon: raw.icon,
    color: raw.color,
    sortOrder: raw.sortOrder,
    collapsed: raw.collapsed !== 0,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

function toSectionProject(raw: {
  sectionId: string;
  workingDirectory: string;
  sortOrder: number;
  createdAt: number;
}): SidebarSectionProject {
  return {
    sectionId: raw.sectionId,
    workingDirectory: raw.workingDirectory,
    sortOrder: raw.sortOrder,
    createdAt: raw.createdAt,
  };
}

export async function listSidebarSectionsIPC(): Promise<SidebarSectionsListResult> {
  const api = window.electronAPI?.sidebarSections;
  if (!api) return { sections: [], projects: [] };
  const raw = await api.list();
  return {
    sections: raw.sections.map(toSection),
    projects: raw.projects.map(toSectionProject),
  };
}

export async function createSidebarSectionIPC(
  input: CreateSidebarSectionInput,
): Promise<SidebarSection> {
  const api = window.electronAPI?.sidebarSections;
  if (!api) throw new Error('sidebarSections IPC not available');
  const raw = await api.create({
    name: input.name,
    icon: input.icon ?? null,
    color: input.color ?? null,
    collapsed: input.collapsed ?? false,
  });
  return toSection(raw);
}

export async function updateSidebarSectionIPC(
  id: string,
  patch: Partial<Pick<SidebarSection, 'name' | 'icon' | 'color' | 'sortOrder' | 'collapsed'>>,
): Promise<SidebarSection | null> {
  const api = window.electronAPI?.sidebarSections;
  if (!api) throw new Error('sidebarSections IPC not available');
  const raw = await api.update(id, patch);
  if (!raw) return null;
  return toSection(raw as Parameters<typeof toSection>[0]);
}

export async function removeSidebarSectionIPC(id: string): Promise<boolean> {
  const api = window.electronAPI?.sidebarSections;
  if (!api) return false;
  return api.remove(id);
}

export async function assignProjectToSectionIPC(
  sectionId: string,
  workingDirectory: string,
): Promise<void> {
  const api = window.electronAPI?.sidebarSections;
  if (!api) return;
  await api.assignProject(sectionId, workingDirectory);
}

export async function unassignProjectIPC(workingDirectory: string): Promise<void> {
  const api = window.electronAPI?.sidebarSections;
  if (!api) return;
  await api.unassignProject(workingDirectory);
}

export async function reorderSectionsIPC(orderedIds: string[]): Promise<void> {
  const api = window.electronAPI?.sidebarSections;
  if (!api) return;
  await api.reorder(orderedIds);
}

export async function reorderProjectsInSectionIPC(
  sectionId: string,
  orderedDirs: string[],
): Promise<void> {
  const api = window.electronAPI?.sidebarSections;
  if (!api) return;
  await api.reorderProjects(sectionId, orderedDirs);
}

export async function findSectionForProjectIPC(
  workingDirectory: string,
): Promise<string | null> {
  const api = window.electronAPI?.sidebarSections;
  if (!api) return null;
  return api.findSectionForProject(workingDirectory);
}
