/** Compatibility exports; persistence ownership moved to @duya/data and @duya/agent-protocol. */
export { SidebarSectionsStore } from '@duya/data/sidebar-sections-store';
export type {
  SidebarSection as CoreSidebarSection,
  SidebarSectionCreateInput,
  SidebarSectionPatch,
  SidebarSectionProject as CoreSidebarSectionProject,
} from '@duya/agent-protocol/sidebar-sections';