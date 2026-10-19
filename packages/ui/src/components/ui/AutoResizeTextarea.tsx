"use client";

/**
 * AutoResizeTextarea — a textarea whose height follows its content (edit the
 * text, the box grows with it) instead of showing a fixed-height scrollbox.
 * Height is clamped by `maxHeight` (px) so the box still caps out and scrolls
 * past that point, but never shows a scrollbar for short content.
 */

import { useCallback, useEffect, useRef } from "react";

export interface AutoResizeTextareaProps {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  /** Max height in px before a scrollbar appears (optional). */
  maxHeight?: number;
  minRows?: number;
  className?: string;
  style?: React.CSSProperties;
  ariaLabel?: string;
}

export function AutoResizeTextarea({
  value,
  onChange,
  onBlur,
  placeholder,
  maxHeight = 160,
  minRows = 1,
  className,
  style,
  ariaLabel,
}: AutoResizeTextareaProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const capped = Math.min(el.scrollHeight, maxHeight);
    el.style.height = `${capped}px`;
  }, [maxHeight]);

  useEffect(resize, [resize, value]);

  return (
    <textarea
      ref={ref}
      value={value}
      rows={Math.max(minRows, 1)}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      className={className}
      style={{ overflowY: "auto", ...style }}
    />
  );
}