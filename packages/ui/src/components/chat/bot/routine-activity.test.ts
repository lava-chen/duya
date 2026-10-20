import { describe, expect, it } from "vitest";
import { isRoutineActivityMarker, type RoutineMarkerRow } from "./routine-activity";

describe("isRoutineActivityMarker", () => {
  it("requires both the source tag and the payload", () => {
    const good: RoutineMarkerRow = {
      source: "routine_activity",
      routineMeta: { action: "created", name: "日报" },
    };
    expect(isRoutineActivityMarker(good)).toBe(true);

    expect(
      isRoutineActivityMarker({ source: "routine_activity", routineMeta: null }),
    ).toBe(false);
    expect(
      isRoutineActivityMarker({ source: "send_message", routineMeta: { action: "created", name: "x" } }),
    ).toBe(false);
  });
});
