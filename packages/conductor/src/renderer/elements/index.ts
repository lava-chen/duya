import { registerElement } from "./ElementRegistry";
import type { ElementDefinition } from "./ElementRegistry";
import { ElementKind } from "..//types/conductor";
import { WidgetElement } from "./WidgetElement";

const widgetElements: ElementDefinition[] = [
  {
    elementKind: ElementKind["widget/task-list"],
    renderMode: "react",
    label: "Task List",
    component: WidgetElement,
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 2, h: 2 },
    defaultConfig: {},
  },
  {
    elementKind: ElementKind["widget/note-pad"],
    renderMode: "react",
    label: "Note Pad",
    component: WidgetElement,
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 2, h: 2 },
    defaultConfig: {},
  },
  {
    elementKind: ElementKind["widget/pomodoro"],
    renderMode: "react",
    label: "Pomodoro",
    component: WidgetElement,
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 2, h: 2 },
    defaultConfig: {},
  },
  {
    elementKind: ElementKind["widget/news-board"],
    renderMode: "react",
    label: "News Board",
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
