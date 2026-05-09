import * as React from "react";
import { cn } from "@/lib/utils";
import { EyeIcon, EyeSlashIcon } from "@/components/icons";

export interface SettingsInputProps {
  label?: string;
  description?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: "text" | "password" | "email" | "url";
  disabled?: boolean;
  error?: string;
  action?: React.ReactNode;
  className?: string;
  onBlur?: () => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
}

export function SettingsInput({
  label,
  description,
  value,
  onChange,
  placeholder,
  type = "text",
  disabled,
  error,
  action,
  className,
  onBlur,
  onKeyDown,
}: SettingsInputProps) {
  const id = React.useId();
  const [showPassword, setShowPassword] = React.useState(false);
  const isPassword = type === "password";
  const inputType = isPassword && showPassword ? "text" : type;

  return (
    <div className={cn("px-4 py-3.5 space-y-2", className)}>
      {label && (
        <div>
          <label htmlFor={id} className="text-sm font-medium text-foreground block">
            {label}
          </label>
          {description && (
            <span className="text-sm text-muted-foreground">{description}</span>
          )}
        </div>
      )}
      <div className="flex gap-2">
        <div className={cn("relative flex-1", error && "ring-1 ring-destructive rounded-lg")}>
          <input
            id={id}
            type={inputType}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            disabled={disabled}
            onBlur={onBlur}
            onKeyDown={onKeyDown}
            className={cn(
              "w-full px-3 py-2 rounded-lg border text-sm bg-surface text-foreground",
              "focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent",
              "disabled:opacity-50 disabled:cursor-not-allowed",
              "border-border/50",
              isPassword && "pr-10"
            )}
          />
          {isPassword && (
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              tabIndex={-1}
            >
              {showPassword ? <EyeSlashIcon size={16} /> : <EyeIcon size={16} />}
            </button>
          )}
        </div>
        {action}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

export function SettingsInputRow({
  label,
  description,
  value,
  onChange,
  placeholder,
  type = "text",
  disabled,
  error,
  className,
  onBlur,
}: SettingsInputProps) {
  const id = React.useId();

  return (
    <div
      className={cn(
        "flex items-center justify-between px-4 py-3.5",
        disabled && "opacity-50",
        className
      )}
    >
      <div className="flex-1 min-w-0 pr-4">
        <label htmlFor={id} className="text-sm font-medium text-foreground block">
          {label}
        </label>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
        {error && <p className="text-sm text-destructive mt-1">{error}</p>}
      </div>
      <div className={cn("shrink-0", error && "ring-1 ring-destructive rounded-lg")}>
        <input
          id={id}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          onBlur={onBlur}
          className={cn(
            "w-[200px] px-3 py-1.5 rounded-lg border text-sm bg-surface text-foreground",
            "focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            "border-border/50"
          )}
        />
      </div>
    </div>
  );
}
