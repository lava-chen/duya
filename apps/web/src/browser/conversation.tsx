import { useEffect, useMemo, useRef, type ReactElement } from 'react';
import type { HostPermissionRequest } from '@duya/agent-protocol';
import type { ToolCallSurface } from '@duya/client-core';
import { projectConversation, type ConversationRow } from '../client/conversation.js';
import type { PermissionDecision } from '../client/api.js';
import type { Workspace } from '../client/workspace.js';
import { useWorkspaceState } from './use-workspace.js';
import { formatClock, formatDuration, formatRunStatus, formatToolPhase } from './format.js';

export function Conversation({ workspace }: { readonly workspace: Workspace }): ReactElement {
  const state = useWorkspaceState(workspace);
  const conversationRef = useRef<HTMLElement>(null);
  const rows = useMemo(() => projectConversation({
    messages: state.messages,
    compactions: state.compactions,
    snapshot: state.snapshot,
  }), [state.messages, state.compactions, state.snapshot]);

  useEffect(() => {
    const element = conversationRef.current;
    if (element !== null && element.scrollHeight - element.scrollTop - element.clientHeight < 160) {
      element.scrollTop = element.scrollHeight;
    }
  }, [rows]);

  if (state.phase === 'starting') {
    return <StatePage title="正在连接本机工作台" detail="正在读取 Host 状态与会话列表。" />;
  }
  if (state.phase === 'unreachable') {
    return (
      <main className="main">
        <div className="conversation__error" role="alert">
          <h2 className="conversation__error-title">暂时无法连接</h2>
          <p className="conversation__hint">{state.startupError ?? '本机 Host 暂时没有响应。'}</p>
          <button className="conversation__retry" type="button" onClick={() => void workspace.start()}>重新连接</button>
        </div>
      </main>
    );
  }
  if (state.selectedSessionId === null) {
    return <StatePage title="从一个会话开始" detail="选择左侧会话，查看历史对话并继续工作。" />;
  }
  if (state.selectionLoading) {
    return <StatePage title="正在打开会话" detail="正在恢复对话记录与运行状态。" />;
  }
  if (state.selectionError !== null) {
    return (
      <main className="main">
        <div className="conversation__error" role="alert">
          <h2 className="conversation__error-title">会话读取失败</h2>
          <p className="conversation__hint">{state.selectionError}</p>
          <button className="conversation__retry" type="button" onClick={() => void workspace.retrySelection()}>重新读取</button>
        </div>
      </main>
    );
  }

  const run = state.durableRun;
  const runClass = run === null ? '' : run.status === 'budget_exhausted' ? 'budget' : run.status;
  const statusLabel = run === null ? '' : formatRunStatus(run.status, state.cancelRequested);
  return (
    <main className="main">
      <header className="conversation-head">
        <h1 className="conversation-head__title">{state.selectedSession?.title || '新会话'}</h1>
        <div className="conversation-head__meta">
          {state.selectedSession?.projectName && <span>{state.selectedSession.projectName}</span>}
          {state.selectedSession?.model && <span>{state.selectedSession.model}</span>}
        </div>
        {run !== null && <span className={`conversation-head__pill conversation-head__pill--${state.cancelRequested ? 'requested' : runClass}`}>{statusLabel}</span>}
        {state.cancelRequested && <span className="conversation-head__pill conversation-head__pill--requested">等待取消确认</span>}
      </header>
      <section className="conversation" ref={conversationRef} aria-label="对话内容" aria-live="polite">
        {rows.length === 0 && state.approvals.length === 0 && <StatePage title="这段对话还没有消息" detail="在下方输入内容，开始这一轮对话。" />}
        {state.approvals.map((request) => (
          <ApprovalCard
            key={request.id}
            request={request}
            busy={state.resolvingApprovalId === request.id}
            onResolve={(decision) => void workspace.resolveApproval(request.id, decision)}
          />
        ))}
        {state.approvalError !== null && <p className="conversation__hint conversation__hint--error">权限状态读取或处理失败：{state.approvalError}</p>}
        <ol className="conversation__list" aria-label="对话记录">{rows.map((row) => <Row key={row.key} row={row} />)}</ol>
        {state.stream.phase === 'reconnecting' && <div className="stream-note" role="status">连接已中断，正在从已接收位置恢复…（第 {state.stream.attempt} 次）</div>}
        {state.cancelError !== null && <p className="conversation__hint conversation__hint--error">取消请求未确认：{state.cancelError}</p>}
      </section>
    </main>
  );
}

