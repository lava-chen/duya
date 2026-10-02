import { describe, expect, it } from "vitest";
import type { Message } from "@/types/message";
import {
  buildAgentDmChipGroups,
  buildAgentDmPairMessages,
  getBotSessionId,
  parseBotSessionAgentId,
} from "./agent-dm-pair";

let seq = 0;

function dmMarker(input: {
  direction: "sent" | "received";
  peerId: string;
  peerName?: string;
  text?: string;
  timestamp?: number;
  clientMsgId?: string;
}): Message {
  seq += 1;
  const text = input.text ?? "hello";
  const peerName = input.peerName ?? input.peerId;
  // Mirror the persisted shape: content carries the "→ peer: " transcript
  // prefix, meta.text carries the raw body (plan 497 rows).
  return {
    id: input.clientMsgId ? `dm-marker-${input.clientMsgId}` : `marker-${seq}`,
    role: input.direction === "sent" ? "assistant" : "user",
    content: `→ ${peerName}: ${text}`,
    status: "complete",
    msgType: "text",
    timestamp: input.timestamp ?? seq * 1000,
    source: "agent_dm",
    agentDmMeta: {
      direction: input.direction,
      peerId: input.peerId,
      peerName,
      text,
      clientMsgId: input.clientMsgId,
    },
  } as unknown as Message;
}

function bubble(text: string, timestamp?: number): Message {
  seq += 1;
  return {
    id: `msg-${seq}`,
    role: "assistant",
    content: text,
    status: "complete",
    msgType: "text",
    timestamp: timestamp ?? seq * 1000,
    source: "send_message",
  } as unknown as Message;
}

