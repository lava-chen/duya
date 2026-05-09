import * as React from "react";
import { cn } from "@/lib/utils";

export interface SegmentedOption {
  value: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
}

export interface SettingsSegmentedProps {
  options: SegmentedOption[];
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}

export function SettingsSegmented({
  options,
  value,
  onValueChange,
  disabled,
  className,
}: SettingsSegmentedProps) {
  return (
    <div
      className={cn(
        "inline-flex bg-muted rounded-lg p-1 gap-1",
        disabled && "opacity-50 pointer-events-none",
        className
      )}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onValueChange(option.value)}
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-all duration-200",
            value === option.value
              ? "bg-accent text-white shadow-sm ring-1 ring-accent/50"
              : "text-muted-foreground hover:text-foreground hover:bg-surface"
          )}
        >
          {option.icon}
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  );
}
