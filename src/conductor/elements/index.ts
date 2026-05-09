import { registerElement } from "./ElementRegistry";
import type { ElementDefinition } from "./ElementRegistry";
import { ElementKind } from "@/types/conductor";
import { WidgetElement } from "./WidgetElement";
import { RichTextElement } from "./RichTextElement";
import { ShapeRectElement, ShapeCircleElement } from "./ShapeElements";
import {
  DiagramElement,
  ChartElement,
  CardElement,
  ImageElement,
  MiniAppElement,
} from "./IframeElements";

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

const diagramElements: ElementDefinition[] = [
  {
    elementKind: ElementKind["diagram/svg"],
    renderMode: "iframe",
    label: "Diagram",
    description: "Mermaid or SVG diagram",
    component: DiagramElement,
    defaultSize: { w: 6, h: 4 },
    minSize: { w: 3, h: 2 },
    defaultConfig: {},
  },
];

const chartElements: ElementDefinition[] = [
  {
    elementKind: ElementKind["chart/bar"],
    renderMode: "iframe",
    label: "Bar Chart",
    component: ChartElement,
    defaultSize: { w: 6, h: 4 },
    minSize: { w: 3, h: 2 },
    defaultConfig: {},
  },
  {
    elementKind: ElementKind["chart/line"],
    renderMode: "iframe",
    label: "Line Chart",
    component: ChartElement,
    defaultSize: { w: 6, h: 4 },
    minSize: { w: 3, h: 2 },
    defaultConfig: {},
  },
  {
    elementKind: ElementKind["chart/pie"],
    renderMode: "iframe",
    label: "Pie Chart",
    component: ChartElement,
    defaultSize: { w: 4, h: 4 },
    minSize: { w: 2, h: 2 },
    defaultConfig: {},
  },
];

const contentElements: ElementDefinition[] = [
  {
    elementKind: ElementKind["content/card"],
    renderMode: "iframe",
    label: "Card",
    description: "Display card with title, body, and tags",
    component: CardElement,
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 2, h: 2 },
    defaultConfig: {},
  },
  {
    elementKind: ElementKind["content/rich-text"],
    renderMode: "react",
    label: "Rich Text",
    description: "Markdown rich text content",
    component: RichTextElement,
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 2, h: 2 },
    defaultConfig: {},
  },
  {
    elementKind: ElementKind["content/image"],
    renderMode: "iframe",
    label: "Image",
    component: ImageElement,
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 2, h: 2 },
    defaultConfig: {},
  },
];

const shapeElements: ElementDefinition[] = [
  {
    elementKind: ElementKind["shape/rect"],
    renderMode: "svg-native",
    label: "Rectangle",
    component: ShapeRectElement,
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 1, h: 1 },
    defaultConfig: {},
  },
  {
    elementKind: ElementKind["shape/circle"],
    renderMode: "svg-native",
    label: "Circle",
    component: ShapeCircleElement,
    defaultSize: { w: 2, h: 2 },
    minSize: { w: 1, h: 1 },
    defaultConfig: {},
  },
  {
    elementKind: ElementKind["shape/connector"],
    renderMode: "svg-native",
    label: "Connector",
    component: ShapeRectElement,
    defaultSize: { w: 1, h: 1 },
    minSize: { w: 1, h: 1 },
    defaultConfig: {},
  },
];

const appElements: ElementDefinition[] = [
  {
    elementKind: ElementKind["app/mini-app"],
    renderMode: "iframe",
    label: "Mini App",
    description: "Custom HTML/CSS/JS application",
    component: MiniAppElement,
    defaultSize: { w: 6, h: 4 },
    minSize: { w: 3, h: 2 },
    defaultConfig: {},
  },
];

const allDefinitions = [
  ...widgetElements,
  ...diagramElements,
  ...chartElements,
  ...contentElements,
  ...shapeElements,
  ...appElements,
];

export function registerAllElements(): void {
  for (const def of allDefinitions) {
    registerElement(def);
  }
}