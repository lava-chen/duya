/**
 * useAgentPort.ts - React hook for consuming Agent events via MessagePort
 *
 * This hook provides a way to receive real-time chat events from the Agent
 * through the AgentControlChannel MessagePort, bypassing SSE.
 *
 * Features:
 * - Text streaming
 * - Thinking content
 * - Tool use and result tracking
 * - Tool output streaming
 * - Permission request handling
 * - Context usage tracking
 * - Error handling
 */

import { useEffect, useCallback, useRef, useState } from 'react';

// ============================================================================
// TYPES
// ============================================================================

export interface UseAgentPortOptions {
  /** Session ID for the current chat */
  sessionId: string;
  /** Enable SSE fallback when MessagePort is not available */
  useSSEFallback?: boolean;
  /** Callback when text chunk is received */
  onText?: (content: string) => void;
  /** Callback when thinking content is received */
  onThinking?: (content: string) => void;
  /** Callback when a tool use starts */
  onToolUse?: (data: { id: string; name: string; input: unknown }) => void;
  /** Callback when a tool result is received */
  onToolResult?: (data: { id: string; result: unknown; error?: string }) => void;
  /** Callback when tool progress is updated */
  onToolProgress?: (data: { toolUseId: string; percent: number; stage: string }) => void;
  /** Callback when tool output is streamed */
  onToolOutput?: (data: { toolUseId: string; stream: 'stdout' | 'stderr'; data: string }) => void;
  /** Callback when sub-agent progress is received */
  onAgentProgress?: (data: {
    agentEventType: string;
    data?: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
    toolResult?: string;
    duration?: number;
    agentId?: string;
    agentType?: string;
    agentName?: string;
    agentDescription?: string;
    agentSessionId?: string;
  }) => void;
  /** Callback when permission request is received */
  onPermission?: (request: { id: string; toolName: string; toolInput: Record<string, unknown> }) => void;
  /** Callback when context usage is updated */
  onContextUsage?: (data: { usedTokens: number; contextWindow: number; percentFull: number }) => void;
  /** Callback when chat is done */
  onDone?: () => void;
  /** Callback when error occurs */
  onError?: (message: string) => void;
  /** Callback when status message is received */
  onStatus?: (message: string) => void;
  /** Callback when skill review starts */
  onSkillReviewStarted?: () => void;
  /** Callback when skill review completes */
  onSkillReviewCompleted?: (data: { passed: boolean; score: number; feedback: string; skillName?: string; error?: string }) => void;
  /** Callback when session title is generated */
  onTitleGenerated?: (data: { title: string }) => void;
  /** Callback when context compaction completes */
  onCompacted?: (sessionId?: string) => void;
  /** Callback when context compaction fails */
  onCompactError?: (message: string) => void;
}

export interface UseAgentPortReturn {
  /** Whether the agent port is connected */
  isConnected: boolean;
  /** Start a new chat session */
  startChat: (prompt: string, options?: Record<string, unknown>) => void;
  /** Interrupt the current chat */
  interruptChat: () => void;
  /** Resolve a permission request */
  resolvePermission: (id: string, decision: 'allow' | 'deny' | 'allow_once' | 'allow_for_session', extra?: Record<string, unknown>) => void;
  /** Trigger context compaction */
  compactContext: () => void;
}

// ============================================================================
// HOOK IMPLEMENTATION
// ============================================================================

/**
 * Hook for receiving Agent events via MessagePort
 *
 * @example
 * ```tsx
 * function ChatView({ sessionId }) {
 *   const { isConnected, startChat, interruptChat } = useAgentPort({
 *     sessionId,
 *     onText: (content) => console.log('Text:', content),
 *     onToolUse: (data) => console.log('Tool:', data.name),
 *   });
 *
 *   return <div>{isConnected ? 'Connected' : 'Disconnected'}</div>;
 * }
 * ```
 */
