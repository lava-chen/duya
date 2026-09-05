/**
 * Plan 491 P1.3: Session phase store for state/usage micro-slicing.
 *
 * Separates status, agent_progress, and token_usage from the main
 * conversation store. This prevents state updates from triggering
 * re-renders of components that only care about message content.
 *
 * Events routed here:
 *   - status changes (idle/streaming/thinking/tool/waiting_approval/error)
 *   - agent_progress updates
 *   - token_usage updates
 */

import { create } from 'zustand';

/** Session phase states - derived from stream events. */
export type SessionPhase =
  | 'idle'
  | 'streaming'
  | 'thinking'
  | 'tool'
  | 'waiting_approval'
  | 'error';

/** Token usage for a session. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Agent progress message. */
export interface AgentProgress {
  message: string;
  timestamp: number;
}

/** Session phase state - per session. */
export interface SessionPhaseState {
  /** Current session phase */
  phase: SessionPhase;
  /** Agent progress message (if any) */
  agentProgress: AgentProgress | null;
  /** Token usage for the current turn */
  tokenUsage: TokenUsage | null;
  /** Cumulative token usage for the session */
  cumulativeTokenUsage: TokenUsage | null;
  /** Error message (if phase is 'error') */
  error: string | null;
}

/** Session phase store state. */
interface SessionPhaseStore {
  /** Per-session phase state */
  sessions: Record<string, SessionPhaseState>;

  // Actions

  /** Set the session phase */
  setPhase: (sessionId: string, phase: SessionPhase) => void;

  /** Set agent progress */
  setAgentProgress: (sessionId: string, message: string) => void;

  /** Clear agent progress */
  clearAgentProgress: (sessionId: string) => void;

  /** Set token usage for current turn */
  setTokenUsage: (sessionId: string, usage: TokenUsage) => void;

  /** Add to cumulative token usage */
  addToCumulativeTokenUsage: (sessionId: string, usage: TokenUsage) => void;

  /** Set error state */
  setError: (sessionId: string, error: string | null) => void;

  /** Get phase for a session (defaults to 'idle') */
  getPhase: (sessionId: string) => SessionPhase;

  /** Get token usage for a session */
  getTokenUsage: (sessionId: string) => TokenUsage | null;

  /** Reset session phase state */
  resetSession: (sessionId: string) => void;
}

/** Default state for a session. */
function createDefaultSessionState(): SessionPhaseState {
  return {
    phase: 'idle',
    agentProgress: null,
    tokenUsage: null,
    cumulativeTokenUsage: null,
    error: null,
  };
}

/** Session phase store - separate from conversation store to prevent unnecessary re-renders. */
export const useSessionPhaseStore = create<SessionPhaseStore>((set, get) => ({
  sessions: {},

  setPhase: (sessionId, phase) => {
    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...(state.sessions[sessionId] ?? createDefaultSessionState()),
          phase,
          // Clear error when phase changes away from error
          ...(phase !== 'error' ? { error: null } : {}),
        },
      },
    }));
  },

  setAgentProgress: (sessionId, message) => {
    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...(state.sessions[sessionId] ?? createDefaultSessionState()),
          agentProgress: { message, timestamp: Date.now() },
        },
      },
    }));
  },

  clearAgentProgress: (sessionId) => {
    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...(state.sessions[sessionId] ?? createDefaultSessionState()),
          agentProgress: null,
        },
      },
    }));
  },

  setTokenUsage: (sessionId, usage) => {
    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...(state.sessions[sessionId] ?? createDefaultSessionState()),
          tokenUsage: usage,
        },
      },
    }));
  },

  addToCumulativeTokenUsage: (sessionId, usage) => {
    set((state) => {
      const current = state.sessions[sessionId]?.cumulativeTokenUsage ?? {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      };
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...(state.sessions[sessionId] ?? createDefaultSessionState()),
            cumulativeTokenUsage: {
              inputTokens: current.inputTokens + usage.inputTokens,
              outputTokens: current.outputTokens + usage.outputTokens,
              totalTokens: current.totalTokens + usage.totalTokens,
              cacheReadTokens: (current.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0),
              cacheWriteTokens: (current.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
            },
          },
        },
      };
    });
  },

  setError: (sessionId, error) => {
    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...(state.sessions[sessionId] ?? createDefaultSessionState()),
          phase: error ? 'error' : (state.sessions[sessionId]?.phase ?? 'idle'),
          error,
        },
      },
    }));
  },

  getPhase: (sessionId) => {
    return get().sessions[sessionId]?.phase ?? 'idle';
  },

  getTokenUsage: (sessionId) => {
    return get().sessions[sessionId]?.tokenUsage ?? null;
  },

  resetSession: (sessionId) => {
    set((state) => {
      const next = { ...state.sessions };
      delete next[sessionId];
      return { sessions: next };
    });
  },
}));
