import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionCheckoutCommand, SessionCheckoutResult, SessionCheckoutState } from '@duya/agent-protocol';
import { useTranslation } from '@/hooks/useTranslation';
import { useConversationStore } from '@/stores/conversation-store';

export function CheckoutControls({ sessionId, control, onChange }: {
  sessionId: string;
  control: (id: string, command: SessionCheckoutCommand) => Promise<SessionCheckoutResult>;
  onChange: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<SessionCheckoutState | null>(null);
  const [kind, setKind] = useState<'create' | 'existing'>('create');
  const [target, setTarget] = useState('');
  const [base, setBase] = useState('');
  const [branch, setBranch] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const generation = useRef(0);
  const appliedRevision = useRef(-1);
  const apply = useCallback((result: SessionCheckoutResult) => {
    if (result.state.revision < appliedRevision.current) return;
    appliedRevision.current = result.state.revision;
    setState(result.state);
    // The Host already committed this cursor. Update the renderer cache only;
    // the generic working-directory setter would write it back without CAS.
    useConversationStore.setState((current) => ({ threads: current.threads.map((thread) =>
      thread.id === sessionId && thread.workingDirectory !== result.state.cwd ? { ...thread, workingDirectory: result.state.cwd } : thread) }));
  }, [sessionId]);
  useEffect(() => {
    const token = ++generation.current;
    const refresh = async () => {
      try { const result = await control(sessionId, { action: 'status' }); if (generation.current === token) apply(result); }
      catch (cause) { if (generation.current === token) setError(cause instanceof Error ? cause.message : String(cause)); }
    };
    appliedRevision.current = -1;
    setState(null); setError(''); setNotice(''); setTarget(''); setBusy(false); busyRef.current = false; void refresh();
    const interval = setInterval(() => { if (!busyRef.current) void refresh(); }, 3000);
    return () => { generation.current++; clearInterval(interval); };
  }, [control, sessionId, apply]);
  const run = async (command: SessionCheckoutCommand) => {
    if (busyRef.current) return;
    const token = generation.current;
    busyRef.current = true;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await control(sessionId, command);
      if (generation.current !== token) return;
      apply(result);
      setNotice(result.removal && !result.removal.removed ? `${t('wsl.control.retained')}: ${result.removal.reason}`
        : result.conflicts?.length ? `${t('wsl.control.conflicts')}: ${result.conflicts.join(', ')}`
        : result.sourceChangesExcluded ? t('wsl.control.excluded') : result.outcome);
      await onChange();
    } catch (cause) { if (generation.current === token) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (generation.current === token) { setBusy(false); busyRef.current = false; } }
  };
  return <section className="wsl-controls" aria-label={t('wsl.control.title')}>
    <h3 className="wsl-block-title">{t('wsl.control.title')}</h3>
    {state ? <code className="wsl-cwd">{state.cwd}</code> : null}
    {error ? <p role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {state?.pending ? <button className="wsl-action" disabled={busy} onClick={() => void run({ action: 'recover' })}>{t('wsl.control.recover')}</button>
      : state?.checkout ? <>
        <div className="wsl-control-row">
          <button className="wsl-action" disabled={busy} onClick={() => void run({ action: 'exit', disposition: 'keep' })}>{t('wsl.control.keep')}</button>
          <button className="wsl-action" disabled={busy} onClick={() => void run({ action: 'exit', disposition: 'remove' })}>{t('wsl.control.remove')}</button>
        </div>
        <div className="wsl-control-row">
          <input aria-label={t('wsl.control.base')} placeholder={t('wsl.control.base')} value={base} disabled={busy} onChange={(event) => setBase(event.target.value)} />
          <button className="wsl-action" disabled={busy} onClick={() => void run({ action: 'sync', ...(base.trim() ? { base: base.trim() } : {}) })}>{t('wsl.control.sync')}</button>
          {state.mergeBase ? <button className="wsl-action" disabled={busy} onClick={() => void run({ action: 'sync', abort: true })}>{t('wsl.control.abort')}</button> : null}
        </div>
      </> : <form onSubmit={(event) => { event.preventDefault(); void run({ action: 'enter', ...(kind === 'create' ? { name: target.trim(), ...(base.trim() ? { base: base.trim() } : {}), ...(branch.trim() ? { branchName: branch.trim() } : {}) } : { path: target.trim() }) }); }}>
        <select aria-label={t('wsl.control.mode')} disabled={busy} value={kind} onChange={(event) => setKind(event.target.value as 'create' | 'existing')}>
          <option value="create">{t('wsl.control.create')}</option><option value="existing">{t('wsl.control.existing')}</option>
        </select>
        <input required aria-label={kind === 'create' ? t('wsl.control.name') : t('wsl.control.path')} placeholder={kind === 'create' ? t('wsl.control.name') : t('wsl.control.path')} value={target} disabled={busy || !state} onChange={(event) => setTarget(event.target.value)} />
        {kind === 'create' ? <>
          <input aria-label={t('wsl.control.base')} placeholder={t('wsl.control.base')} value={base} disabled={busy} onChange={(event) => setBase(event.target.value)} />
          <input aria-label={t('wsl.control.branch')} placeholder={t('wsl.control.branch')} value={branch} disabled={busy} onChange={(event) => setBranch(event.target.value)} />
        </> : null}
        <button className="wsl-action" disabled={busy || !state || !target.trim()} type="submit">{t('wsl.control.enter')}</button>
      </form>}
  </section>;
}
