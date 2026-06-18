import type { CanvasElement } from "../..//types/conductor";
import { getAbsolutePosition } from "../..//stores/conductor-store";

const DEFAULT_THRESHOLD = 6;

export interface AlignmentGuide {
  type: "vertical" | "horizontal";
  value: number;
  alignedTo: "left" | "right" | "centerX" | "top" | "bottom" | "centerY";
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function elementToRect(element: CanvasElement): Rect {
  return {
    x: element.position.x,
    y: element.position.y,
    w: element.position.w,
    h: element.position.h,
  };
}

function getBounds(rect: Rect) {
  return {
    left: rect.x,
    right: rect.x + rect.w,
    top: rect.y,
    bottom: rect.y + rect.h,
    centerX: rect.x + rect.w / 2,
    centerY: rect.y + rect.h / 2,
  };
}

export function detectAlignmentGuides(
  movingNode: CanvasElement,
  allNodes: CanvasElement[],
  threshold: number = DEFAULT_THRESHOLD
): AlignmentGuide[] {
  const guides: AlignmentGuide[] = [];
  const movingBounds = getBounds(elementToRect(movingNode));
  const others = allNodes.filter((n) => n.id !== movingNode.id);

  for (const other of others) {
    const otherBounds = getBounds(elementToRect(other));

    const verticalChecks: Array<{
      movingValue: number;
      otherValue: number;
      type: AlignmentGuide["alignedTo"];
    }> = [
      { movingValue: movingBounds.left, otherValue: otherBounds.left, type: "left" },
      { movingValue: movingBounds.right, otherValue: otherBounds.right, type: "right" },
      { movingValue: movingBounds.centerX, otherValue: otherBounds.centerX, type: "centerX" },
      { movingValue: movingBounds.left, otherValue: otherBounds.right, type: "left" },
      { movingValue: movingBounds.right, otherValue: otherBounds.left, type: "right" },
    ];

    for (const check of verticalChecks) {
      if (Math.abs(check.movingValue - check.otherValue) <= threshold) {
        guides.push({
          type: "vertical",
          value: check.otherValue,
          alignedTo: check.type,
        });
      }
    }

    const horizontalChecks: Array<{
      movingValue: number;
      otherValue: number;
      type: AlignmentGuide["alignedTo"];
    }> = [
      { movingValue: movingBounds.top, otherValue: otherBounds.top, type: "top" },
      { movingValue: movingBounds.bottom, otherValue: otherBounds.bottom, type: "bottom" },
      { movingValue: movingBounds.centerY, otherValue: otherBounds.centerY, type: "centerY" },
      { movingValue: movingBounds.top, otherValue: otherBounds.bottom, type: "top" },
      { movingValue: movingBounds.bottom, otherValue: otherBounds.top, type: "bottom" },
    ];

    for (const check of horizontalChecks) {
      if (Math.abs(check.movingValue - check.otherValue) <= threshold) {
        guides.push({
          type: "horizontal",
          value: check.otherValue,
          alignedTo: check.type,
        });
      }
    }
  }

  return guides;
}

export function snapToAlignmentGuides(
  movingNode: CanvasElement,
  allNodes: CanvasElement[],
  guides: AlignmentGuide[]
): { x: number; y: number } {
  let snappedX = movingNode.position.x;
  let snappedY = movingNode.position.y;

  const movingBounds = getBounds(elementToRect(movingNode));

  for (const guide of guides) {
    if (guide.type === "vertical") {
      switch (guide.alignedTo) {
        case "left":
          snappedX = guide.value;
          break;
        case "right":
          snappedX = guide.value - movingNode.position.w;
          break;
        case "centerX":
          snappedX = guide.value - movingNode.position.w / 2;
          break;
      }
    } else {
      switch (guide.alignedTo) {
        case "top":
          snappedY = guide.value;
          break;
        case "bottom":
          snappedY = guide.value - movingNode.position.h;
          break;
        case "centerY":
          snappedY = guide.value - movingNode.position.h / 2;
          break;
      }
    }
  }

  return { x: snappedX, y: snappedY };
}