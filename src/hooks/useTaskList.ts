// src/hooks/useTaskList.ts
// Fetch and cache the task list for a single thread. The caller is
// responsible for polling — this hook only handles the one-shot fetch
// + thread-id switch + error fallback. Returns a `fetchTasks` refetch
// so consumers can wire it to their own setInterval.

'use client';

import { useCallback, useEffect, useState } from 'react';
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

  const fetchTasks = useCallback(async () => {
    if (!threadId) {
      setTasks([]);
      return;
    }

    setLoading(true);
    try {
      const raw = await window.electronAPI?.thread?.getTasks?.(threadId);
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
      setLoading(false);
    }
  }, [threadId]);

  useEffect(() => {
    setTasks([]);
    void fetchTasks();
  }, [threadId, fetchTasks]);

  return { tasks, setTasks, loading, fetchTasks };
}