describe("buildAgentDmChipGroups", () => {
  it("collapses a consecutive same-peer run into one chip with count", () => {
    const groups = buildAgentDmChipGroups([
      dmMarker({ direction: "sent", peerId: "p1", peerName: "原型师" }),
      dmMarker({ direction: "sent", peerId: "p1", peerName: "原型师" }),
      dmMarker({ direction: "received", peerId: "p1", peerName: "原型师" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].peerId).toBe("p1");
    expect(groups[0].count).toBe(3);
    expect(groups[0].sentCount).toBe(2);
    expect(groups[0].receivedCount).toBe(1);
  });

  it("merges a fan-out burst across peers into one multi-peer chip", () => {
    const groups = buildAgentDmChipGroups([
      dmMarker({ direction: "sent", peerId: "p1", peerName: "工程师" }),
      dmMarker({ direction: "sent", peerId: "p2", peerName: "研究员" }),
      dmMarker({ direction: "received", peerId: "p1", peerName: "工程师" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(3);
    expect(groups[0].peers).toEqual([
      { peerId: "p1", peerName: "工程师", sentCount: 1, receivedCount: 1, count: 2 },
      { peerId: "p2", peerName: "研究员", sentCount: 1, receivedCount: 0, count: 1 },
    ]);
  });

  it("splits runs on a non-marker row", () => {
    const groups = buildAgentDmChipGroups([
      dmMarker({ direction: "sent", peerId: "p1" }),
      bubble("assistant text"),
      dmMarker({ direction: "sent", peerId: "p1" }),
    ]);
    expect(groups.map((g) => [g.peerId, g.count])).toEqual([
      ["p1", 1],
      ["p1", 1],
    ]);
  });

  it("ignores plain transcript rows entirely", () => {
    expect(buildAgentDmChipGroups([bubble("a"), bubble("b")])).toEqual([]);
  });
});

describe("buildAgentDmPairMessages", () => {
  it("merges both directions from the two sessions without duplicates", () => {
    const selfRows = [
      dmMarker({
        direction: "sent",
        peerId: "peer",
        peerName: "Peer",
        text: "self -> peer",
        clientMsgId: "m1",
      }),
      // Mirror of peer -> self (lives in self's session too): must be ignored.
      dmMarker({
        direction: "received",
        peerId: "peer",
        peerName: "Peer",
        text: "peer -> self",
        clientMsgId: "m2",
      }),
    ];
    const peerRows = [
      dmMarker({
        direction: "sent",
        peerId: "self",
        peerName: "Self",
        text: "peer -> self",
        clientMsgId: "m2",
      }),
    ];
    const merged = buildAgentDmPairMessages("self", "peer", selfRows, peerRows);
    expect(merged.map((e) => [e.senderAgentId, e.text])).toEqual([
      ["self", "self -> peer"],
      ["peer", "peer -> self"],
    ]);
    expect(merged[0].key).toBe("m1");
  });

  it("sorts by timestamp and drops markers addressed to other peers", () => {
    const selfRows = [
      dmMarker({ direction: "sent", peerId: "other", text: "noise", clientMsgId: "m0" }),
      dmMarker({
        direction: "sent",
        peerId: "peer",
        text: "late",
        clientMsgId: "m3",
        timestamp: 3000,
      }),
      dmMarker({
        direction: "sent",
        peerId: "peer",
        text: "early",
        clientMsgId: "m4",
        timestamp: 1000,
      }),
    ];
    const merged = buildAgentDmPairMessages("self", "peer", selfRows, []);
    expect(merged.map((e) => e.text)).toEqual(["early", "late"]);
  });

  it("dedupes repeated rows with the same clientMsgId", () => {
    const row = dmMarker({
      direction: "sent",
      peerId: "peer",
      text: "hello",
      clientMsgId: "m1",
    });
    const merged = buildAgentDmPairMessages("self", "peer", [row, row], []);
    expect(merged).toHaveLength(1);
  });
});

describe("bot session id helpers", () => {
  it("round-trips", () => {
    expect(getBotSessionId("bot-x")).toBe("bot:bot-x");
    expect(parseBotSessionAgentId("bot:bot-x")).toBe("bot-x");
    expect(parseBotSessionAgentId("some-uuid")).toBeNull();
  });
});

describe("legacy received rows (session-id peerId)", () => {
  it("normalizes a bot:-prefixed peerId so the pair view merges both sides", () => {
    // Legacy receiver marker: peerId is the sender's PERSISTENT SESSION id.
    const received = dmMarker({
      direction: "received",
      peerId: "bot:duya",
      peerName: "duya",
      text: "先查 git 历史",
      clientMsgId: "m1",
    });
    // The sender's own marker (in the sender's session) uses the bare id.
    const sentByPeer = dmMarker({
      direction: "sent",
      peerId: "self",
      peerName: "Self",
      text: "先查 git 历史",
      clientMsgId: "m1",
    });
    // The receiver-side legacy row is a mirror (direction received) — the
    // merge intentionally takes only sent rows, so the entry comes from the
    // sender's session with the bare peer id as sender.
    const merged = buildAgentDmPairMessages("self", "duya", [received], [sentByPeer]);
    expect(merged).toHaveLength(1);
    expect(merged[0].senderAgentId).toBe("duya");
    expect(merged[0].text).toBe("先查 git 历史");

    // Chip grouping also normalizes the peer id.
    const groups = buildAgentDmChipGroups([received]);
    expect(groups[0].peerId).toBe("duya");
  });
});

describe("timestamp resolution across Message shapes", () => {
  it("falls back to createdAt when timestamp is absent (wire rows)", () => {
    const base = dmMarker({
      direction: "sent",
      peerId: "peer",
      peerName: "Peer",
      text: "hello",
      clientMsgId: "m1",
    });
    // Wire row from getMessagesBySessionIPC: createdAt only, no timestamp.
    const wireRow = { ...base, createdAt: 1700000000000, timestamp: undefined } as unknown as Message;
    const merged = buildAgentDmPairMessages("self", "peer", [wireRow], []);
    expect(merged).toHaveLength(1);
    expect(merged[0].timestamp).toBe(1700000000000);

    const groups = buildAgentDmChipGroups([wireRow]);
    expect(groups[0].firstTimestamp).toBe(1700000000000);
  });
});

describe("legacy marker text (no meta.text)", () => {
  it("strips the persisted transcript prefix as a fallback", () => {
    const legacy = dmMarker({
      direction: "sent",
      peerId: "p1",
      peerName: "原型师",
      text: "原始正文",
      clientMsgId: "m9",
    });
    // Simulate a pre-497 row: content carries the prefix, meta.text absent.
    const stripped = {
      ...legacy,
      agentDmMeta: {
        ...(legacy.agentDmMeta as unknown as Record<string, unknown>),
        text: undefined,
      },
    } as Message;
    const merged = buildAgentDmPairMessages("self", "p1", [stripped], []);
    expect(merged).toHaveLength(1);
    expect(merged[0].text).toBe("原始正文");
  });
});
