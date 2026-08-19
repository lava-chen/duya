// src/hooks/useHookTasks.ts
// Subscribe to background hook task snapshots streamed from the agent
// worker via the `hook_task:update` IPC channel (async: true hooks). The
// worker pushes a new snapshot on every register / progress / complete /
// kill / cleanup, so this hook only needs to filter by the active thread
// id and store the latest list. No polling required.

'use client';

import { useEffect, useState } from 'react';
import type { HookTaskSnapshot } from '@/types/hook-task';

export interface UseHookTasksResult {
  tasks: HookTaskSnapshot[];
  runningCount: number;
}

export function useHookTasks(threadId: string | null): UseHookTasksResult {
  const [tasks, setTasks] = useState<HookTaskSnapshot[]>([]);

  useEffect(() => {
    if (!threadId) {
      setTasks([]);
      return;
    }

    const unsubscribe = window.electronAPI?.onHookTaskUpdate?.((data) => {
      // Snapshots are scoped to the worker's session id; ignore updates
      // for other sessions (e.g. interagent siblings).
      if (data.sessionId !== threadId) return;
      setTasks(data.tasks);
    });

    // Clear the list immediately on thread switch so stale rows from the
    // previous session do not linger while the first update is in flight.
    setTasks([]);

    return () => {
      unsubscribe?.();
    };
  }, [threadId]);

  const runningCount = tasks.filter((t) => t.status === 'running').length;

  return { tasks, runningCount };
}
