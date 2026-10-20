import { describe, expect, it } from "vitest";
import {
  buildChannelActivityChipGroups,
  isChannelActivityMarker,
  platformLabel,
  type ChannelMarkerRow,
} from "./channel-activity";

const marker = (
  id: string,
  meta: {
    direction: "in" | "out";
    address?: string;
    platform: string;
    chat?: string;
    senderName?: string;
    text?: string;
  },
  timestamp = 1000,
): ChannelMarkerRow => ({
  id,
  timestamp,
  source: "channel_activity",
  channelMsgMeta: {
    direction: meta.direction,
    address: meta.address ?? `${meta.platform}:${meta.chat ?? "1"}`,
    platform: meta.platform,
    chat: meta.chat ?? "1",
    ...(meta.senderName ? { senderName: meta.senderName } : {}),
    ...(meta.text ? { text: meta.text } : {}),
  },
});

describe("isChannelActivityMarker", () => {
  it("requires both the source tag and the payload", () => {
    expect(isChannelActivityMarker(marker("a", { direction: "in", platform: "telegram" }))).toBe(true);
    expect(
      isChannelActivityMarker({ id: "b", source: "channel_activity", channelMsgMeta: null }),
    ).toBe(false);
    expect(
      isChannelActivityMarker({ id: "c", source: "user", channelMsgMeta: null }),
    ).toBe(false);
  });
});

describe("buildChannelActivityChipGroups", () => {
  it("collapses a consecutive run into one group", () => {
    const groups = buildChannelActivityChipGroups([
      marker("m1", { direction: "in", platform: "telegram", text: "hi" }, 100),
      marker("m2", { direction: "out", platform: "telegram", text: "hello" }, 200),
      marker("m3", { direction: "in", platform: "telegram", text: "ok" }, 300),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].memberIds).toEqual(["m1", "m2", "m3"]);
    expect(groups[0].inCount).toBe(2);
    expect(groups[0].outCount).toBe(1);
    expect(groups[0].platforms).toEqual(["telegram"]);
    expect(groups[0].entries.map((e) => e.text)).toEqual(["hi", "hello", "ok"]);
  });

  it("merges multiple platforms in one burst, preserving first-appearance order", () => {
    const groups = buildChannelActivityChipGroups([
      marker("a", { direction: "in", platform: "feishu", text: "x" }, 10),
      marker("b", { direction: "out", platform: "telegram", text: "y" }, 20),
      marker("c", { direction: "in", platform: "feishu", text: "z" }, 30),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].platforms).toEqual(["feishu", "telegram"]);
  });

  it("splits bursts on any non-marker row between them", () => {
    const groups = buildChannelActivityChipGroups([
      marker("m1", { direction: "in", platform: "telegram", text: "one" }, 100),
      { id: "bubble", timestamp: 150, source: "user", channelMsgMeta: null },
      marker("m2", { direction: "in", platform: "telegram", text: "two" }, 200),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].memberIds).toEqual(["m1"]);
    expect(groups[1].memberIds).toEqual(["m2"]);
  });

  it("ignores marker rows without a payload", () => {
    const groups = buildChannelActivityChipGroups([
      { id: "broken", timestamp: 1, source: "channel_activity", channelMsgMeta: null },
      marker("m1", { direction: "out", platform: "slack", text: "go" }, 100),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].memberIds).toEqual(["m1"]);
  });

  it("returns no groups for an empty or marker-free transcript", () => {
    expect(buildChannelActivityChipGroups([])).toEqual([]);
    expect(
      buildChannelActivityChipGroups([
        { id: "u", timestamp: 1, source: "user", channelMsgMeta: null },
      ]),
    ).toEqual([]);
  });
});

describe("platformLabel", () => {
  it("capitalizes the platform token", () => {
    expect(platformLabel("telegram")).toBe("Telegram");
    expect(platformLabel("feishu")).toBe("Feishu");
    expect(platformLabel("")).toBe("");
  });
});
