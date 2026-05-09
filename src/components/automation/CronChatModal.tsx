"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { XIcon, SpinnerGapIcon, ArrowUpIcon, StopIcon } from "@/components/icons";
import { Clock } from "@phosphor-icons/react";
import { getThreadIPC } from "@/lib/ipc-client";
import type { Message } from "@/types";
import { MessageList } from "@/components/chat/MessageList";
import type { MessageListRef } from "@/components/chat/MessageList";
import {
  startStream,
  stopStream,
  canSend,
  subscribeToPhase,
  subscribeToText,
} from "@/lib/stream-session-manager";
import type { StreamPhase } from "@/types";

interface CronChatModalProps {
  sessionId: string;
  sessionTitle: string;
  cronName: string;
  runStatus: string;
  onClose: () => void;
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function CronChatModal({
  sessionId,
  sessionTitle,
  cronName,
  runStatus,
  onClose,
}: CronChatModalProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [inputValue, setInputValue] = useState("");
  const [phase, setPhase] = useState<StreamPhase>("idle");
  const [streamingText, setStreamingText] = useState("");
  const messageListRef = useRef<MessageListRef>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load messages for this session
  const loadMessages = useCallback(async () => {
    try {
      const data = await getThreadIPC(sessionId);
      if (data) {
        // Convert to store's expected format with timestamp
        const converted: Message[] = (data.messages || []).map((m) => ({
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
      }
    } catch (err) {
      console.error("Failed to load cron session messages:", err);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    loadMessages();
  }, [sessionId, loadMessages]);

  // Subscribe to stream phase
  useEffect(() => {
    const unsubscribe = subscribeToPhase(sessionId, (newPhase) => {
      setPhase(newPhase);
    });
    return unsubscribe;
  }, [sessionId]);

  // Subscribe to streaming text
  useEffect(() => {
    const unsubscribe = subscribeToText(sessionId, (text) => {
      setStreamingText(text);
    });
    return unsubscribe;
  }, [sessionId]);

  // Scroll to bottom on new messages or streaming text
  useEffect(() => {
    if (messageListRef.current) {
      messageListRef.current.scrollToBottom?.();
    }
  }, [messages.length, streamingText]);

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

  const isStreaming = phase === "starting" || phase === "streaming" || phase === "awaiting_permission" || phase === "persisting";

  const handleSend = useCallback(() => {
    const trimmed = inputValue.trim();
    if (!trimmed || isStreaming) return;
    if (!canSend(sessionId)) return;

    // Add user message locally
    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: trimmed,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMessage]);
    setInputValue("");

    // Start stream
    void startStream({
      sessionId,
      content: trimmed,
    });
  }, [inputValue, isStreaming, sessionId]);

  const handleStop = useCallback(() => {
    void stopStream(sessionId);
  }, [sessionId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setInputValue(e.target.value);
      // Auto-adjust height
      const textarea = textareaRef.current;
      if (textarea) {
        textarea.style.height = "auto";
        textarea.style.height = `${Math.min(textarea.scrollHeight, 80)}px`;
      }
    },
    []
  );

  // Build display messages: include streaming assistant message if active
  const displayMessages = [...messages];
  if (isStreaming && streamingText) {
    displayMessages.push({
      id: "streaming",
      role: "assistant",
      content: streamingText,
      timestamp: Date.now(),
    });
  }

  const getStatusDisplay = () => {
    switch (runStatus) {
      case "running":
        return (
          <span className="cron-streaming-badge">
            <span className="cron-streaming-dot" />
            Running
          </span>
        );
      case "success":
        return (
          <span className="cron-status-badge success">
            Success
          </span>
        );
      case "failed":
        return (
          <span className="cron-status-badge error">
            Failed
          </span>
        );
      default:
        return null;
    }
  };

  return (
    <div className="cron-chat-modal-overlay" onClick={onClose}>
      <div
        className="cron-chat-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cron-chat-modal-title"
      >
        {/* Header */}
        <div className="cron-chat-modal-header">
          <div className="cron-chat-modal-title">
            <Clock size={18} className="text-accent" />
            <div className="flex flex-col">
              <span id="cron-chat-modal-title" className="text-sm font-medium">
                {sessionTitle || "Cron Session"}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {cronName} · Session {sessionId.slice(0, 12)}...
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {getStatusDisplay()}
            <button
              className="cron-chat-modal-close"
              onClick={onClose}
              aria-label="Close"
            >
              <XIcon size={18} />
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="cron-chat-modal-content">
          {loading ? (
            <div className="flex items-center justify-center h-full gap-2">
              <SpinnerGapIcon size={18} className="animate-spin" />
              <span className="text-sm text-muted-foreground">Loading messages...</span>
            </div>
          ) : displayMessages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-2">
              <Clock size={32} className="text-muted-foreground/30" />
              <p className="text-sm text-muted-foreground">No messages yet</p>
              <p className="text-[10px] text-muted-foreground/60">
                This cron job session has no messages
              </p>
            </div>
          ) : (
            <MessageList
              ref={messageListRef}
              sessionId={sessionId}
              messages={displayMessages}
              isStreaming={isStreaming}
            />
          )}
        </div>

        {/* Input Area */}
        <div className="cron-chat-modal-input-area">
          <div className="cron-chat-modal-input-wrapper">
            <textarea
              ref={textareaRef}
              className="cron-chat-modal-textarea"
              value={inputValue}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder="Type a message..."
              disabled={isStreaming}
              rows={1}
            />
            {isStreaming ? (
              <button
                type="button"
                onClick={handleStop}
                className="cron-chat-modal-stop-btn"
                title="Stop"
              >
                <StopIcon size={14} />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSend}
                disabled={!inputValue.trim()}
                className="cron-chat-modal-send-btn"
                title="Send"
              >
                <ArrowUpIcon size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
