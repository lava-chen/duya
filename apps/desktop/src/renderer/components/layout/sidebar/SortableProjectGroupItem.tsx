/**
 * Sortable wrapper around `ProjectGroupItem`.
 *
 * The sortable item calls `useSortable` here, then forwards the
 * generated `attributes` + `listeners` to the underlying visual
 * component. The wrapper also owns the placeholder transform so the
 * live preview lines up with the cursor while siblings stay put.
 *
 * Threads inside the project are NOT sortable anymore (Plan
 * sidebar-flat) — only the project header is. The inner
 * `<ProjectGroupItem>` therefore renders its threads as plain
 * `<ThreadListItem>` rows.
 */

import { useSortable } from "@dnd-kit/sortable";
import type { CSSProperties } from "react";
import { CSS } from "@dnd-kit/utilities";

import { ProjectGroupItem } from "./ProjectGroupItem";
import type { Thread, ProjectGroup, ProjectSortBy } from "@/stores/conversation-store";

export interface SortableProjectGroupItemProps {
  project: ProjectGroup;
  threads: Thread[];
  activeThreadId: string | null;
  /** Plan 582 (G8): forwarded so the inner group honours the sidebar sort. */
  sortBy: ProjectSortBy;
}

type SortableBindings = Pick<
  ReturnType<typeof useSortable>,
  "attributes" | "listeners" | "setNodeRef" | "transform" | "isDragging"
>;

export function SortableProjectGroupItem({
  project,
  threads,
  activeThreadId,
  sortBy,
}: SortableProjectGroupItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    isDragging,
  }: SortableBindings = useSortable({ id: project.workingDirectory });

  // While a project is being dragged, drop its opacity so the user
  // sees the placeholder gap. Siblings stay in place because the
  // sibling shift comes from the sorting strategy + `<DragOverlay>`,
  // not from this transform.
  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <ProjectGroupItem
        project={project}
        threads={threads}
        activeThreadId={activeThreadId}
        sortBy={sortBy}
        sortableBindings={{ attributes, listeners }}
      />
    </div>
  );
}