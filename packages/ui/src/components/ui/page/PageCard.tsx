import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export interface PageCardProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * padding preset — "none" for table/list shells (rows supply their
   * own padding), "sm"/"md"/"lg" for content cards.
   */
  padding?: "none" | "sm" | "md" | "lg";
  /** Subtle background/border lift on hover (clickable cards/rows). */
  hoverable?: boolean;
}

/**
 * Unified card surface for main-window views. Border radius, border
 * colour and background come from shared tokens, so cards look and
 * behave identically across canvas / automation / gateway / extensions.
 */
export function PageCard({
  padding = "md",
  hoverable = false,
  className,
  children,
  ...rest
}: PageCardProps) {
  return (
    <div
      className={cn(
        "page-card",
        padding === "sm" && "page-card-pad-sm",
        padding === "md" && "page-card-pad-md",
        padding === "lg" && "page-card-pad-lg",
        hoverable && "page-card-hover",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
