"use client";

import { MagicWand } from "@phosphor-icons/react";
import { useRefineStore } from "..//stores/refine-store";
import { useConductorStore } from "..//stores/conductor-store";

interface RefineToolbarButtonProps {
  widgetId: string;
}

export function RefineToolbarButton({ widgetId }: RefineToolbarButtonProps) {
  const editMode = useConductorStore((s) => s.editMode);
  const openRefine = useRefineStore((s) => s.openRefinePanel);

  if (!editMode) return null;

  return (
    <button
      type="button"
      data-testid={`refine-toolbar-btn-${widgetId}`}
      onClick={(e) => {
        e.stopPropagation();
        openRefine(widgetId);
      }}
      className="flex items-center justify-center w-5 h-5 rounded-md text-[var(--muted)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent)] transition-colors"
      title="Refine widget with agent"
    >
      <MagicWand size={12} />
    </button>
  );
}