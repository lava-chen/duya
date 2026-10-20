// btw-store.ts - Zustand store for the "/btw" side-question (旁侧问答) overlay.
//
// In-memory only (Plan 317): the frontend never writes chat messages to the DB
// and side questions never mutate the durable transcript. History is keyed by
// sessionId and survives open/close within the same session, but is dropped on
// app restart.

import { create } from 'zustand';

export interface BtwEntry {
  id: string;
  question: string;
  answer: string;
  status: 'loading' | 'done' | 'error';
  error?: string;
  expanded: boolean;
}

interface BtwState {
  entriesBySession: Record<string, BtwEntry[]>;
  addQuestion: (sessionId: string, question: string) => string;
  setAnswer: (sessionId: string, id: string, answer: string) => void;
  setError: (sessionId: string, id: string, error: string) => void;
  toggleExpanded: (sessionId: string, id: string) => void;
  clear: (sessionId: string) => void;
}

export const useBtwStore = create<BtwState>()((set) => ({
  entriesBySession: {},

  addQuestion: (sessionId, question) => {
    const id = crypto.randomUUID();
    const entry: BtwEntry = {
      id,
      question,
      answer: '',
      status: 'loading',
      expanded: true,
    };
    set((state) => ({
      entriesBySession: {
        ...state.entriesBySession,
        [sessionId]: [...(state.entriesBySession[sessionId] ?? []), entry],
      },
    }));
    return id;
  },

  setAnswer: (sessionId, id, answer) => {
    set((state) => {
      const entries = state.entriesBySession[sessionId] ?? [];
      return {
        entriesBySession: {
          ...state.entriesBySession,
          [sessionId]: entries.map((e) =>
            e.id === id ? { ...e, answer, status: 'done' as const } : e,
          ),
        },
      };
    });
  },

  setError: (sessionId, id, error) => {
    set((state) => {
      const entries = state.entriesBySession[sessionId] ?? [];
      return {
        entriesBySession: {
          ...state.entriesBySession,
          [sessionId]: entries.map((e) =>
            e.id === id ? { ...e, error, status: 'error' as const } : e,
          ),
        },
      };
    });
  },

  toggleExpanded: (sessionId, id) => {
    set((state) => {
      const entries = state.entriesBySession[sessionId] ?? [];
      return {
        entriesBySession: {
          ...state.entriesBySession,
          [sessionId]: entries.map((e) =>
            e.id === id ? { ...e, expanded: !e.expanded } : e,
          ),
        },
      };
    });
  },

  clear: (sessionId) => {
    set((state) => {
      const { [sessionId]: _removed, ...rest } = state.entriesBySession;
      return { entriesBySession: rest };
    });
  },
}));