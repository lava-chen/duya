/**
 * routine-activity.ts — predicate for routine lifecycle marker rows
 * (bot-direct chat chips; companion to channel-activity.ts).
 */

import type { RoutineActivityMeta } from "@/types/message";

/** UI Message row carrying a routine marker payload. */
export interface RoutineMarkerRow {
  source?: string | null;
  routineMeta?: RoutineActivityMeta | null;
}

export function isRoutineActivityMarker(message: RoutineMarkerRow): boolean {
  return message.source === "routine_activity" && message.routineMeta != null;
}
