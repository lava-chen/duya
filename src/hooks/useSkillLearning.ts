import { useCallback, useEffect, useState } from 'react';

export type SkillLearningStatus = 'published' | 'skipped' | 'failed';

export interface SkillLearningEvent {
  id: string;
  session_id: string;
  skill_name: string | null;
  status: SkillLearningStatus;
  reason: string;
  score: number | null;
  feedback: string | null;
  executed_task: string | null;
  dimensions_json: string | null;
  iteration_count: number;
  max_iterations: number;
  final_path: string | null;
  error: string | null;
  read_at: number | null;
  created_at: number;
}

function getLearningApi() {
  return window.electronAPI?.skills?.learning;
}

export function useSkillLearning(limit = 30) {
  const [events, setEvents] = useState<SkillLearningEvent[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const api = getLearningApi();
    if (!api) {
      setLoading(false);
      return;
    }
    try {
      const [eventsResult, unreadResult] = await Promise.all([
        api.list({ limit }),
        api.unreadCount(),
      ]);
      if (eventsResult.success) {
        setEvents(eventsResult.events as SkillLearningEvent[]);
      }
      if (unreadResult.success) {
        setUnreadCount(unreadResult.count);
      }
    } catch (error) {
      // The backend handler may be unavailable during development if the
      // Electron main process has not been rebuilt/restarted. Fail silently
      // so the rest of the UI is not disrupted.
      if (typeof console !== 'undefined') {
        console.warn('[useSkillLearning] refresh failed:', error);
      }
    } finally {
      setLoading(false);
    }
  }, [limit]);

  const markRead = useCallback(async (ids?: string[]) => {
    const api = getLearningApi();
    if (!api) return;
    try {
      const result = await api.markRead(ids);
      if (result.success) {
        await refresh();
      }
    } catch (error) {
      if (typeof console !== 'undefined') {
        console.warn('[useSkillLearning] markRead failed:', error);
      }
    }
  }, [refresh]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    const unsubscribe = getLearningApi()?.onCreated(() => void refresh());
    return () => {
      window.clearInterval(timer);
      unsubscribe?.();
    };
  }, [refresh]);

  return { events, unreadCount, loading, refresh, markRead };
}
