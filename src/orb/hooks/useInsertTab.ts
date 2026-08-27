/**
 * useInsertTab — wire Insert Tab button to main process IPC.
 *
 * Insert Tab 把 result.rawText 通过 nut.js type 到当前焦点输入框。
 * main process 校验 focusedEntity.redacted → password field 拒绝。
 */
import { useCallback, useState } from 'react';

export interface UseInsertTabReturn {
  insert: () => Promise<{ ok: boolean; error?: string }>;
  inserting: boolean;
  error: string | null;
  reset: () => void;
}

export function useInsertTab(): UseInsertTabReturn {
  const [inserting, setInserting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const insert = useCallback(async () => {
    setInserting(true);
    setError(null);
    try {
      const res = await window.electronAPI?.orb?.insertTab();
      if (!res?.ok) {
        setError(res?.error ?? '插入失败');
        return res ?? { ok: false };
      }
      return res;
    } catch (e) {
      const msg = e instanceof Error ? e.message : '未知错误';
      setError(msg);
      return { ok: false, error: msg };
    } finally {
      setInserting(false);
    }
  }, []);

  const reset = useCallback(() => {
    setError(null);
  }, []);

  return { insert, inserting, error, reset };
}