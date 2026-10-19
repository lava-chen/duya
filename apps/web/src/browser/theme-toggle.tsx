import { useCallback, useEffect, useState, type ReactElement } from 'react';

/**
 * Light/dark/system switch.
 *
 * Deliberately NOT persisted: the rule of this client is that selection is the
 * only thing the URL remembers. The toggle lives in React state and follows
 * the OS while in `system` mode, so a refresh falls back to whatever the
 * device was already doing.
 */
type ThemeChoice = 'system' | 'light' | 'dark';

function applyTheme(choice: ThemeChoice): void {
  const resolved = choice === 'system'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    : choice;
  document.documentElement.dataset.theme = resolved;
}

export function ThemeToggle(): ReactElement {
  const [choice, setChoice] = useState<ThemeChoice>('system');

  useEffect(() => {
    applyTheme(choice);
  }, [choice]);

  useEffect(() => {
    if (choice !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (): void => applyTheme('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [choice]);

  const next = useCallback(() => {
    setChoice((current) => current === 'light' ? 'dark' : current === 'dark' ? 'system' : 'light');
  }, []);

  const label = choice === 'light' ? '浅色' : choice === 'dark' ? '深色' : '跟随系统';

  return (
    <button type="button" className="topbar__theme" onClick={next} aria-label="切换主题">
      <span>{label}</span>
    </button>
  );
}
