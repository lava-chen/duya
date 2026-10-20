import { useEffect, useRef } from 'react';
import {
  isEditableTarget,
  matchesShortcut,
  type ShortcutEventLike,
  type ShortcutBinding,
} from '@/lib/keyboard';
import { scopedLogger } from '@/lib/logger';

const log = scopedLogger('shortcut');

export interface UseShortcutBindingOptions extends ShortcutBinding {
  enabled?: boolean;
  /**
   * 焦点在输入框内时是否仍然触发。
   * 带修饰键的全局快捷键（Cmd+K）默认 true；裸键（如 `/`）应设为 false，
   * 否则用户输入 `/` 时会误触发。
   */
  allowInEditable?: boolean;
  /** 事件目标是否落在给定容器内（用于把快捷键限定在某个面板）。 */
  scopeRef?: React.RefObject<HTMLElement | null>;
  preventDefault?: boolean;
}

/**
 * 声明式注册一个全局快捷键。
 *
 * handler 存在 ref 里，因此**不需要**把回调 memo 化——改动回调不会引起
 * 监听器的重复挂载/卸载，这在高频重渲染的面板里能省掉大量无意义的
 * add/removeEventListener 抖动。
 */
export function useShortcutBinding(
  handler: (event: KeyboardEvent) => void,
  options: UseShortcutBindingOptions,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const {
    key,
    mod,
    ctrl,
    meta,
    shift,
    alt,
    enabled = true,
    allowInEditable,
    scopeRef,
    preventDefault = true,
  } = options;

  useEffect(() => {
    if (!enabled) return;

    // 未显式配置时：带修饰键的视为全局快捷键，裸键视为输入框内不生效。
    const hasModifier = Boolean(mod || ctrl || meta || alt);
    const permitInEditable = allowInEditable ?? hasModifier;

    const onKeyDown = (event: KeyboardEvent) => {
      const eventLike: ShortcutEventLike = event;
      if (!matchesShortcut(eventLike, { key, mod, ctrl, meta, shift, alt })) return;
      if (!permitInEditable && isEditableTarget(event.target)) return;
      if (scopeRef && !scopeRef.current?.contains(event.target as Node)) return;

      if (preventDefault) event.preventDefault();
      try {
        handlerRef.current(event);
      } catch (error) {
        // 快捷键回调跑在事件最外层，抛错会中断该次事件派发链。
        log.error('shortcut handler failed', { key, error });
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [key, mod, ctrl, meta, shift, alt, enabled, allowInEditable, scopeRef, preventDefault]);
}
