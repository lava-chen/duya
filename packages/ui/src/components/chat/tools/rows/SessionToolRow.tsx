/**
 * SessionToolRow — live "child session" card for the `session` tool (plan 504).
 *
 * Rendered when the model calls `session(spawn)` inside a bot chat. The card
 * tracks the child session through its lifecycle: status badge (Spawning /
 * Running / Done / Error / Cancelled), working directory + prompt, `+N/-M`
 * stats (from the child's persisted turn reviews), and a git line (branch +
 * latest commit). Live refresh = light 10s poll while running (completion is
 * event-driven via the wake, but a poll is cheap and is what the user picked).
 *
 * Hooks reused (no new data plumbing):
 *   - status/stats: window.electronAPI.thread.getCard   (new IPC)
 *   - git line:     getGitReview / getGitListCommits    (existing git IPC)
 *   - open:         window.electronAPI.recap.setActiveSession
 *   - cancel:       window.electronAPI.thread.cancelChild (new IPC)
 */
import { useEffect, useRef, useState } from 'react';
import { getGitCommits, getGitReview, type GitReviewResult } from '@/lib/git-ipc';
import { useConversationStore } from '@/stores/conversation-store';
import type { ToolAction } from '../types';

interface CardSession {
  id: string;
  title: string;
  status: string;
  workingDirectory: string;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
}

interface CardResult {
  ok: boolean;
  reason?: string;
  session?: CardSession;
}

const POLL_MS = 10_000;

type Tone = 'accent' | 'done' | 'danger' | 'muted';

function statusProjection(status: string): { label: string; tone: Tone } {
  const s = status.toLowerCase();
  if (['streaming', 'running', 'in_progress'].includes(s)) return { label: 'Running', tone: 'accent' };
  if (['active', 'pending', 'spawning', 'creating'].includes(s)) return { label: 'Spawning', tone: 'accent' };
  if (['completed', 'done', 'finished'].includes(s)) return { label: 'Done', tone: 'done' };
  if (['error', 'crashed', 'failed'].includes(s)) return { label: 'Error', tone: 'danger' };
  if (['cancelled', 'canceling', 'cancelled'].includes(s)) return { label: 'Cancelled', tone: 'muted' };
  return { label: status || 'Unknown', tone: 'muted' };
}

/** Extract the spawned child session id from the tool's success result text. */
function parseSessionId(result: string | undefined): string | null {
  if (!result) return null;
  const m = result.match(/spawn:[\w:-]+/);
  return m ? m[0] : null;
}

// Tone → CSS var / glyph mapping (light + dark via the theme vars).
const TONE_COLOR: Record<Tone, string> = {
  accent: 'var(--accent)',
  done: 'var(--success, #2fb344)',
  danger: 'var(--danger, #d1242f)',
  muted: 'var(--text-secondary)',
};

