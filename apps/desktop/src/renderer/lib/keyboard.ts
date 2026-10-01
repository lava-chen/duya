/**
 * keyboard — 键盘事件的噪声过滤与快捷键匹配内核（纯函数，可单测）。
 *
 * 中文/日文输入法下按 Enter 选词时，浏览器会先派发一个 `keydown`，
 * 其 `key` 是 `'Process'`（Windows）或 `'Dead'`（macOS），`keyCode` 是 229，
 * 且 `isComposing` 为 true。如果不做过滤，"回车发送"会在用户选词的瞬间
 * 把半成品拼音发出去——这是 duya 这类含输入框的桌面应用最典型的中文 bug。
 *
 * 另一个噪声源是 `repeat`：长按方向键/Enter 时浏览器持续派发，
 * 未过滤会让"发送"或"切换"连发 N 次。
 *
 * duya 里有 23 处 `keydown` 监听，此前各自为政（只有 Composer 检查了
 * `isComposing`）。这里把判据收敛成一个内核，供所有监听点共用。
 */

/** 只取判据需要的字段，便于用普通对象单测（不必构造真实 KeyboardEvent）。 */
export interface ShortcutEventLike {
  key: string;
  keyCode?: number;
  repeat?: boolean;
  /** React 合成事件上是 `nativeEvent.isComposing`。 */
  isComposing?: boolean;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/**
 * 输入法合成态：候选框打开时的按键必须被忽略。
 * `keyCode === 229` 是老式 IME 的兜底（部分 Windows 输入法不置 isComposing）。
 */
export function isImeEvent(event: ShortcutEventLike): boolean {
  return (
    event.isComposing === true ||
    event.key === 'Process' ||
    event.key === 'Dead' ||
    event.keyCode === 229
  );
}

/** 应当被快捷键层忽略的事件：IME 合成中，或长按自动重复。 */
export function isShortcutEventNoise(event: ShortcutEventLike): boolean {
  return event.repeat === true || isImeEvent(event);
}

export type ModifierName = 'mod' | 'ctrl' | 'meta' | 'shift' | 'alt';

export interface ShortcutBinding {
  key: string;
  mod?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
}

/** macOS 用 ⌘，其它平台用 Ctrl。 */
function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent);
}

/**
 * 快捷键匹配。`key` 比较大小写不敏感（Shift+K 与 k 均匹配 'k'）。
 *
 * 未声明的修饰键默认为"必须未按下"，避免 `mod+K` 误命中 `mod+shift+K`。
 */
export function matchesShortcut(
  event: ShortcutEventLike,
  binding: ShortcutBinding,
): boolean {
  if (isShortcutEventNoise(event)) return false;

  const eventKey = event.key.toLowerCase();
  if (eventKey !== binding.key.toLowerCase()) return false;

  const apple = isApplePlatform();
  const modPressed = apple ? event.metaKey === true : event.ctrlKey === true;

  if ((binding.mod ?? false) !== modPressed) return false;

  // `mod` 是平台别名（Apple = ⌘，其它平台 = Ctrl）：声明了 mod 之后，该平台
  // 对应的那个修饰键已经由上一行负责，不能在下面再按"未声明即必须未按下"
  // 校验一遍——否则 `{ key: 'k', mod: true }` 在 Windows/Linux 上会因为
  // "按了 Ctrl 但没声明 ctrl" 而被判为不匹配，即所有 mod 快捷键全部失效。
  if (apple) {
    if ((binding.ctrl ?? false) !== (event.ctrlKey === true)) return false;
  } else if ((binding.meta ?? false) !== (event.metaKey === true)) {
    return false;
  }

  if ((binding.shift ?? false) !== (event.shiftKey === true)) return false;
  if ((binding.alt ?? false) !== (event.altKey === true)) return false;

  return true;
}

/**
 * 事件是否来自可编辑元素。全局快捷键（如 Cmd+K 打开搜索）通常仍要生效，
 * 但单键快捷键（如 `/` 聚焦搜索）必须让位给输入框——输入框里的 `/`
 * 是用户正在输入的字符，不是命令。
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).tagName !== 'string') return false;
  const el = target as HTMLElement;
  const tag = el.tagName.toLowerCase();
  return (
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select' ||
    el.isContentEditable === true
  );
}
