/**
 * section-system.ts — pure data helpers for the sidebar's built-in system
 * sections. Sections (system or user) are the unified abstract the sidebar
 * iterates over; this module only describes the *built-in* ones. User
 * sections live in `SidebarSectionsStore`.
 *
 * A system section's content is derived from the session kind. Sessions
 * continue to live in a single flat `threads[]` array; the kind is
 * detected from the id prefix (`cron:`, `gw-`, `wakeless-`) and a few
 * special flags (pinned, project group). Keeping the detection logic
 * here (rather than in `app-sidebar.tsx`) means every consumer reads
 * the same rule, and adding a new kind is a one-file change.
 */

import type { Thread } from '@/stores/conversation-store';

export type SystemSectionKind = 'project' | 'cron' | 'gateway' | 'wakeup' | 'pinned';

export interface SystemSectionDescriptor {
  /** Reserved id for system sections. Always starts with `__system__:`. */
  id: string;
  kind: SystemSectionKind;
  /** Display label. Use `t('sidebar.section.<kind>')` to resolve. */
  labelKey: string;
  /** Whether the user can collapse this section (independent of user data). */
  collapsible: boolean;
  /**
   * Whether this section is rendered with a "system" badge. System sections
   * cannot be renamed or deleted — they group sessions by kind, not by user
   * intent.
   */
  builtin: true;
}

export const SYSTEM_SECTIONS: SystemSectionDescriptor[] = [
  {
    id: '__system__:project',
    kind: 'project',
    labelKey: 'sidebar.section.project',
    collapsible: true,
    builtin: true,
  },
  {
    id: '__system__:cron',
    kind: 'cron',
    labelKey: 'sidebar.section.cron',
    collapsible: true,
    builtin: true,
  },
  {
    id: '__system__:gateway',
    kind: 'gateway',
    labelKey: 'sidebar.section.gateway',
    collapsible: true,
    builtin: true,
  },
  {
    id: '__system__:wakeup',
    kind: 'cron',
    labelKey: 'sidebar.section.wakeup',
    collapsible: true,
    builtin: true,
  },
  {
    id: '__system__:pinned',
    kind: 'pinned',
    labelKey: 'sidebar.section.pinned',
    collapsible: true,
    builtin: true,
  },
];

/** ID prefix used for every session kind. Treated as opaque tokens. */
export const SESSION_KIND_PREFIXES = {
  cron: 'cron:',
  gateway: 'gw-',
  wakeup: 'wakeless-',
} as const;

/**
 * Detect the system section a thread belongs to. The first matching rule
 * wins. Sub-agents (parentId set) are excluded — they are internal
 * bookkeeping and should never be shown in the sidebar.
 *
 * Returns null when the thread is a normal main-agent session that should
 * be grouped under the "project" section, but routed by workingDirectory
 * (the caller handles the grouping, not this function).
 */
export function detectThreadKind(thread: Thread): SystemSectionKind | null {
  if (thread.agentType === 'sub-agent' || thread.parentId) return null;
  if (thread.pinned === 1) return 'pinned';
  if (thread.id.startsWith(SESSION_KIND_PREFIXES.cron)) return 'cron';
  if (thread.id.startsWith(SESSION_KIND_PREFIXES.gateway)) return 'gateway';
  if (thread.id.startsWith(SESSION_KIND_PREFIXES.wakeup)) return 'wakeup';
  // Main-agent threads: caller must group by workingDirectory.
  return null;
}

/**
 * Convenience: bucket a flat thread list by system section. Threads that
 * match a kind bucket go to that bucket; the rest land under
 * `'project_ungrouped'` so the caller can further group them by
 * workingDirectory.
 */
export function bucketThreadsByKind(threads: Thread[]): {
  cron: Thread[];
  gateway: Thread[];
  wakeup: Thread[];
  pinned: Thread[];
  project_ungrouped: Thread[];
} {
  const cron: Thread[] = [];
  const gateway: Thread[] = [];
  const wakeup: Thread[] = [];
  const pinned: Thread[] = [];
  const project_ungrouped: Thread[] = [];

  for (const thread of threads) {
    const kind = detectThreadKind(thread);
    if (kind === 'cron') cron.push(thread);
    else if (kind === 'gateway') gateway.push(thread);
    else if (kind === 'wakeup') wakeup.push(thread);
    else if (kind === 'pinned') pinned.push(thread);
    else project_ungrouped.push(thread);
  }

  return { cron, gateway, wakeup, pinned, project_ungrouped };
}

/** Lookup a system section descriptor by id. Returns undefined if not a
 *  built-in kind. */
export function getSystemSection(id: string): SystemSectionDescriptor | undefined {
  return SYSTEM_SECTIONS.find((s) => s.id === id);
}
