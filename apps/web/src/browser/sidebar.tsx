import { useCallback, type ReactElement } from 'react';
import type { SessionSummary } from '../client/api.js';
import type { Workspace } from '../client/workspace.js';
import { useWorkspaceState } from './use-workspace.js';
import { formatRecency } from './format.js';

export function Sidebar({ workspace }: { readonly workspace: Workspace }): ReactElement {
  const state = useWorkspaceState(workspace);

  return (
    <aside className="sidebar" aria-label="会话列表">
      <div className="sidebar__head">
        <span className="sidebar__label">会话</span>
        <span className="sidebar__count">{state.sessions.length.toString().padStart(2, '0')}</span>
        <button
          className="sidebar__refresh"
          type="button"
          aria-label="刷新会话列表"
          title="刷新会话列表"
          disabled={state.sessionsLoading || state.phase !== 'ready'}
          onClick={() => void workspace.refreshSessions()}
        >↻</button>
      </div>
      {state.sessionsError !== null && <p className="sidebar__notice">会话列表暂时无法更新：{state.sessionsError}</p>}
      <nav className="sidebar__list" aria-label="选择会话">
        {state.sessions.length === 0 && !state.sessionsLoading ? (
          <p className="sidebar__empty">这里还没有会话。会话会在桌面端创建后出现在这里。</p>
        ) : state.sessions.map((session) => (
          <SessionItem
            key={session.id}
            session={session}
            active={state.selectedSessionId === session.id}
            onSelect={() => void workspace.select(session.id)}
          />
        ))}
        {state.sessionsLoading && state.sessions.length === 0 && <p className="sidebar__empty">正在读取会话…</p>}
      </nav>
      <footer className="sidebar__footer">只连接此设备上的 Duya Host</footer>
    </aside>
  );
}

function SessionItem({ session, active, onSelect }: {
  readonly session: SessionSummary;
  readonly active: boolean;
  readonly onSelect: () => void;
}): ReactElement {
  const handleClick = useCallback(() => onSelect(), [onSelect]);
  return (
    <button
      type="button"
      className={`sidebar__item${active ? ' sidebar__item--active' : ''}`}
      onClick={handleClick}
      aria-current={active ? 'page' : undefined}
    >
      <span className="sidebar__title">{session.title === '' ? '新会话' : session.title}</span>
      <span className="sidebar__meta">
        <span><span className={`sidebar__dot${session.timelineCount === 0 ? ' sidebar__dot--idle' : ''}`} />{session.projectName || '本地项目'}</span>
        <span>{formatRecency(session.recencyAt)}</span>
      </span>
    </button>
  );
}
