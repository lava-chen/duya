import { createContext, useContext, type ReactNode } from 'react';
import type { PartialWorkspaceLifecyclePort } from '@/services/workspace-lifecycle';

/**
 * The React-context form of the workspace-lifecycle port.
 *
 * The context holds `null` when the surface installed no adapter. That is NOT
 * an error: a surface without the checkout namespace still renders the
 * panel, and the panel says the surface cannot answer. The distinction
 * matters — "this surface cannot observe checkouts" and "this session has no
 * checkout" are different facts, and folding them into one is how a user ends
 * up acting on a missing observation.
 */
const WorkspaceLifecycleContext = createContext<PartialWorkspaceLifecyclePort | null>(null);

export function WorkspaceLifecycleProvider({
  port,
  children,
}: {
  readonly port: PartialWorkspaceLifecyclePort | null;
  readonly children: ReactNode;
}) {
  return <WorkspaceLifecycleContext.Provider value={port}>{children}</WorkspaceLifecycleContext.Provider>;
}

/**
 * The installed port, or null when the surface has none.
 *
 * A caller must handle null. It is the "cannot answer" state, and a panel
 * that renders it is honest.
 */
export function useWorkspaceLifecycle(): PartialWorkspaceLifecyclePort | null {
  return useContext(WorkspaceLifecycleContext);
}
