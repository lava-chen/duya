import type { HostLocalSidebarSectionsApiV1 } from '@duya/agent-protocol/sidebar-sections';
import type { SidebarSectionsStore } from '@duya/data/sidebar-sections-store';

/** Local-only Host adapter over the Data-owned sidebar section store. */
export function createHostLocalSidebarSectionsApi(
  store: SidebarSectionsStore,
): HostLocalSidebarSectionsApiV1 {
  return {
    async listSidebarSections() {
      return {
        sections: store.listSections(),
        projects: store.listSectionProjects(),
      };
    },
    async createSidebarSection(input) {
      return store.createSection(input);
    },
    async updateSidebarSection(id, patch) {
      return store.updateSection(id, patch);
    },
    async deleteSidebarSection(id) {
      return store.deleteSection(id);
    },
    async assignSidebarProject(sectionId, workingDirectory) {
      return store.assignProject(sectionId, workingDirectory);
    },
    async unassignSidebarProject(workingDirectory) {
      store.unassignProject(workingDirectory);
    },
    async reorderSidebarSections(orderedIds) {
      store.reorderSections([...orderedIds]);
    },
    async reorderSidebarProjects(sectionId, orderedDirectories) {
      store.reorderProjectsInSection(sectionId, [...orderedDirectories]);
    },
    async findSidebarSectionForProject(workingDirectory) {
      return store.findSectionForProject(workingDirectory);
    },
  };
}
