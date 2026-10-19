import { useCallback, useState, type FormEvent, type ReactElement, type KeyboardEvent } from 'react';
import type { Workspace } from '../client/workspace.js';
import { useWorkspaceState } from './use-workspace.js';

export function Composer({ workspace }: { readonly workspace: Workspace }): ReactElement {
  const state = useWorkspaceState(workspace);
  const [draft, setDraft] = useState('');
  const activeRun = state.durableRun?.status === 'running';
  const canSend = state.phase === 'ready' && state.selectedSessionId !== null && !state.sending && !activeRun && draft.trim() !== '';

  const send = useCallback(async (event?: FormEvent<HTMLFormElement>): Promise<void> => {
    event?.preventDefault();
    if (!canSend) return;
    const message = draft.trim();
    setDraft('');
    await workspace.send(message);
    if (workspace.getSnapshot().sendError !== null) setDraft(message);
  }, [canSend, draft, workspace]);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }, [send]);

  const placeholder = state.selectedSessionId === null
    ? '先从左侧选择一个会话'
    : activeRun
      ? '当前运行结束后可继续发送'
      : '输入消息，按 Enter 发送，Shift + Enter 换行';
  const hint = state.sendError !== null
    ? `消息未能发送：${state.sendError}`
    : state.cancelRequested
      ? '已提交取消请求，等待运行台账确认。'
      : activeRun
        ? '运行进行中；可请求取消。'
        : '消息发送到所选会话。';

  return (
    <footer className="composer">
      <form className="composer__form" onSubmit={(event) => void send(event)}>
        <label className="composer__field">
          <span className="composer__label">写一条消息</span>
          <textarea
            className="composer__textarea"
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            aria-label="消息内容"
            disabled={state.phase !== 'ready' || state.selectedSessionId === null || activeRun || state.sending}
            rows={2}
          />
        </label>
        {activeRun && <button className="composer__btn composer__btn--ghost" type="button" disabled={state.cancelRequested} onClick={() => void workspace.cancelSelectedRun()}>{state.cancelRequested ? '等待取消' : '取消运行'}</button>}
        <button className="composer__btn" type="submit" disabled={!canSend}>{state.sending ? '发送中…' : '发送'}</button>
      </form>
      <p className={`composer__hint${state.sendError !== null ? ' composer__hint--error' : ''}`}>{hint}</p>
    </footer>
  );
}
