import type { ReactElement } from 'react';
import type { RunStreamState } from '../client/run-stream.js';
import type { WorkspacePhase } from '../client/workspace.js';

export function ConnectionStatus({ phase, stream }: {
  readonly phase: WorkspacePhase;
  readonly stream: RunStreamState;
}): ReactElement {
  let className: string;
  let label: string;
  if (phase === 'starting') {
    className = 'starting';
    label = '正在连接';
  } else if (phase === 'unreachable') {
    className = 'error';
    label = 'Host 不可达';
  } else if (stream.phase === 'reconnecting') {
    className = 'reconnecting';
    label = '正在重连';
  } else if (stream.phase === 'connected') {
    className = 'connected';
    label = '已连接';
  } else if (stream.phase === 'connecting') {
    className = 'starting';
    label = '正在建立事件流';
  } else {
    className = 'stopped';
    label = '已就绪';
  }

  return <div className={`topbar__status topbar__status--${className}`} role="status" aria-live="polite"><span className="topbar__dot" />{label}{stream.phase === 'reconnecting' && <span> · 第 {stream.attempt} 次</span>}</div>;
}