export function SessionToolRow({ tool }: { tool: ToolAction }) {
  const input = (tool.input ?? {}) as Record<string, unknown>;
  const action = (input.action as string) || 'spawn';
  const workingDirectory = (input.workingDirectory as string) || '';
  const prompt = ((input.prompt as string) || '').trim();
  const sessionId = parseSessionId(tool.result);

  const [session, setSession] = useState<CardSession | null>(null);
  const [git, setGit] = useState<GitReviewResult | null>(null);
  const [commit, setCommit] = useState<string>('');
  const [cancelled, setCancelled] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (action !== 'spawn' || !sessionId) return;

    let disposed = false;
    const load = async () => {
      const card = (await window.electronAPI.thread.getCard(sessionId)) as CardResult;
      if (disposed) return;
      if (card.ok && card.session) {
        setSession(card.session);
        setFailed(null);
        const wd = card.session.workingDirectory;
        if (wd) {
          try {
            const review = await getGitReview(wd);
            if (!disposed) setGit(review);
            const commits = await getGitCommits(wd, 1);
            if (!disposed && commits.commits.length > 0) {
              setCommit(`${commits.commits[0].hash.slice(0, 7)} ${commits.commits[0].subject}`);
            }
          } catch {
            // git bridge absent / not a repo — git line stays hidden
          }
        }
      } else if (!disposed) {
        setFailed(card.reason ?? 'session not found');
      }
    };

    void load();
    timerRef.current = setInterval(load, POLL_MS);
    return () => {
      disposed = true;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [action, sessionId]);

  // Non-spawn calls (get/reply/cancel/rename) return plain text — render as a
  // compact result row instead of a live card.
  if (action !== 'spawn' || !sessionId) {
    const summary = typeof tool.result === 'string' ? tool.result : '(no result)';
    return (
      <div className="duya-session-row" style={styles.rowText}>
        <span style={styles.rowVerbatim}>{tool.name}: {action}</span>
        <span style={{ marginTop: 4 }}>{summary}</span>
      </div>
    );
  }

  const projection = cancelled ? { label: 'Cancelled', tone: 'muted' as Tone } : statusProjection(session?.status ?? 'spawning');
  const color = TONE_COLOR[projection.tone];
  const statBits: string[] = [];
  if (session && session.filesChanged > 0) {
    statBits.push(`+${session.linesAdded}/-${session.linesRemoved} across ${session.filesChanged} file${session.filesChanged === 1 ? '' : 's'}`);
  }
  const branch = git?.branch ? `⭑ ${git.branch}` : null;

  const { setActiveThread } = useConversationStore();

  const handleOpen = () => {
    if (!sessionId) return;
    // Switch the main UI to the spawned session's normal chat view so the user
    // can read its progress and continue typing in it directly. setActiveThread
    // loads the row from the DB if it is not yet cached and opens ChatView
    // (currentView 'chat') — the same path the sidebar uses. Recap registration
    // is kept for background summary bookkeeping (harmless, no UI effect).
    void setActiveThread(sessionId);
    void window.electronAPI.recap.setActiveSession(sessionId);
  };
  const handleCancel = () => {
    if (!sessionId) return;
    void window.electronAPI.thread.cancelChild(sessionId).then(() => setCancelled(true));
  };

  const busy = projection.tone === 'accent';

  return (
    <div style={styles.card} data-tone={projection.tone} onClick={handleOpen} role="button" aria-label={`Open session ${sessionId || ''}`} data-clickable>
      {/* Header */}
      <div style={styles.header}>
        <span style={{ ...styles.title, color }}>{session?.title || '[Spawn] session'}</span>
        <span style={styles.badgeWrap}>
          <span aria-hidden style={{ ...styles.dot, background: color, animation: busy ? 'duya-pulse 1s ease-in-out infinite' : undefined }} />
          <span style={styles.badge}>{projection.label}</span>
        </span>
      </div>

      {/* Working dir */}
      {session?.workingDirectory ? <div style={styles.dir}>{session.workingDirectory}</div> : null}
      {/* Prompt */}
      {prompt ? <div style={styles.prompt}>{prompt.length > 120 ? `${prompt.slice(0, 117)}…` : prompt}</div> : null}

      {/* Stats + git line */}
      <div style={styles.footer}>
        {statBits.length > 0 ? <span style={styles.stat}>{statBits.join(' · ')}</span> : null}
        {branch ? <span style={styles.git}>{branch}{commit ? ` · ${commit}` : ''}</span> : commit ? <span style={styles.git}>{commit}</span> : null}
      </div>

      {/* Error */}
      {failed ? <div style={styles.error}>Error: {failed}</div> : null}

      {/* Actions */}
      <div style={styles.actions}>
        <button type="button" style={styles.primaryBtn} onClick={(e) => { e.stopPropagation(); handleOpen(); }} disabled={!sessionId}>
          Open &amp; continue
        </button>
        <button type="button" style={styles.ghostBtn} onClick={(e) => { e.stopPropagation(); handleCancel(); }} disabled={cancelled || busy === false}>
          {cancelled ? 'Cancelled' : 'Cancel'}
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    border: '1px solid var(--border, rgba(128,128,128,0.25))',
    borderRadius: 10,
    padding: '10px 12px',
    background: 'var(--bg-card, transparent)',
    maxWidth: '100%',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    fontFamily: 'var(--font-ui, inherit)',
    cursor: 'pointer',
  },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  title: { fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  badgeWrap: { display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 },
  dot: { width: 7, height: 7, borderRadius: '50%', display: 'inline-block' },
  badge: { fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.4 },
  dir: { fontFamily: 'monospace', fontSize: 11, color: 'var(--text-secondary)', wordBreak: 'break-all' },
  prompt: { fontSize: 12, color: 'var(--text)', lineHeight: 1.4 },
  footer: { display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 11, color: 'var(--text-secondary)' },
  stat: { color: 'var(--text)', fontWeight: 500 },
  git: { fontFamily: 'monospace' },
  error: { fontSize: 12, color: 'var(--danger, #d1242f)' },
  actions: { display: 'flex', gap: 8, marginTop: 2 },
  primaryBtn: {
    border: 'none', borderRadius: 6, padding: '4px 10px', cursor: 'pointer',
    background: 'var(--accent)', color: 'var(--bg-canvas, #fff)', fontSize: 12,
  },
  ghostBtn: {
    border: '1px solid var(--border, rgba(128,128,128,0.25))', borderRadius: 6, padding: '4px 10px',
    cursor: 'pointer', background: 'transparent', color: 'var(--text)', fontSize: 12,
  },
  rowText: { fontSize: 12, color: 'var(--text)', display: 'flex', flexDirection: 'column' },
  rowVerbatim: { fontFamily: 'monospace', fontSize: 11, color: 'var(--text-secondary)' },
};