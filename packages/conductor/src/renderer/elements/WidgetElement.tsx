"use client";

import React, { useMemo } from "react";
import type { ElementComponentProps } from "./ElementRegistry";
import type { ConductorWidget, WidgetKind, WidgetPermissions, WidgetState, Position } from "..//types/conductor";
import { WidgetShell } from "..//components/WidgetShell";
import { sanitizeForIframe } from "./widget-sanitizer";
import type { DynamicWidgetDefinition } from "..//widgets/registry";

function canvasElementToWidget(element: ElementComponentProps["element"]): ConductorWidget {
  const hasSourceCode = Boolean(element.sourceCode);
  const kind: WidgetKind = hasSourceCode ? "dynamic" : "builtin";
  const type = element.elementKind.replace("widget/", "");
  const position: Position = {
    x: element.position.x,
    y: element.position.y,
    w: element.position.w,
    h: element.position.h,
  };
  const permissions: WidgetPermissions = {
    agentCanRead: element.permissions.agentCanRead,
    agentCanWrite: element.permissions.agentCanWrite,
    agentCanDelete: element.permissions.agentCanDelete,
  };
  const state: WidgetState =
    element.state === "error" ? "error" : element.state === "loading" ? "loading" : "idle";

  return {
    id: element.id,
    canvasId: element.canvasId,
    kind,
    type,
    position,
    config: element.config,
    data: (element.vizSpec?.payload as Record<string, unknown>) ?? {},
    dataVersion: element.dataVersion,
    sourceCode: element.sourceCode,
    state,
    permissions,
    createdAt: element.createdAt,
    updatedAt: element.updatedAt,
  };
}

function buildDynamicDef(
  element: ElementComponentProps["element"],
  widget: ConductorWidget,
): DynamicWidgetDefinition | undefined {
  if (!element.sourceCode) return undefined;
  return {
    kind: "dynamic",
    type: widget.type,
    label: (element.config?.title as string) || widget.type,
    defaultData: {},
    defaultConfig: {},
    defaultSize: { w: element.position.w, h: element.position.h },
    minSize: { w: 2, h: 2 },
    renderMode: "iframe",
    sourceHtml: element.sourceCode,
    sanitizedHtml: sanitizeForIframe(element.sourceCode),
    warnings: [],
    generatedAt: element.updatedAt,
    confirmedByUser: true,
  };
}

export const WidgetElement: React.FC<ElementComponentProps> = ({ element }) => {
  const widget = useMemo(() => canvasElementToWidget(element), [element]);
  const dynamicDef = useMemo(() => buildDynamicDef(element, widget), [element, widget]);
  return <WidgetShell widget={widget} dynamicDef={dynamicDef} />;
};
