import { registerElement } from "./ElementRegistry";
import type { ElementDefinition } from "./ElementRegistry";
import { ElementKind } from "..//types/conductor";
import { WidgetElement } from "./WidgetElement";

// Builtin element registry is intentionally minimal. The conductor canvas
// renders native elements (sticky, image, file, connector, group) directly
// through NativeElementRenderer, and agent-created dynamic widgets through
// WidgetElement. Legacy widget/* builtin types have been removed.
const widgetElements: ElementDefinition[] = [
  {
    elementKind: ElementKind["widget/dynamic"],
    renderMode: "react",
    label: "Dynamic Widget",
    component: WidgetElement,
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 2, h: 2 },
    defaultConfig: {},
  },
];

export function registerAllElements(): void {
  for (const def of widgetElements) {
    registerElement(def);
  }
}
