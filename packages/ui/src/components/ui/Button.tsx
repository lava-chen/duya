import React, { forwardRef } from 'react';

/**
 * Unified text-bearing button.
 *
 * Variant hierarchy (see docs/exec-plans/active/309-button-unification.md):
 *   primary   — form submit, confirm, execute
 *   secondary — cancel, close, secondary option
 *   accent    — toolbar highlight action (e.g. "Open" dropdown in preview
 *               header). Accent-colored border + soft fill so it reads as
 *               the primary toolbar action without the weight of `primary`.
 *   ghost     — link-style action, low-emphasis
 *   danger    — delete, disable, reset, disconnect
 *
 * Sizes are orthogonal to variant:
 *   sm — dense toolbar / chips (px-3 py-1.5 text-xs)
 *   md — default, dialogs (px-4 py-2 text-sm)
 *   lg — onboarding / hero (px-6 py-2.5 text-base)
 *
 * For icon-only buttons use <IconButton /> from IconButton.tsx — it enforces
 * aria-label and has a shape (square/round) dimension this component does not.
 *
 * For icon + text actions with a trailing caret (dropdowns), compose them
 * inline inside children: `Button` already sets `items-center gap-2`.
 *
 * Only Tailwind classes that actually generate are used. `@theme` in
 * globals.css declares accent/foreground/muted-foreground/border/warning/error
 * only — `bg-surface` / `bg-chip` / `bg-destructive` are no-ops, so surface
 * backgrounds use the arbitrary-value form `bg-[var(--surface)]`.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'accent' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const BASE_CLASS =
  'inline-flex items-center justify-center gap-2 font-medium rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40';

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5 text-xs',
  md: 'px-4 py-2 text-sm',
  lg: 'px-6 py-2.5 text-base',
};

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-white hover:bg-accent/90',
  secondary:
    'border border-border bg-[var(--surface)] text-foreground hover:bg-[var(--surface-hover)]',
  accent:
    'border border-accent bg-accent/10 text-accent hover:bg-accent hover:text-white',
  ghost:
    'text-muted-foreground hover:text-foreground hover:bg-[var(--surface-hover)]',
  danger:
    'border border-error/30 bg-error/10 text-error hover:bg-error/20',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    className,
    children,
    type = 'button',
    ...rest
  },
  ref,
) {
  const classes = [
    BASE_CLASS,
    SIZE_CLASSES[size],
    VARIANT_CLASSES[variant],
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button ref={ref} type={type} className={classes} {...rest}>
      {children}
    </button>
  );
});