function StatePage({ title, detail }: { readonly title: string; readonly detail: string }): ReactElement {
  return <main className="main"><section className="conversation"><div className="conversation__empty"><h2 className="conversation__empty-title">{title}</h2><p className="conversation__hint">{detail}</p></div></section></main>;
}

function Row({ row }: { readonly row: ConversationRow }): ReactElement {
  if (row.kind === 'compaction') {
    return <li className="compaction"><span>上下文整理 · {row.tokensBefore.toLocaleString('zh-CN')} → {row.tokensAfter?.toLocaleString('zh-CN') ?? '处理中'}</span></li>;
  }
  if (row.kind === 'tool') return <li className="row row--tool"><ToolCard tool={row.tool} /></li>;
  if (row.kind === 'user') {
    return <li className="row row--user"><div className="row__avatar" aria-hidden="true">我</div><div className="row__body"><div className="row__label">你 <time className="row__time">{formatClock(row.at)}</time></div><div className="row__text row__text--finalized">{row.text}</div></div></li>;
  }
  return <li className="row row--assistant"><div className="row__avatar" aria-hidden="true">雅</div><div className="row__body"><div className="row__label">独雅 {row.at > 0 && <time className="row__time">{formatClock(row.at)}</time>}</div>{row.thinking !== '' && <details className="row__thinking"><summary>思考过程</summary><div>{row.thinking}</div></details>}<div className={`row__text${row.finalized ? ' row__text--finalized' : ' row__text--streaming'}`}>{row.text || ' '}</div></div></li>;
}

function ToolCard({ tool }: { readonly tool: ToolCallSurface }): ReactElement {
  const phaseClass = tool.settled ? (tool.phase === 'timed_out' ? 'timed_out' : 'completed') : 'running';
  const args = tool.arguments ?? tool.provisionalArguments;
  return (
    <div className="row__body"><div className="tool" role="group" aria-label={`${tool.name} 工具卡片`}>
      <div className="tool__head"><span className="tool__name">{tool.name}</span><span className={`tool__phase tool__phase--${phaseClass}`}>{formatToolPhase(tool.phase)}</span>{tool.durationMs !== null && <span className="row__time">{formatDuration(tool.durationMs)}</span>}</div>
      <div className={`tool__bar tool__bar--${tool.settled ? 'settled' : 'running'}`} />
      <div className="tool__body">
        {args !== null ? <pre className="tool__args">{JSON.stringify(args, null, 2)}</pre> : tool.argumentText !== '' ? <pre className="tool__args">{tool.argumentText}</pre> : <span className="tool__empty">等待工具参数</span>}
        {tool.progress !== null && <p>{tool.progress.title ?? tool.progress.stage ?? `已运行 ${Math.round(tool.progress.elapsedMs / 1000)} 秒`}{tool.progress.percent !== null ? ` · ${tool.progress.percent}%` : ''}</p>}
        {tool.result !== null && <details><summary>查看结果</summary><pre className="tool__args">{tool.result}</pre></details>}
      </div>
    </div></div>
  );
}

function ApprovalCard({ request, busy, onResolve }: {
  readonly request: HostPermissionRequest;
  readonly busy: boolean;
  readonly onResolve: (decision: PermissionDecision) => void;
}): ReactElement {
  return <section className="approval" aria-label="需要权限确认"><h2 className="approval__title">需要你确认这项操作</h2>{request.message && <p className="approval__detail">{request.message}</p>}<code className="approval__tool">{request.toolName}</code>{request.toolInput !== null && <pre className="approval__args">{JSON.stringify(request.toolInput, null, 2)}</pre>}<div className="approval__actions"><button className="approval__btn approval__btn--allow" type="button" disabled={busy} onClick={() => onResolve('allow')}>{busy ? '处理中…' : '允许一次'}</button><button className="approval__btn approval__btn--deny" type="button" disabled={busy} onClick={() => onResolve('deny')}>拒绝</button></div></section>;
}
