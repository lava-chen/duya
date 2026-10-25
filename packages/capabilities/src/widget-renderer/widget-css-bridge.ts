export const WIDGET_CSS_BRIDGE = /* css */ `
  /* --- Light Theme (default) --- */
  --color-background-primary: #ffffff;
  --color-background-secondary: rgba(0, 0, 0, 0.03);
  --color-text-primary: #1a1a1a;
  --color-text-secondary: #6b6b6b;
  --color-text-tertiary: #6b6b6b;
  --color-border-tertiary: rgba(0, 0, 0, 0.06);
  --accent: #7c3aed;
  --accent-soft: rgba(124, 58, 237, 0.2);
  --success: #22c55e;
  --success-soft: rgba(34, 197, 94, 0.2);
  --warning: #f59e0b;
  --warning-soft: rgba(245, 158, 11, 0.2);
  --error: #ef4444;
  --error-soft: rgba(239, 68, 68, 0.1);
  /* Mirrors the --font-sans / --font-mono tokens in globals.css. Kept as
     literals: the sandbox is a separate document and cannot resolve the
     main document's custom properties. */
  --font-sans: 'Styrene', ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "PingFang TC", "Hiragino Sans", "Microsoft YaHei", sans-serif;
  --font-mono: 'Fira Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  --border-radius-md: 8px;
  --border-radius-lg: 12px;
`;

export const WIDGET_THEME_DARK_CSS = /* css */ `
  :root[data-theme="dark"] {
    --color-background-primary: #1e1e1e;
    --color-background-secondary: rgba(255, 255, 255, 0.06);
    --color-text-primary: #ffffff;
    --color-text-secondary: #8a8a8a;
    --color-text-tertiary: #8a8a8a;
    --color-border-tertiary: rgba(255, 255, 255, 0.08);
    --accent: #a78bfa;
    --accent-soft: rgba(167, 139, 250, 0.24);
    --success: #22c55e;
    --success-soft: rgba(34, 197, 94, 0.2);
    --warning: #f59e0b;
    --warning-soft: rgba(245, 158, 11, 0.2);
    --error: #ef4444;
    --error-soft: rgba(239, 68, 68, 0.1);
  }
`;
