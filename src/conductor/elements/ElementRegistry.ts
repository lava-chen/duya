import type { ComponentType } from "react";
import type { CanvasElement, ElementKind, RenderMode } from "@/types/conductor";
import { getRenderModeForKind } from "@/types/conductor";

export interface ElementComponentProps {
  element: CanvasElement;
  readOnly: boolean;
}

export interface ElementDefinition {
  elementKind: ElementKind;
  renderMode: RenderMode;
  label: string;
  description?: string;
  component: ComponentType<ElementComponentProps>;
  defaultSize: { w: number; h: number };
  minSize: { w: number; h: number };
  defaultConfig: Record<string, unknown>;
}

export const elementRegistry = new Map<ElementKind, ElementDefinition>();

export function registerElement(def: ElementDefinition): void {
  elementRegistry.set(def.elementKind, def);
}

export function getElement(kind: ElementKind): ElementDefinition | undefined {
  return elementRegistry.get(kind);
}

export function resolveRenderMode(kind: ElementKind): RenderMode {
  const def = getElement(kind);
  if (def) return def.renderMode;
  return getRenderModeForKind(kind);
}

export function getElementLabel(kind: ElementKind): string {
  return getElement(kind)?.label ?? kind;
}