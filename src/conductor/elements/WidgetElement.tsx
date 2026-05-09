"use client";

import React, { useMemo } from "react";
import type { ElementComponentProps } from "./ElementRegistry";
import type { ConductorWidget, WidgetKind, WidgetPermissions, WidgetState, Position } from "@/types/conductor";
import { WidgetShell } from "@/components/conductor/WidgetShell";

function canvasElementToWidget(element: ElementComponentProps["element"]): ConductorWidget {
  const kind: WidgetKind = "builtin";
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

export const WidgetElement: React.FC<ElementComponentProps> = ({ element }) => {
  const widget = useMemo(() => canvasElementToWidget(element), [element]);
  return <WidgetShell widget={widget} />;
};