export function useAgentPort(options: UseAgentPortOptions): UseAgentPortReturn {
  const {
    sessionId,
    onText,
    onThinking,
    onToolUse,
    onToolResult,
    onToolProgress,
    onToolOutput,
    onAgentProgress,
    onPermission,
    onContextUsage,
    onDone,
    onError,
    onStatus,
    onSkillReviewStarted,
    onSkillReviewCompleted,
    onTitleGenerated,
    onCompacted,
    onCompactError,
  } = options;

  const [isConnected, setIsConnected] = useState(false);
  const cleanupFunctionsRef = useRef<(() => void)[]>([]);

  // Set up event listeners when agentPort is available
  useEffect(() => {
    const api = window.electronAPI?.getAgentPort?.();
    if (!api) {
      console.log('[useAgentPort] Agent port not available');
      return;
    }

    // Register event handlers
    const cleanups: (() => void)[] = [];

    if (onText) {
      cleanups.push(api.onText(onText));
    }
    if (onThinking) {
      cleanups.push(api.onThinking(onThinking));
    }
    if (onToolUse) {
      cleanups.push(api.onToolUse(onToolUse));
    }
    if (onToolResult) {
      cleanups.push(api.onToolResult(onToolResult));
    }
    if (onToolProgress) {
      cleanups.push(api.onToolProgress(onToolProgress));
    }
    if (onToolOutput) {
      cleanups.push(api.onToolOutput(onToolOutput));
    }
    if (onAgentProgress) {
      cleanups.push(api.onAgentProgress(onAgentProgress));
    }
    if (onPermission) {
      cleanups.push(api.onPermission(onPermission));
    }
    if (onContextUsage) {
      cleanups.push(api.onContextUsage(onContextUsage));
    }
    if (onDone) {
      cleanups.push(api.onDone(onDone));
    }
    if (onError) {
      cleanups.push(api.onError(onError));
    }
    if (onStatus) {
      cleanups.push(api.onStatus(onStatus));
    }
    if (onSkillReviewStarted) {
      cleanups.push(api.onSkillReviewStarted(onSkillReviewStarted));
    }
    if (onSkillReviewCompleted) {
      cleanups.push(api.onSkillReviewCompleted(onSkillReviewCompleted));
    }
    if (onTitleGenerated) {
      cleanups.push(api.onTitleGenerated((data) => onTitleGenerated(data)));
    }
    if (onCompacted) {
      cleanups.push(api.onCompactDone((sessionId) => onCompacted(sessionId)));
    }
    if (onCompactError) {
      cleanups.push(api.onCompactError((message) => onCompactError(message)));
    }

    cleanupFunctionsRef.current = cleanups;
    setIsConnected(true);

    console.log('[useAgentPort] Connected to agent port');

    // Cleanup on unmount or when handlers change
    return () => {
      cleanups.forEach(cleanup => cleanup());
      cleanupFunctionsRef.current = [];
      setIsConnected(false);
      console.log('[useAgentPort] Disconnected from agent port');
    };
  }, [
    onText,
    onThinking,
    onToolUse,
    onToolResult,
    onToolProgress,
    onToolOutput,
    onAgentProgress,
    onPermission,
    onContextUsage,
    onDone,
    onError,
    onStatus,
    onSkillReviewStarted,
    onSkillReviewCompleted,
    onTitleGenerated,
    onCompacted,
    onCompactError,
  ]);

  // Start chat
  const startChat = useCallback((prompt: string, opts?: Record<string, unknown>) => {
    const api = window.electronAPI?.getAgentPort?.();
    if (api) {
      api.startChat(sessionId, prompt, opts);
    } else {
      console.warn('[useAgentPort] Cannot start chat: agent port not available');
    }
  }, [sessionId]);

  // Interrupt chat
  const interruptChat = useCallback(() => {
    const api = window.electronAPI?.getAgentPort?.();
    if (api && sessionId) {
      api.interruptChat(sessionId);
    } else {
      console.warn('[useAgentPort] Cannot interrupt chat: agent port not available');
    }
  }, [sessionId]);

  // Resolve permission
  const resolvePermission = useCallback((id: string, decision: 'allow' | 'deny' | 'allow_once' | 'allow_for_session', extra?: Record<string, unknown>) => {
    const api = window.electronAPI?.getAgentPort?.();
    if (api) {
      api.resolvePermission(id, decision, extra);
    } else {
      console.warn('[useAgentPort] Cannot resolve permission: agent port not available');
    }
  }, []);

  // Compact context
  const compactContext = useCallback(() => {
    const api = window.electronAPI?.getAgentPort?.();
    if (api && sessionId) {
      api.compactContext(sessionId);
    } else {
      console.warn('[useAgentPort] Cannot compact context: agent port not available');
    }
  }, [sessionId]);

  return {
    isConnected,
    startChat,
    interruptChat,
    resolvePermission,
    compactContext,
  };
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Check if AgentControlPort is available
 */
export function isAgentPortAvailable(): boolean {
  return !!window.electronAPI?.getAgentPort?.();
}

/**
 * Get the feature flag for SSE fallback
 */
export function shouldUseSSEFallback(): boolean {
  return import.meta.env.VITE_DUYA_USE_SSE_FALLBACK === 'true' || !isAgentPortAvailable();
}
