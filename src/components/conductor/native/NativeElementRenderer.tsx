"use client";

import React from "react";
import type { CanvasElement } from "@/types/conductor";
import { ShapeElement } from "./ShapeElement";
import { TextElement } from "./TextElement";
import { StickyElement } from "./StickyElement";
import { SectionElement } from "./SectionElement";
import { ConnectorElement } from "./ConnectorElement";
import { MindMapElement } from "./MindMapElement";
import { FrameElement } from "./FrameElement";
import { NativeChrome } from "./NativeChrome";

interface NativeElementRendererProps {
  element: CanvasElement;
  nodeType: string;
  onPositionChange?: (id: string) => void;
}

function UnknownNativeElement({ nodeType }: { nodeType: string }) {
  return (
    <div className="flex items-center justify-center h-full text-xs text-[var(--muted)] p-2 border border-dashed border-[var(--border)] rounded">
      Unknown: {nodeType}
    </div>
  );
}

const elementMap: Record<string, React.ComponentType<{ element: CanvasElement }>> = {
  shape: ShapeElement,
  text: TextElement,
  sticky: StickyElement,
  section: SectionElement,
  connector: ConnectorElement,
  mindmap: MindMapElement,
  frame: FrameElement,
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

  const showChrome =
    element.elementKind === "native/shape" ||
    element.elementKind === "native/text" ||
    element.elementKind === "native/sticky" ||
    element.elementKind === "native/section";

  if (showChrome) {
    return (
      <NativeChrome element={element} onPositionChange={onPositionChange}>
        <Component element={element} />
      </NativeChrome>
    );
  }

  return <Component element={element} />;
};