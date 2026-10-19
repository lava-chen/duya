/**
 * The bridge between the framework-agnostic `Workspace` store and React.
 *
 * One `useSyncExternalStore` per snapshot is what keeps the render path
 * predictable: the store owns publication, the component subscribes, and the
 * snapshot reference only changes when state actually changes. There is no
 * reducer here, no `useEffect` for selection, and no in-component state that
 * could disagree with the store.
 */

import { useSyncExternalStore } from 'react';
import { Workspace, type WorkspaceState } from '../client/workspace.js';

export function useWorkspaceState(workspace: Workspace): WorkspaceState {
  return useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
}
