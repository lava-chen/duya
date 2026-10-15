/** Local, authenticated sidebar-section persistence used by Desktop. */
export interface SidebarSection {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
  sortOrder: number;
  collapsed: number;
  createdAt: number;
  updatedAt: number;
}

export interface SidebarSectionProject {
  sectionId: string;
  workingDirectory: string;
  sortOrder: number;
  createdAt: number;
}

export interface SidebarSectionsSnapshot {
  sections: readonly SidebarSection[];
  projects: readonly SidebarSectionProject[];
}

export interface SidebarSectionCreateInput {
  name: string;
  icon?: string | null;
  color?: string | null;
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

/** Filesystem paths make this a local-only Host API, never a remote API. */
export interface HostLocalSidebarSectionsApiV1 {
  listSidebarSections(): Promise<SidebarSectionsSnapshot>;
  createSidebarSection(input: SidebarSectionCreateInput): Promise<SidebarSection>;
  updateSidebarSection(id: string, patch: SidebarSectionPatch): Promise<SidebarSection | null>;
  deleteSidebarSection(id: string): Promise<boolean>;
  assignSidebarProject(sectionId: string, workingDirectory: string): Promise<SidebarSectionProject>;
  unassignSidebarProject(workingDirectory: string): Promise<void>;
  reorderSidebarSections(orderedIds: readonly string[]): Promise<void>;
  reorderSidebarProjects(sectionId: string, orderedDirectories: readonly string[]): Promise<void>;
  findSidebarSectionForProject(workingDirectory: string): Promise<string | null>;
}
