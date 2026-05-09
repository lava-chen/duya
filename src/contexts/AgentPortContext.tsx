'use client';

/**
 * AgentPortContext.tsx - Context provider for Agent MessagePort connection
 *
 * This context provides a centralized way to manage the AgentControlChannel
 * MessagePort connection and distribute events to child components.
 *
 * Features:
 * - Manages MessagePort lifecycle
 * - Distributes events to subscribed components via useAgentPort hook
 * - Handles reconnection logic
 * - Provides SSE fallback when MessagePort is not available
 */

import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';

// ============================================================================
// TYPES
// ============================================================================

export interface AgentEventHandlers {
  onText?: (content: string) => void;
  onThinking?: (content: string) => void;
  onToolUse?: (data: { id: string; name: string; input: unknown }) => void;
  onToolResult?: (data: { id: string; result: unknown; error?: string }) => void;
  onToolProgress?: (data: { toolUseId: string; percent: number; stage: string }) => void;
  onToolOutput?: (data: { toolUseId: string; stream: 'stdout' | 'stderr'; data: string }) => void;
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
  onPermission?: (request: { id: string; toolName: string; toolInput: Record<string, unknown> }) => void;
  onContextUsage?: (data: { usedTokens: number; contextWindow: number; percentFull: number }) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
  onStatus?: (message: string) => void;
  onRetry?: (data: { attempt: number; maxAttempts: number; delayMs: number; message: string }) => void;
}

interface AgentPortContextType {
  /** Whether the agent port is connected and available */
  isConnected: boolean;
  /** Whether SSE fallback is being used */
  isSSEFallback: boolean;
  /** Current session ID */
  sessionId: string | null;
  /** Set the current session ID */
  setSessionId: (id: string | null) => void;
  /** Register event handlers for the current session */
  registerHandlers: (handlers: AgentEventHandlers) => () => void;
  /** Start a chat */
  startChat: (prompt: string, options?: Record<string, unknown>) => void;
  /** Interrupt the current chat */
  interruptChat: () => void;
  /** Resolve a permission request */
  resolvePermission: (id: string, decision: 'allow' | 'deny' | 'allow_once' | 'allow_for_session', extra?: Record<string, unknown>) => void;
  /** Trigger context compaction */
  compactContext: () => void;
}

const AgentPortContext = createContext<AgentPortContextType | undefined>(undefined);

// ============================================================================
// PROVIDER
// ============================================================================

interface AgentPortProviderProps {
  children: React.ReactNode;
  /** Feature flag: use SSE fallback when MessagePort is not available */
  useSSEFallback?: boolean;
}

