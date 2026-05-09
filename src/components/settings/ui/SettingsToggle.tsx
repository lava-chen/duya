import * as React from "react";
import { cn } from "@/lib/utils";

export interface SettingsToggleProps {
  label: React.ReactNode;
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}

export function SettingsToggle({
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
  className,
}: SettingsToggleProps) {
  const id = React.useId();

  return (
    <div
      className={cn(
        "flex items-center justify-between px-4 py-3.5",
        disabled && "opacity-50",
        className
      )}
    >
      <label htmlFor={id} className="flex-1 min-w-0 cursor-pointer select-none pr-4">
        <div className="text-sm font-medium text-foreground">{label}</div>
        {description && (
          <div className="text-sm text-muted-foreground mt-0">{description}</div>
        )}
      </label>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        id={id}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
        className={cn(
          "relative w-11 h-6 rounded-full transition-colors shrink-0",
          checked ? "bg-accent" : "bg-muted",
          disabled && "cursor-not-allowed"
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-transform",
            checked ? "translate-x-5" : "translate-x-0"
          )}
        />
      </button>
    </div>
  );
}
