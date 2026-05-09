import * as React from "react";
import { cn } from "@/lib/utils";

export interface SettingsSectionProps {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  variant?: "default" | "danger";
  action?: React.ReactNode;
  icon?: React.ReactNode;
}

export function SettingsSection({
  title,
  description,
  children,
  className,
  variant = "default",
  action,
  icon,
}: SettingsSectionProps) {
  return (
    <section className={cn("mb-8", className)}>
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="flex items-center gap-2.5">
          {icon && (
            <div className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center text-accent">
              {icon}
            </div>
          )}
          <div>
            <h3
              className={cn(
                "text-[1.15rem] font-bold tracking-tight",
                variant === "danger" && "text-destructive"
              )}
              style={{ fontFamily: "'Copernicus', Georgia, 'Times New Roman', serif" }}
            >
              {title}
            </h3>
            {description && (
              <p className="text-sm text-muted-foreground mt-0.5">{description}</p>
            )}
          </div>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  );
}
