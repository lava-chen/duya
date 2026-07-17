import { GRID_PX } from "./units";

export const MIN_TEXT_WIDTH_PX = 120;
export const MIN_TEXT_HEIGHT_PX = 32;
export const MAX_TEXT_WIDTH_PX = 640;
export const MAX_TEXT_HEIGHT_PX = 1200;

export function textContentSizeToGrid(measuredWidth: number, measuredHeight: number): { w: number; h: number } {
  const width = Math.min(MAX_TEXT_WIDTH_PX, Math.max(MIN_TEXT_WIDTH_PX, Math.ceil(measuredWidth)));
  const height = Math.min(MAX_TEXT_HEIGHT_PX, Math.max(MIN_TEXT_HEIGHT_PX, Math.ceil(measuredHeight)));
  return { w: width / GRID_PX, h: height / GRID_PX };
}
