/**
 * useOrbPointer — 轮询主进程拿到指针相对悬浮窗的位置。
 *
 * 渲染进程是 sandbox，拿不到全局光标，只能走 `automation:orb:pointer` IPC：
 * 主进程用 `screen.getCursorScreenPoint()` 读光标、用 `getBounds()` 读窗口，
 * 算好归一化坐标 + 绝对距离回传。轮询频率 40ms（25Hz）——眼神跟随要够丝滑，
 * 这个频率下每个动作都有 easeOutQuint 兜底，不会觉得卡顿。
 *
 * 返回 null 表示拿不到（窗口未创建 / 主进程不可用），此时上层按"人走远了"
 * 处理，进入自由情绪模式。
 */
import { useEffect, useRef, useState } from 'react';

import type { PointerSample } from '../bot/pointer-mood';

const POLL_MS = 40;

export function useOrbPointer(
  enabled: boolean,
  pollMs: number = POLL_MS,
): PointerSample | null {
  const [sample, setSample] = useState<PointerSample | null>(null);
  const alive = useRef(false);

  useEffect(() => {
    if (!enabled) {
      setSample(null);
      return;
    }
    alive.current = true;

    const poll = async () => {
      if (!alive.current) return;
      try {
        const res = await window.electronAPI?.orb?.pointer?.();
        if (alive.current) setSample(res ?? null);
      } catch {
        // 主进程不可用 / 窗口还没建 —— 保持上一次样本
      }
    };

    void poll();
    const timer = setInterval(() => {
      void poll();
    }, pollMs);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [enabled, pollMs]);

  return sample;
}