export function AgentPortProvider({ children, useSSEFallback = false }: AgentPortProviderProps) {
  const [isConnected, setIsConnected] = useState(false);
  const [isSSEFallback, setIsSSEFallback] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [registeredHandlers, setRegisteredHandlers] = useState<AgentEventHandlers>({});

  // Cleanup functions for registered handlers
  const cleanupFunctionsRef = useRef<(() => void)[]>([]);

  // Set up agent port connection when sessionId changes or on mount
  useEffect(() => {
    const api = window.electronAPI?.getAgentPort?.();
    if (!api) {
      console.log('[AgentPortContext] Agent port not available');
      setIsSSEFallback(true);
      setIsConnected(false);
      return;
    }

    setIsSSEFallback(false);

    // Register event handlers
    const cleanups: (() => void)[] = [];

    if (registeredHandlers.onText) {
      cleanups.push(api.onText(registeredHandlers.onText));
    }
    if (registeredHandlers.onThinking) {
      cleanups.push(api.onThinking(registeredHandlers.onThinking));
    }
    if (registeredHandlers.onToolUse) {
      cleanups.push(api.onToolUse(registeredHandlers.onToolUse));
    }
    if (registeredHandlers.onToolResult) {
      cleanups.push(api.onToolResult(registeredHandlers.onToolResult));
    }
    if (registeredHandlers.onToolProgress) {
      cleanups.push(api.onToolProgress(registeredHandlers.onToolProgress));
    }
    if (registeredHandlers.onToolOutput) {
      cleanups.push(api.onToolOutput(registeredHandlers.onToolOutput));
    }
    if (registeredHandlers.onAgentProgress) {
      cleanups.push(api.onAgentProgress(registeredHandlers.onAgentProgress));
    }
    if (registeredHandlers.onPermission) {
      cleanups.push(api.onPermission(registeredHandlers.onPermission));
    }
    if (registeredHandlers.onContextUsage) {
      cleanups.push(api.onContextUsage(registeredHandlers.onContextUsage));
    }
    if (registeredHandlers.onDone) {
      cleanups.push(api.onDone(registeredHandlers.onDone));
    }
    if (registeredHandlers.onError) {
      cleanups.push(api.onError(registeredHandlers.onError));
    }
    if (registeredHandlers.onStatus) {
      cleanups.push(api.onStatus(registeredHandlers.onStatus));
    }
    if (registeredHandlers.onRetry) {
      cleanups.push(api.onRetry(registeredHandlers.onRetry));
    }

    cleanupFunctionsRef.current = cleanups;
    setIsConnected(true);

    console.log('[AgentPortContext] Connected to agent port');

    // Cleanup on unmount or when handlers/sessionId change
    return () => {
      cleanups.forEach(cleanup => cleanup());
      cleanupFunctionsRef.current = [];
      setIsConnected(false);
      console.log('[AgentPortContext] Disconnected from agent port');
    };
  }, [sessionId, registeredHandlers]);

  // Start chat
  const startChat = useCallback((prompt: string, opts?: Record<string, unknown>) => {
    if (!sessionId) {
      console.warn('[AgentPortContext] Cannot start chat: no session ID');
      return;
    }
    const api = window.electronAPI?.getAgentPort?.();
    if (api) {
      api.startChat(sessionId, prompt, opts);
    } else {
      console.warn('[AgentPortContext] Cannot start chat: agent port not available');
    }
  }, [sessionId]);

  // Interrupt chat
  const interruptChat = useCallback(() => {
    const api = window.electronAPI?.getAgentPort?.();
    if (api && sessionId) {
      api.interruptChat(sessionId);
    }
  }, [sessionId]);

  // Resolve permission
  const resolvePermission = useCallback((id: string, decision: 'allow' | 'deny' | 'allow_once' | 'allow_for_session', extra?: Record<string, unknown>) => {
    const api = window.electronAPI?.getAgentPort?.();
    if (api) {
      api.resolvePermission(id, decision, extra);
    }
  }, []);

  // Compact context
  const compactContext = useCallback(() => {
    const api = window.electronAPI?.getAgentPort?.();
    if (api && sessionId) {
      api.compactContext(sessionId);
    } else {
      console.warn('[AgentPortContext] Cannot compact context: agent port not available');
    }
  }, [sessionId]);

  // Register handlers
  const registerHandlers = useCallback((handlers: AgentEventHandlers) => {
    setRegisteredHandlers(prev => ({ ...prev, ...handlers }));

    // Return cleanup function
    return () => {
      setRegisteredHandlers(prev => {
        const next = { ...prev };
        if (handlers.onText) delete next.onText;
        if (handlers.onThinking) delete next.onThinking;
        if (handlers.onToolUse) delete next.onToolUse;
        if (handlers.onToolResult) delete next.onToolResult;
        if (handlers.onToolProgress) delete next.onToolProgress;
        if (handlers.onToolOutput) delete next.onToolOutput;
        if (handlers.onAgentProgress) delete next.onAgentProgress;
        if (handlers.onPermission) delete next.onPermission;
        if (handlers.onContextUsage) delete next.onContextUsage;
        if (handlers.onDone) delete next.onDone;
        if (handlers.onError) delete next.onError;
        if (handlers.onStatus) delete next.onStatus;
        if (handlers.onRetry) delete next.onRetry;
        return next;
      });
    };
  }, []);

  return (
    <AgentPortContext.Provider
      value={{
        isConnected,
        isSSEFallback,
        sessionId,
        setSessionId,
        registerHandlers,
        startChat,
        interruptChat,
        resolvePermission,
        compactContext,
      }}
    >
      {children}
    </AgentPortContext.Provider>
  );
}

// ============================================================================
// HOOK
// ============================================================================

export function useAgentPortContext() {
  const context = useContext(AgentPortContext);
  if (context === undefined) {
    throw new Error('useAgentPortContext must be used within an AgentPortProvider');
  }
  return context;
}

// ============================================================================
// UTILITY
// ============================================================================

/**
 * Check if AgentControlPort is available
 */
export function isAgentPortAvailable(): boolean {
  return !!window.electronAPI?.getAgentPort?.();
}

/**
 * Get the SSE fallback preference from environment
 */
export function getSSEFallbackPreference(): boolean {
  return import.meta.env.VITE_DUYA_USE_SSE_FALLBACK === 'true';
}
