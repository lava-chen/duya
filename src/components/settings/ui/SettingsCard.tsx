import * as React from "react";
import { cn } from "@/lib/utils";

export interface SettingsCardProps {
  children: React.ReactNode;
  className?: string;
  divided?: boolean;
  variant?: "default" | "highlight" | "danger" | "success";
}

export function SettingsCard({
  children,
  className,
  divided = true,
  variant = "default",
}: SettingsCardProps) {
  const childArray = React.Children.toArray(children).filter(Boolean);

  const variantStyles = {
    default: "bg-white/[0.025] border-border/30",
    highlight: "bg-accent/[0.04] border-accent/25",
    danger: "bg-destructive/[0.04] border-destructive/25",
    success: "bg-green-500/[0.04] border-green-500/25",
  };

  return (
    <div
      className={cn(
        "rounded-xl border overflow-hidden transition-all duration-200",
        variantStyles[variant],
        className
      )}
    >
      {divided && childArray.length > 1
        ? childArray.map((child, index) => (
            <React.Fragment key={index}>
              {index > 0 && <div className="h-px bg-border/20 mx-4" />}
              {child}
            </React.Fragment>
          ))
        : children}
    </div>
  );
}

export function SettingsCardFooter({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "px-4 py-3 border-t border-border/50 bg-muted/30 flex items-center justify-end gap-2",
        className
      )}
    >
      {children}
    </div>
  );
}
