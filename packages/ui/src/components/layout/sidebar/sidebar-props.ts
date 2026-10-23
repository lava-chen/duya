/**
 * The sidebar's prop contract and memo comparator.
 *
 * Kept in its own module (rather than inside `app-sidebar.tsx`) so the
 * contract can be unit-tested without pulling the whole renderer dependency
 * graph into the test process.
 *
 * WHY THE COMPARATOR EXISTS
 *
 * The shell (`app-shell.tsx`) subscribes to the whole conversation store, so
 * it re-renders on every store write — and the composer persists the
 * new-chat draft on every keystroke. The shell also rebuilds `style` and
 * `onExpand` inline, so comparing those props by identity would re-render
 * the entire sidebar tree (project groups, bot rows, session rows) on every
 * keystroke. They are compared by value instead.
 *
 * `onExpand` IS compared by identity: `app-sidebar.tsx` hands the inner
 * tree a stable callback (the volatile closure from the shell is kept in a
 * ref), so identity churn never reaches this comparator in the first place.
 */
import type { CSSProperties } from "react";
import type { UiServices } from "@/services/ui-services";

export interface AppSidebarProps {
  isSettingsPage?: boolean;
  style?: CSSProperties;
  /** Collapsed to the icon-only rail (title-bar toggle). */
  collapsed?: boolean;
  /** Expand back to the full sidebar (rail items call it before acting). */
  onExpand?: () => void;
  capabilities?: UiServices["capabilities"];
}

/** Shallow compare of the sidebar width style the shell passes down. */
function sameSidebarStyle(
  a: CSSProperties | undefined,
  b: CSSProperties | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  const aRecord = a as unknown as Record<string, unknown>;
  const bRecord = b as unknown as Record<string, unknown>;
  return aKeys.every((key) => aRecord[key] === bRecord[key]);
}

/** Shallow compare of the platform capability flags. */
function sameSidebarCapabilities(
  a: UiServices["capabilities"] | undefined,
  b: UiServices["capabilities"] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.localFileAccess === b.localFileAccess &&
    a.settings === b.settings &&
    a.extensions === b.extensions &&
    a.bots === b.bots &&
    a.automation === b.automation &&
    a.workflows === b.workflows &&
    a.turnConfiguration === b.turnConfiguration
  );
}

/**
 * Memo comparator for the sidebar tree.
 *
 * Every prop that can change what the sidebar shows compares UNEQUAL; the
 * two props the shell rebuilds on every render (`style` and the capability
 * object) compare by VALUE, so the shell's churn does not reach the tree.
 */
export function areSidebarPropsEqual(
  prev: AppSidebarProps,
  next: AppSidebarProps,
): boolean {
  if (prev.isSettingsPage !== next.isSettingsPage) return false;
  if (prev.collapsed !== next.collapsed) return false;
  if (prev.onExpand !== next.onExpand) return false;
  if (!sameSidebarCapabilities(prev.capabilities, next.capabilities)) return false;
  if (!sameSidebarStyle(prev.style, next.style)) return false;
  return true;
}
