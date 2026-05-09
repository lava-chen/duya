"use client";

import React from "react";
import type { CanvasElement } from "@/types/conductor";
import { getElement, getElementLabel } from "@/conductor/elements/ElementRegistry";
import { ElementChrome } from "./ElementChrome";

interface ElementRendererProps {
  element: CanvasElement;
  readOnly: boolean;
  onDelete?: (id: string) => void;
}

function UnknownElementFallback({ element }: { element: CanvasElement }) {
  return (
    <div className="flex items-center justify-center h-full text-xs text-[var(--muted)] p-4">
      Unknown element: {element.elementKind}
    </div>
  );
}

export const ElementRenderer: React.FC<ElementRendererProps> = ({
  element,
  readOnly,
  onDelete,
}) => {
  const def = getElement(element.elementKind);
  if (!def) {
    return (
      <ElementChrome
        label={element.elementKind}
        readOnly={readOnly}
        onDelete={onDelete ? () => onDelete(element.id) : undefined}
      >
        <UnknownElementFallback element={element} />
      </ElementChrome>
    );
  }

  const label = element.metadata?.label || getElementLabel(element.elementKind);
  const ElementComponent = def.component;

  const content = (
    <ElementComponent element={element} readOnly={readOnly} />
  );

  return (
    <ElementChrome
      label={label}
      readOnly={readOnly}
      state={element.state}
      onDelete={onDelete ? () => onDelete(element.id) : undefined}
    >
      {content}
    </ElementChrome>
  );
};