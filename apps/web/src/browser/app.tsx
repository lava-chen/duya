import { createContext, useContext, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Workspace } from '../client/workspace.js';
import { BrandMark } from './brand.js';
import { Composer } from './composer.js';
import { ConnectionStatus } from './connection-status.js';
import { Conversation } from './conversation.js';
import { Sidebar } from './sidebar.js';
import { ThemeToggle } from './theme-toggle.js';
import { useWorkspaceState } from './use-workspace.js';

const WorkspaceContext = createContext<Workspace | null>(null);

function useActiveWorkspace(): Workspace {
  const value = useContext(WorkspaceContext);
  if (value === null) throw new Error('Workspace provider is missing');
  return value;
}

const SELECTION_QUERY_KEY = 'session';

export interface AppProps {
  readonly workspace: Workspace;
  readonly children?: ReactNode;
}

export function App({ workspace, children }: AppProps): ReactElement {
  return (
    <WorkspaceContext.Provider value={workspace}>
      <Shell>{children}</Shell>
    </WorkspaceContext.Provider>
  );
}

function Shell({ children }: { readonly children?: ReactNode }): ReactElement {
  const workspace = useActiveWorkspace();

  useEffect(() => {
    void workspace.start();
    return () => {
      workspace.stop();
    };
  }, [workspace]);

  return (
    <div className="shell">
      <TopBar />
      <Sidebar workspace={workspace} />
      <Conversation workspace={workspace} />
      <Composer workspace={workspace} />
      <SelectionSync workspace={workspace} />
      {children}
    </div>
  );
}

function TopBar(): ReactElement {
  const workspace = useActiveWorkspace();
  const state = useWorkspaceState(workspace);
  return (
    <header className="topbar">
      <div className="topbar__brand">
        <BrandMark />
        <span className="topbar__title">独雅</span>
        <span className="topbar__sub">本机工作台</span>
      </div>
      <span className="topbar__spacer" />
      <ConnectionStatus
        phase={state.phase}
        stream={state.stream}
      />
      <ThemeToggle />
    </header>
  );
}

/**
 * Wire the selected session id in the URL to the workspace, and back.
 *
 *  - On mount, read `?session=…` and ask the workspace to select it. URL
 *    fragments and unrelated query parameters are left alone.
 *  - When the selection changes in state, write it back to the URL with
 *    `replaceState`, so a refresh after a click lands on the same session
 *    without pushing a history entry on every click.
 */
function SelectionSync({ workspace }: { readonly workspace: Workspace }): ReactElement {
  const state = useWorkspaceState(workspace);
  const bootstrapped = useRef(false);
  const [synced, setSynced] = useState(false);

  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    const params = new URLSearchParams(window.location.search);
    const initial = params.get(SELECTION_QUERY_KEY);
    if (initial !== null) {
      void workspace.select(initial);
    }
    setSynced(true);
  }, [workspace]);

  useEffect(() => {
    const onPopState = (): void => {
      const params = new URLSearchParams(window.location.search);
      void workspace.select(params.get(SELECTION_QUERY_KEY));
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [workspace]);

  useEffect(() => {
    if (!synced) return;
    const url = new URL(window.location.href);
    const current = url.searchParams.get(SELECTION_QUERY_KEY);
    const next = state.selectedSessionId;
    if (next === current) return;
    if (next === null) {
      url.searchParams.delete(SELECTION_QUERY_KEY);
    } else {
      url.searchParams.set(SELECTION_QUERY_KEY, next);
    }
    window.history.replaceState(null, '', url);
  }, [state.selectedSessionId, synced]);

  return <></>;
}
