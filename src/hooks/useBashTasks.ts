// src/hooks/useBashTasks.ts
// Subscribe to bash background task snapshots streamed from the agent
// worker via the `bash_task:update` IPC channel. The worker pushes a new
// snapshot on every register / progress / complete / kill / cleanup, so
// this hook only needs to filter by the active thread id and store the
// latest list. No polling required.

'use client';

import { useEffect, useState } from 'react';
import type { BashBackgroundTaskSnapshot } from '@/types';

export interface UseBashTasksResult {
  tasks: BashBackgroundTaskSnapshot[];
  runningCount: number;
}

export function useBashTasks(threadId: string | null): UseBashTasksResult {
  const [tasks, setTasks] = useState<BashBackgroundTaskSnapshot[]>([]);

  useEffect(() => {
    if (!threadId) {
      setTasks([]);
      return;
    }

    const unsubscribe = window.electronAPI?.onBashTaskUpdate?.((data) => {
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
