"use client";

import React from "react";
import type { CanvasElement, CanvasPosition } from "..//types/conductor";
import { getElement, getElementLabel } from "..//elements/ElementRegistry";
import { WidgetElement } from "..//elements/WidgetElement";
import { ElementChrome } from "./ElementChrome";
import { NativeElementRenderer } from "./native/NativeElementRenderer";

interface ElementRendererProps {
  element: CanvasElement;
  readOnly: boolean;
  selected?: boolean;
  onDelete?: (id: string) => void;
  onPositionChange?: (id: string, position: CanvasPosition) => void;
}

function UnknownElementFallback({ element }: { element: CanvasElement }) {
  return (
    <div className="flex items-center justify-center h-full text-xs text-[var(--muted)] p-4">
      Unknown element: {element.elementKind}
    </div>
  );
}

function getDisplayLabel(element: CanvasElement): string {
  const metadataLabel = element.metadata?.label;
  if (metadataLabel && metadataLabel !== element.elementKind) {
    return metadataLabel;
  }

  const sourceTitle = element.config?.sourceTitle;
  if (typeof sourceTitle === "string" && sourceTitle.trim()) {
    return sourceTitle;
  }

  const sourceLabel = element.config?.sourceLabel;
  if (typeof sourceLabel === "string" && sourceLabel.trim()) {
    return sourceLabel;
  }

  if (element.vizSpec?.title) {
    return element.vizSpec.title;
  }

  return getElementLabel(element.elementKind);
}

export const ElementRenderer: React.FC<ElementRendererProps> = ({
  element,
  readOnly,
  selected,
  onDelete,
  onPositionChange,
}) => {
  const nodeType = element.elementKind.startsWith("native/")
    ? element.elementKind.replace("native/", "")
    : null;

  if (nodeType) {
    return <NativeElementRenderer element={element} nodeType={nodeType} onPositionChange={onPositionChange} />;
  }

  const def = getElement(element.elementKind);
  const label = getDisplayLabel(element);

  // All widget/* elements (registered or dynamic) render through WidgetElement
  // so dynamic widgets created by agents continue to display their sourceCode.
  const ElementComponent = element.elementKind.startsWith("widget/")
    ? WidgetElement
    : def?.component;

  // Dynamic widgets already provide their own visual container; wrapping them
  // in the default chrome adds an unwanted header/border. Use a minimal chrome
  // that only shows a hover border + resize handle.
  const variant = element.elementKind === "widget/dynamic" ? "minimal" : "default";

  if (!ElementComponent) {
    return (
      <ElementChrome
        element={element}
        label={element.elementKind}
        readOnly={readOnly}
        selected={selected}
        variant={variant}
        onDelete={onDelete ? () => onDelete(element.id) : undefined}
        onPositionChange={onPositionChange}
      >
        <UnknownElementFallback element={element} />
      </ElementChrome>
    );
  }

  const content = (
    <ElementComponent element={element} readOnly={readOnly} />
  );

  return (
    <ElementChrome
      element={element}
      label={label}
      readOnly={readOnly}
      state={element.state}
      selected={selected}
      variant={variant}
      onDelete={onDelete ? () => onDelete(element.id) : undefined}
      onPositionChange={onPositionChange}
    >
      {content}
    </ElementChrome>
  );
};
