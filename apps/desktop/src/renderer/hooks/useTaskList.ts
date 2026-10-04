// apps/desktop/src/renderer/hooks/useTaskList.ts
// Fetch and cache the task list for a single thread. The caller is
// responsible for polling — this hook only handles the one-shot fetch
// + thread-id switch + error fallback. Returns a `fetchTasks` refetch
// so consumers can wire it to their own setInterval.

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Task } from '@duya/agent';

export interface UseTaskListResult {
  tasks: Task[];
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  loading: boolean;
  fetchTasks: () => Promise<void>;
}

export function useTaskList(threadId: string | null): UseTaskListResult {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(false);
  // Monotonic sequence — bumping it invalidates any in-flight request, so a
  // slow response for a previously-selected thread cannot overwrite the
  // newly-selected thread's list. Mirrors useNextStepSuggestions.
  const requestSeqRef = useRef(0);

  const fetchTasks = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    if (!threadId) {
      setTasks([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const raw = await window.electronAPI?.thread?.getTasks?.(threadId);
      if (seq !== requestSeqRef.current) return;
      if (raw) {
        const parsed = (raw as Task[]).map((task) => ({
          ...task,
          blocks: task.blocks || [],
          blockedBy: task.blockedBy || [],
        }));
        setTasks(parsed);
      } else {
        setTasks([]);
      }
    } catch (err) {
      console.error('[TaskDrawer] fetch failed:', err);
    } finally {
      // Only the newest request owns the spinner: a superseded response
      // must not clear the loading state its replacement is still using.
      if (seq === requestSeqRef.current) setLoading(false);
    }
  }, [threadId]);

  useEffect(() => {
    setTasks([]);
    void fetchTasks();
  }, [threadId, fetchTasks]);

  return { tasks, setTasks, loading, fetchTasks };
}