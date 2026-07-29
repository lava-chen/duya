import React, { useState, useId, forwardRef } from 'react';
import { EyeIcon, EyeSlashIcon } from '@/components/icons';
import { IconButton } from '@/components/ui/IconButton';
import { cn } from '@/lib/utils';

export type InputSize = 'sm' | 'md' | 'lg';
export type InputType = 'text' | 'password' | 'email' | 'url' | 'number' | 'search';

export interface InputProps
  extends Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    'size' | 'type' | 'prefix' | 'suffix'
  > {
  type?: InputType;
  size?: InputSize;
  /** True or an error message. When a string is provided the component
   *  renders the message below the input. */
  error?: boolean | string;
  /** Optional prefix node (icon, text, etc.). */
  prefix?: React.ReactNode;
  /** Optional suffix node (icon, action button, etc.). */
  suffix?: React.ReactNode;
}

const SIZE_CLASSES: Record<InputSize, string> = {
  sm: 'px-2.5 py-1.5 text-xs',
  md: 'px-3 py-2 text-sm',
  lg: 'px-4 py-2.5 text-base',
};

const AFFIX_SIZE_CLASSES: Record<InputSize, string> = {
  sm: 'h-7',
  md: 'h-9',
  lg: 'h-11',
};

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={className}
    >
      <circle cx="11" cy="11" r="6" />
      <path d="m16 16 4 4" />
    </svg>
  );
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    type = 'text',
    size = 'md',
    error,
    prefix,
    suffix,
    disabled,
    className,
    id: providedId,
    ...rest
  },
  ref,
) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const [showPassword, setShowPassword] = useState(false);

  const isPassword = type === 'password';
  const isSearch = type === 'search';
  const inputType = isPassword && showPassword ? 'text' : type;
  const errorMessage = typeof error === 'string' ? error : undefined;
  const hasError = !!error;

  // Default search prefix when none is explicitly provided.
  const effectivePrefix = prefix ?? (isSearch ? <SearchIcon className="w-4 h-4" /> : undefined);

  // Default password visibility suffix when none is explicitly provided.
  const effectiveSuffix =
    suffix ??
    (isPassword ? (
      <IconButton
        type="button"
        variant="ghost"
        size="sm"
        aria-label={showPassword ? 'Hide password' : 'Show password'}
        title={showPassword ? 'Hide password' : 'Show password'}
        onClick={() => setShowPassword((prev) => !prev)}
        tabIndex={-1}
        disabled={disabled}
      >
        {showPassword ? <EyeSlashIcon size={16} /> : <EyeIcon size={16} />}
      </IconButton>
    ) : undefined);

  const hasAffix = !!effectivePrefix || !!effectiveSuffix;

  const inputClasses = cn(
    'w-full rounded-lg border text-sm bg-chip text-foreground placeholder:text-muted-foreground',
    'focus:outline-none focus:ring-2 focus:ring-accent/50',
    'disabled:opacity-50 disabled:cursor-not-allowed',
    'border-border/50',
    SIZE_CLASSES[size],
    hasError && 'border-error/50 focus:ring-error/30',
    effectivePrefix && 'pl-0 border-l-0 rounded-l-none',
    effectiveSuffix && 'pr-0 border-r-0 rounded-r-none',
    !hasAffix && 'focus:border-accent/60',
    className,
  );

  const input = (
    <input
      ref={ref}
      id={id}
      type={inputType}
      disabled={disabled}
      className={inputClasses}
      {...rest}
    />
  );

  if (!hasAffix) {
    return (
      <div className="w-full">
        {input}
        {errorMessage && <p className="text-sm text-destructive mt-1">{errorMessage}</p>}
      </div>
    );
  }

  return (
    <div className="w-full">
      <div
        className={cn(
          'flex items-center w-full rounded-lg border border-border/50 bg-chip overflow-hidden',
          'focus-within:ring-2 focus-within:ring-accent/50 focus-within:border-accent/60',
          hasError && 'border-error/50 focus-within:ring-error/30',
          disabled && 'opacity-50 cursor-not-allowed',
          AFFIX_SIZE_CLASSES[size],
        )}
      >
        {effectivePrefix && (
          <span className="inline-flex items-center justify-center px-3 text-muted-foreground shrink-0 h-full">
            {effectivePrefix}
          </span>
        )}
        {input}
        {effectiveSuffix && (
          <span className="inline-flex items-center justify-center px-2 shrink-0 h-full">
            {effectiveSuffix}
          </span>
        )}
      </div>
      {errorMessage && <p className="text-sm text-destructive mt-1">{errorMessage}</p>}
    </div>
  );
});
