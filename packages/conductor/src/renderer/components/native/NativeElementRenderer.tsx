"use client";

import React from "react";
import type { CanvasElement, CanvasPosition } from "../..//types/conductor";
import { StickyElement } from "./StickyElement";
import { ConnectorElement } from "./ConnectorElement";
import { ImageElement } from "./ImageElement";
import { FileElement } from "./FileElement";
import { GroupElement } from "./GroupElement";
import { NativeChrome } from "./NativeChrome";

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
  connector: ConnectorElement,
  image: ImageElement,
  file: FileElement,
  group: GroupElement,
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

  if (
    element.elementKind === "native/sticky" ||
    element.elementKind === "native/image" ||
    element.elementKind === "native/file"
  ) {
    return (
      <NativeChrome element={element} onPositionChange={onPositionChange}>
        <Component element={element} />
      </NativeChrome>
    );
  }

  return <Component element={element} />;
};
