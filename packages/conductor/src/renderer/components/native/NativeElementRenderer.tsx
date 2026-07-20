"use client";

import React from "react";
import type { CanvasElement, CanvasPosition } from "../..//types/conductor";
import { StickyElement } from "./StickyElement";
import { DocumentElement } from "./DocumentElement";
import { ConnectorElement } from "./ConnectorElement";
import { ImageElement } from "./ImageElement";
import { FileElement } from "./FileElement";
import { GroupElement } from "./GroupElement";
import { LinkElement } from "./LinkElement";
import { TextElement } from "./TextElement";
import { TableElement } from "./TableElement";
import { NativeChrome } from "./NativeChrome";
import { getNativeElementCapabilities } from "./native-element-capabilities";

interface NativeElementRendererProps {
  element: CanvasElement;
  nodeType: string;
  onPositionChange?: (id: string, position: CanvasPosition) => void;
}

function UnknownNativeElement({ nodeType }: { nodeType: string }) {
  return (
    <div className="flex items-center justify-center h-full text-xs text-[var(--muted)] p-2 border border-dashed border-[var(--border)] rounded">
      Unknown: {nodeType}
    </div>
  );
}

const elementMap: Record<string, React.ComponentType<{ element: CanvasElement }>> = {
  sticky: StickyElement,
  shape: StickyElement,
  document: DocumentElement,
  connector: ConnectorElement,
  image: ImageElement,
  file: FileElement,
  group: GroupElement,
  link: LinkElement,
  text: TextElement,
  table: TableElement,
};

export const NativeElementRenderer: React.FC<NativeElementRendererProps> = ({
  element,
  nodeType,
  onPositionChange,
}) => {
  const Component = elementMap[nodeType];

  if (!Component) {
    return (
      <div className="w-full h-full">
        <UnknownNativeElement nodeType={nodeType} />
      </div>
    );
  }

  const capabilities = getNativeElementCapabilities(element);
  if (capabilities.usesChrome) {
    return (
      <NativeChrome element={element} capabilities={capabilities} onPositionChange={onPositionChange}>
        <Component element={element} />
      </NativeChrome>
    );
  }

  return <Component element={element} />;
};
