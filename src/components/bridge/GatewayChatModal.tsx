"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { XIcon, SpinnerGapIcon, ChatCircleIcon } from "@/components/icons";
import { getMessagesBySessionIPC, type GatewaySession } from "@/lib/ipc-client";
import { subscribeToPhase, getSnapshot } from "@/lib/stream-session-manager";
import type { Message } from "@/types";
import type { StreamPhase } from "@/types/message";
import { MessageList } from "@/components/chat/MessageList";
import type { MessageListRef } from "@/components/chat/MessageList";

interface GatewayChatModalProps {
  session: GatewaySession;
  onClose: () => void;
}

const ACTIVE_PHASES: StreamPhase[] = ["starting", "streaming", "awaiting_permission", "persisting"];

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function getPlatformDisplay(session: GatewaySession): string {
  const platformNames: Record<string, string> = {
    telegram: "Telegram",
    feishu: "Feishu",
    qq: "QQ Guild",
    weixin: "WeChat",
    unknown: "Unknown",
  };
  return platformNames[session.platform] || session.platform;
}

export function GatewayChatModal({ session, onClose }: GatewayChatModalProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [isStreaming, setIsStreaming] = useState(false);
  const [phase, setPhase] = useState<StreamPhase>("idle");
  const messageListRef = useRef<MessageListRef>(null);

  // Load messages for this session
  const loadMessages = useCallback(async () => {
    try {
      console.log("[GatewayChatModal] Loading messages for session:", session.id);
      const dbMessages = await getMessagesBySessionIPC(session.id);
      console.log("[GatewayChatModal] Loaded messages:", dbMessages.length, dbMessages);
      // Convert to store's expected format with timestamp
      const converted: Message[] = dbMessages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        name: m.name ?? undefined,
        tool_call_id: m.toolCallId ?? undefined,
        timestamp: m.createdAt,
        tokenUsage: m.tokenUsage
          ? typeof m.tokenUsage === "string"
            ? JSON.parse(m.tokenUsage)
            : m.tokenUsage
          : undefined,
        msgType: (m.msgType || undefined) as Message["msgType"],
        thinking: m.thinking ?? undefined,
        toolName: m.toolName ?? undefined,
        toolInput: m.toolInput ?? undefined,
        parentToolCallId: m.parentToolCallId ?? undefined,
        vizSpec: m.vizSpec ?? undefined,
        status: m.status ?? undefined,
        seqIndex: m.seqIndex ?? undefined,
        durationMs: m.durationMs ?? undefined,
        subAgentId: m.subAgentId ?? undefined,
      }));
      setMessages(converted);
    } catch (err) {
      console.error("[GatewayChatModal] Failed to load session messages:", err);
    } finally {
      setLoading(false);
    }
  }, [session.id]);

  // Subscribe to streaming phase changes
  useEffect(() => {
    loadMessages();

    const unsubscribePhase = subscribeToPhase(session.id, (newPhase: StreamPhase) => {
      setPhase(newPhase);
      setIsStreaming(ACTIVE_PHASES.includes(newPhase));
    });

    // Check initial state
    const snapshot = getSnapshot(session.id);
    if (snapshot) {
      setPhase(snapshot.phase);
      setIsStreaming(ACTIVE_PHASES.includes(snapshot.phase));
    }

    return () => {
      unsubscribePhase();
    };
  }, [session.id, loadMessages]);

  // Scroll to bottom on new messages
  useEffect(() => {
    if (messages.length > 0 && messageListRef.current) {
      messageListRef.current.scrollToBottom?.();
    }
  }, [messages.length, isStreaming]);

  // Handle escape key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="gateway-chat-modal-overlay" onClick={onClose}>
      <div
        className="gateway-chat-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="gateway-chat-modal-title"
      >
        {/* Header */}
        <div className="gateway-chat-modal-header">
          <div className="gateway-chat-modal-title">
            <ChatCircleIcon size={18} className="text-accent" />
            <div className="flex flex-col">
              <span id="gateway-chat-modal-title" className="text-sm font-medium">
                {session.title || "Untitled Session"}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {getPlatformDisplay(session)} · Session {session.id.slice(0, 12)}...
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isStreaming && (
              <span className="gateway-streaming-badge">
                <span className="gateway-streaming-dot" />
                Streaming
              </span>
            )}
            <button
              className="gateway-chat-modal-close"
              onClick={onClose}
              aria-label="Close"
            >
              <XIcon size={18} />
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="gateway-chat-modal-content">
          {loading ? (
            <div className="flex items-center justify-center h-full gap-2">
              <SpinnerGapIcon size={18} className="animate-spin" />
              <span className="text-sm text-muted-foreground">Loading messages...</span>
            </div>
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-2">
              <ChatCircleIcon size={32} className="text-muted-foreground/30" />
              <p className="text-sm text-muted-foreground">No messages yet</p>
              <p className="text-[10px] text-muted-foreground/60">
                Messages from {getPlatformDisplay(session)} will appear here
              </p>
            </div>
          ) : (
            <MessageList
              ref={messageListRef}
              sessionId={session.id}
              messages={messages}
              isStreaming={isStreaming}
            />
          )}
        </div>

        {/* Footer - Gateway sessions are read-only */}
        <div className="gateway-chat-modal-footer">
          <p className="text-[10px] text-muted-foreground/60">
            Gateway sessions are read-only. Messages are exchanged through{" "}
            {getPlatformDisplay(session)}.
          </p>
        </div>
      </div>
    </div>
  );
}
