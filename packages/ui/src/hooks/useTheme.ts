import { useState, useEffect } from 'react';

export type Theme = 'light' | 'dark';

/**
 * Read the theme the document is actually rendering with.
 *
 * `data-theme` on <html> is the source of truth at runtime: every
 * `[data-theme="dark"]` rule in the stylesheet keys off it, and the boot
 * script in index.html sets it synchronously before React mounts, so it
 * is always populated by the time this runs.
 *
 * localStorage `duya-theme` is deliberately NOT consulted. index.html
 * calls it a "boot-time hint" and says the source of truth is the
 * settings DB; the boot script is what turns that hint into `data-theme`.
 * Reading the hint directly would let the hook answer with a value the
 * CSS is not using.
 */
function readTheme(): Theme {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

/**
 * Track the document's theme.
 *
 * The initial value is read synchronously rather than in an effect. The
 * previous version seeded state with 'dark' and corrected it after the
 * first commit, so every consumer rendered one frame in the wrong theme —
 * visible as a flash for light-theme users across six call sites.
 */
export function useTheme(): { theme: Theme } {
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => {
    const root = document.documentElement;
    // Narrow to the attribute we care about; the previous observer was
    // configured for every attribute on <html>.
    const observer = new MutationObserver(() => {
      setTheme(readTheme());
    });
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  return { theme };
}
