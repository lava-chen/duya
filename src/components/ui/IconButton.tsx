import React from 'react';

/**
 * Unified icon-only button. Requires `aria-label` for accessibility.
 *
 * Variants:
 *   default — toolbar / close / refresh / menu
 *   primary — send, confirm-as-icon
 *   danger  — stop, remove, delete-icon
 *   ghost   — low-emphasis icon, no hover background
 *
 * Shapes:
 *   square (default) — rounded-lg, for toolbar/grid icons
 *   round            — rounded-full, for floating actions (send, stop)
 *
 * Sizes are pixel-based (icon containers are square regardless of shape):
 *   sm — 24px (icon 14px)
 *   md — 28px square / 32px round (icon 16px)
 *   lg — 32px square / 40px round (icon 18px)
 *
 * See docs/exec-plans/active/309-button-unification.md for the full hierarchy.
 */
export type IconButtonVariant = 'default' | 'primary' | 'danger' | 'ghost';
export type IconButtonSize = 'sm' | 'md' | 'lg';
export type IconButtonShape = 'square' | 'round';

export interface IconButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  shape?: IconButtonShape;
  /** Required for screen readers — icon-only buttons must have a text label. */
  'aria-label': string;
}

const BASE_CLASS =
  'inline-flex items-center justify-center transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40';

const SHAPE_CLASS: Record<IconButtonShape, string> = {
  square: 'rounded-lg',
  round: 'rounded-full',
};

// Square and round have different size scales — round buttons are slightly
// larger to feel like floating action buttons (matches MessageInput Send/Stop).
const SIZE_CLASS: Record<IconButtonShape, Record<IconButtonSize, string>> = {
  square: {
    sm: 'w-6 h-6',
    md: 'w-7 h-7',
    lg: 'w-8 h-8',
  },
  round: {
    sm: 'w-6 h-6',
    md: 'w-8 h-8',
    lg: 'w-10 h-10',
  },
};

const VARIANT_CLASS: Record<IconButtonVariant, string> = {
  default:
    'text-muted-foreground hover:text-foreground hover:bg-[var(--surface-hover)]',
  primary: 'bg-accent text-white hover:bg-accent/90',
  danger: 'text-error hover:bg-error/10',
  ghost: 'text-muted-foreground hover:text-foreground',
};

export function IconButton({
  variant = 'default',
  size = 'md',
  shape = 'square',
  className,
  type = 'button',
  'aria-label': ariaLabel,
  ...rest
}: IconButtonProps) {
  const classes = [
    BASE_CLASS,
    SHAPE_CLASS[shape],
    SIZE_CLASS[shape][size],
    VARIANT_CLASS[variant],
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type={type}
      aria-label={ariaLabel}
      className={classes}
      {...rest}
    />
  );
}
