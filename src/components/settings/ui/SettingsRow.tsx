import * as React from "react";
import { cn } from "@/lib/utils";

export interface SettingsRowProps {
  label: React.ReactNode;
  description?: string;
  children?: React.ReactNode;
  onClick?: () => void;
  action?: React.ReactNode;
  className?: string;
  disabled?: boolean;
}

export function SettingsRow({
  label,
  description,
  children,
  onClick,
  action,
  className,
  disabled,
}: SettingsRowProps) {
  const Component = onClick ? "button" : "div";

  return (
    <Component
      type={onClick ? "button" : undefined}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "w-full flex items-center justify-between text-left",
        "px-4 py-3.5",
        onClick && "hover:bg-muted/50 transition-colors cursor-pointer",
        disabled && "opacity-50 pointer-events-none",
        className
      )}
    >
      <div className="flex-1 min-w-0 pr-4">
        <div className="text-sm font-medium text-foreground">{label}</div>
        {description && (
          <div className="text-sm text-muted-foreground mt-0">{description}</div>
        )}
      </div>
      {(children || action) && (
        <div className="flex items-center gap-3 ml-4 shrink-0">
          {children}
          {action}
        </div>
      )}
    </Component>
  );
}
