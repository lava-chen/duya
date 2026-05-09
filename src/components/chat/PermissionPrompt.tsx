// PermissionPrompt.tsx - Permission prompt UI component

'use client';

import { useState, useEffect, useRef } from 'react';
import type { PermissionRequestEvent } from '@/types/stream';
import { useTranslation } from '@/hooks/useTranslation';
import type { TranslationKey } from '@/i18n';

interface ToolUseInfo {
  id: string;
  name: string;
  input: unknown;
}

interface PermissionPromptProps {
  /** Current pending permission request */
  pendingPermission: PermissionRequestEvent | null;
  /** The decision that was made for the last permission */
  permissionResolved: 'allow' | 'deny' | null;
  /** Callback when user responds to permission */
  onPermissionResponse: (decision: 'allow' | 'allow_session' | 'deny', updatedInput?: Record<string, unknown>, denyMessage?: string) => void;
  /** Tool uses in the current session */
  toolUses?: ToolUseInfo[];
  /** Permission profile - 'full_access' skips prompts */
  permissionProfile?: 'default' | 'full_access';
}

/** Max lines to show in the tool input area before collapsing */
const MAX_INPUT_LINES = 8;
const MAX_INPUT_CHARS = 500;

function summarizePermission(request: PermissionRequestEvent): { title: string; summary: string } {
  const input = request.toolInput || {};
  const filePath = (input.file_path || input.path) ? String(input.file_path || input.path) : null;

  if (request.toolName === 'Edit') {
    return {
      title: 'Edit',
      summary: filePath ? `将更新文件内容：${filePath}` : '将更新文件内容',
    };
  }
  if (request.toolName === 'Write') {
    return {
      title: 'Write',
      summary: filePath ? `将写入文件：${filePath}` : '将写入文件',
    };
  }
  if (request.toolName === 'Bash') {
    return {
      title: 'Bash',
      summary: '将执行一条命令',
    };
  }
  return {
    title: request.toolName,
    summary: '需要你的确认后继续执行',
  };
}

/**
 * Collapsible tool input display with truncation for long content
 */
function ToolInputDisplay({ input, t }: { input: Record<string, unknown>; t: (key: TranslationKey, params?: Record<string, string | number>) => string }) {
  const [expanded, setExpanded] = useState(false);

  const formatToolInput = (inp: Record<string, unknown>): string => {
    // For Bash, show command prominently
    if (inp.command) {
      const cmd = String(inp.command);
      const extraKeys = Object.keys(inp).filter(k => k !== 'command' && k !== 'description');
      if (extraKeys.length > 0) {
        return JSON.stringify(inp, null, 2);
      }
      return cmd;
    }
    // For Write/Edit, show the full input so content/old_string/new_string are visible
    if (inp.file_path) {
      const keys = Object.keys(inp);
      if (keys.length === 1) return String(inp.file_path);
      return JSON.stringify(inp, null, 2);
    }
    if (inp.path) {
      const keys = Object.keys(inp);
      if (keys.length === 1) return String(inp.path);
      return JSON.stringify(inp, null, 2);
    }
    return JSON.stringify(inp, null, 2);
  };

  const formatted = formatToolInput(input);
  const lineCount = formatted.split('\n').length;
  const isTruncated = lineCount > MAX_INPUT_LINES || formatted.length > MAX_INPUT_CHARS;

  const displayText = !expanded && isTruncated
    ? formatted.slice(0, MAX_INPUT_CHARS).split('\n').slice(0, MAX_INPUT_LINES).join('\n') + '\n…'
    : formatted;

  return (
    <div className="mt-1 overflow-hidden rounded" style={{ backgroundColor: 'var(--surface)' }}>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-xs" style={{
        maxHeight: !expanded && isTruncated ? '10rem' : undefined,
      }}>
        {displayText}
      </pre>
      {isTruncated && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="w-full border-t px-3 py-1 text-[10px] transition-colors hover:opacity-80"
          style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
        >
          {expanded ? '▲ ' + t('permission.collapse') : '▼ ' + t('permission.showMore')}
        </button>
      )}
    </div>
  );
}

/**
 * Generic confirmation prompt for tool permission requests
 */
function GenericPermissionPrompt({
  pendingPermission,
  onPermissionResponse,
  t,
}: {
  pendingPermission: PermissionRequestEvent;
  onPermissionResponse: (decision: 'allow' | 'allow_session' | 'deny') => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const { title, summary } = summarizePermission(pendingPermission);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}>
        <span
          className="rounded px-1.5 py-0.5 font-medium"
          style={{ backgroundColor: 'var(--surface)' }}
        >
          {title}
        </span>
        <span>{summary}</span>
      </div>

      {pendingPermission.decisionReason && (
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          {pendingPermission.decisionReason}
        </p>
      )}

      <div>
        <button
          type="button"
          onClick={() => setShowDetails((v) => !v)}
          className="text-xs underline-offset-2 hover:underline"
          style={{ color: 'var(--muted)' }}
        >
          {showDetails ? t('permission.collapse') : t('permission.showMore')}
        </button>
        {showDetails && <ToolInputDisplay input={pendingPermission.toolInput} t={t} />}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onPermissionResponse('deny')}
          className="px-3 py-1.5 text-xs rounded-md border transition-colors hover:opacity-80"
          style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)' }}
        >
          {t('permission.deny')}
        </button>
        <button
          type="button"
          onClick={() => onPermissionResponse('allow')}
          className="px-3 py-1.5 text-xs rounded-md border transition-colors hover:opacity-80"
          style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)' }}
        >
          {t('permission.allowOnce')}
        </button>
        <button
          type="button"
          onClick={() => onPermissionResponse('allow_session')}
          className="px-3 py-1.5 text-xs rounded-md text-white transition-colors hover:opacity-90"
          style={{ background: 'linear-gradient(140deg, #5f71ff, #7286ff)' }}
        >
          {t('permission.allowForSession')}
        </button>
      </div>
    </div>
  );
}

/**
 * AskUserQuestion mode - shows multi-option questions
 */
function AskUserQuestionUI({
  toolInput,
  onSubmit,
  t,
}: {
  toolInput: Record<string, unknown>;
  onSubmit: (decision: 'allow', updatedInput: Record<string, unknown>) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const questions = (toolInput.questions || []) as Array<{
    question: string;
    options: Array<{ label: string; description?: string }>;
    multiSelect: boolean;
    header?: string;
  }>;

  const [selections, setSelections] = useState<Record<string, Set<string>>>({});
  const [otherTexts, setOtherTexts] = useState<Record<string, string>>({});
  const [useOther, setUseOther] = useState<Record<string, boolean>>({});

  const toggleOption = (qIdx: string, label: string, multi: boolean) => {
    setSelections((prev) => {
      const current = new Set(prev[qIdx] || []);
      if (multi) {
        if (current.has(label)) { current.delete(label); } else { current.add(label); }
      } else {
        current.clear();
        current.add(label);
      }
      return { ...prev, [qIdx]: current };
    });
    setUseOther((prev) => ({ ...prev, [qIdx]: false }));
  };

  const toggleOther = (qIdx: string, multi: boolean) => {
    if (!multi) {
      setSelections((prev) => ({ ...prev, [qIdx]: new Set() }));
    }
    setUseOther((prev) => ({ ...prev, [qIdx]: !prev[qIdx] }));
  };

  const handleSubmit = () => {
    const answers: Record<string, string> = {};
    questions.forEach((q, i) => {
      const qIdx = String(i);
      const selected = Array.from(selections[qIdx] || []);
      if (useOther[qIdx] && otherTexts[qIdx]?.trim()) {
        selected.push(otherTexts[qIdx].trim());
      }
      answers[q.question] = selected.join(', ');
    });
    onSubmit('allow', { questions: toolInput.questions, answers });
  };

  const hasAnswer = questions.some((_, i) => {
    const qIdx = String(i);
    return (selections[qIdx]?.size || 0) > 0 || (useOther[qIdx] && otherTexts[qIdx]?.trim());
  });

  return (
    <div className="space-y-4 py-2">
      {questions.map((q, i) => {
        const qIdx = String(i);
        const selected = selections[qIdx] || new Set<string>();
        return (
          <div key={qIdx} className="space-y-2">
            {q.header && (
              <span
                className="inline-block rounded-full px-2 py-0.5 text-[10px] font-medium"
                style={{ backgroundColor: 'var(--surface)', color: 'var(--muted)' }}
              >
                {q.header}
              </span>
            )}
            <p className="text-sm font-medium">{q.question}</p>
            <div className="flex flex-wrap gap-2">
              {q.options.map((opt) => {
                const isSelected = selected.has(opt.label);
                return (
                  <button
                    key={opt.label}
                    type="button"
                    onClick={() => toggleOption(qIdx, opt.label, q.multiSelect)}
                    className="px-3 py-1 text-xs rounded-md border transition-colors"
                    style={{
                      borderColor: isSelected ? 'var(--accent)' : 'var(--border)',
                      backgroundColor: isSelected ? 'rgba(94, 109, 255, 0.1)' : 'var(--surface)',
                      color: isSelected ? 'var(--accent)' : 'var(--text)',
                    }}
                    title={opt.description}
                  >
                    {q.multiSelect && (
                      <span className="mr-1.5">{isSelected ? '☑' : '☐'}</span>
                    )}
                    {opt.label}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => toggleOther(qIdx, q.multiSelect)}
                className="px-3 py-1 text-xs rounded-md border transition-colors"
                style={{
                  borderColor: useOther[qIdx] ? 'var(--accent)' : 'var(--border)',
                  backgroundColor: useOther[qIdx] ? 'rgba(94, 109, 255, 0.1)' : 'var(--surface)',
                  color: useOther[qIdx] ? 'var(--accent)' : 'var(--text)',
                }}
              >
                {t('permission.other')}
              </button>
            </div>
            {useOther[qIdx] && (
              <input
                type="text"
                placeholder={t('permission.typeAnswer')}
                value={otherTexts[qIdx] || ''}
                onChange={(e) => setOtherTexts((prev) => ({ ...prev, [qIdx]: e.target.value }))}
                className="w-full px-3 py-1.5 text-xs rounded-md border"
                style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text)' }}
                autoFocus
              />
            )}
          </div>
        );
      })}
      <button
        type="button"
        onClick={handleSubmit}
        disabled={!hasAnswer}
        className="px-3 py-1.5 text-xs rounded-md text-white transition-colors hover:opacity-90 disabled:opacity-50"
        style={{ background: 'linear-gradient(140deg, #5f71ff, #7286ff)' }}
      >
        {t('permission.submit')}
      </button>
    </div>
  );
}

/**
 * ExitPlanMode UI - Plan mode completion approval
 */
function ExitPlanModeUI({
  pendingPermission,
  toolUses,
  onApprove,
  onDeny,
  onDenyWithMessage,
  t,
}: {
  pendingPermission: PermissionRequestEvent;
  toolUses: ToolUseInfo[];
  onApprove: () => void;
  onDeny: () => void;
  onDenyWithMessage: (message: string) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const [feedback, setFeedback] = useState('');
  const toolInput = pendingPermission.toolInput as Record<string, unknown>;
  const allowedPrompts = (toolInput.allowedPrompts || []) as Array<{
    tool: string;
    prompt: string;
  }>;

  return (
    <div className="space-y-3 rounded-lg p-4" style={{ border: '1px solid rgba(94, 109, 255, 0.3)', backgroundColor: 'rgba(94, 109, 255, 0.05)' }}>
      <div className="flex items-center gap-2">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--accent)' }}>
          <polyline points="9 11 12 14 22 4"/>
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
        </svg>
        <span className="text-sm font-medium">{t('permission.planComplete')}</span>
      </div>
      {allowedPrompts.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs" style={{ color: 'var(--muted)' }}>{t('permission.requestedPermissions')}</p>
          <ul className="space-y-0.5">
            {allowedPrompts.map((p, i) => (
              <li key={i} className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--muted)' }}>
                <span
                  className="rounded px-1.5 py-0.5 font-mono text-[10px]"
                  style={{ backgroundColor: 'var(--surface)' }}
                >
                  {p.tool}
                </span>
                <span>{p.prompt}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onDeny}
          className="px-3 py-1.5 text-xs rounded-md border transition-colors hover:opacity-80"
          style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)' }}
        >
          {t('permission.reject')}
        </button>
        <button
          type="button"
          onClick={onApprove}
          className="px-3 py-1.5 text-xs rounded-md text-white transition-colors hover:opacity-90"
          style={{ background: 'linear-gradient(140deg, #5f71ff, #7286ff)' }}
        >
          {t('permission.approveExecute')}
        </button>
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          placeholder={t('permission.provideFeedback')}
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && feedback.trim()) {
              onDenyWithMessage(feedback.trim());
            }
          }}
          className="flex-1 px-3 py-1.5 text-xs rounded-md border"
          style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text)' }}
        />
        <button
          type="button"
          onClick={() => {
            if (feedback.trim()) onDenyWithMessage(feedback.trim());
          }}
          disabled={!feedback.trim()}
          className="px-3 py-1.5 text-xs rounded-md border transition-colors disabled:opacity-50 hover:opacity-80"
          style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)' }}
        >
          {t('permission.doThisInstead')}
        </button>
      </div>
    </div>
  );
}

/**
 * PermissionPrompt - Displays permission requests and handles user responses
 */
export function PermissionPrompt({
  pendingPermission,
  permissionResolved,
  onPermissionResponse,
  toolUses = [],
  permissionProfile,
}: PermissionPromptProps) {
  const { t } = useTranslation();
  const autoApprovedRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      permissionProfile === 'full_access' &&
      pendingPermission &&
      !permissionResolved &&
      autoApprovedRef.current !== pendingPermission.id
    ) {
      autoApprovedRef.current = pendingPermission.id;
      onPermissionResponse('allow');
    }
  }, [permissionProfile, pendingPermission, permissionResolved, onPermissionResponse]);

  // Don't render permission UI when full_access
  if (permissionProfile === 'full_access') return null;

  // Nothing to show
  if (!pendingPermission && !permissionResolved) return null;

  // Only show the resolved status text when already resolved
  const isResolved = !!permissionResolved;

  return (
    <div
      className="mb-2 w-full rounded-lg border px-3 py-2 shadow-sm"
      style={{ borderColor: 'var(--border)', backgroundColor: 'var(--main-bg)' }}
    >
      {/* ExitPlanMode */}
      {pendingPermission?.toolName === 'ExitPlanMode' && !isResolved && (
        <ExitPlanModeUI
          pendingPermission={pendingPermission}
          toolUses={toolUses}
          onApprove={() => onPermissionResponse('allow')}
          onDeny={() => onPermissionResponse('deny')}
          onDenyWithMessage={(msg) => onPermissionResponse('deny', undefined, msg)}
          t={t}
        />
      )}
      {pendingPermission?.toolName === 'ExitPlanMode' && permissionResolved === 'allow' && (
        <p className="py-1 text-xs" style={{ color: 'var(--accent)' }}>{t('permission.planApproved')}</p>
      )}
      {pendingPermission?.toolName === 'ExitPlanMode' && permissionResolved === 'deny' && (
        <p className="py-1 text-xs text-red-500">{t('permission.planRejected')}</p>
      )}

      {/* AskUserQuestion */}
      {pendingPermission?.toolName === 'AskUserQuestion' && !isResolved && (
        <AskUserQuestionUI
          toolInput={pendingPermission.toolInput as Record<string, unknown>}
          onSubmit={(decision, updatedInput) => onPermissionResponse(decision, updatedInput)}
          t={t}
        />
      )}
      {pendingPermission?.toolName === 'AskUserQuestion' && isResolved && (
        <p className="py-1 text-xs" style={{ color: 'var(--accent)' }}>{t('permission.answerSubmitted')}</p>
      )}

      {/* Generic confirmation for other tools */}
      {pendingPermission?.toolName !== 'AskUserQuestion' && pendingPermission?.toolName !== 'ExitPlanMode' && pendingPermission && !isResolved && (
        <GenericPermissionPrompt
          pendingPermission={pendingPermission}
          onPermissionResponse={(decision) => onPermissionResponse(decision)}
          t={t}
        />
      )}

      {/* Resolved status for generic tools */}
      {pendingPermission?.toolName !== 'AskUserQuestion' && pendingPermission?.toolName !== 'ExitPlanMode' && isResolved && (
        <p className={permissionResolved === 'allow' ? 'py-1 text-xs' : 'py-1 text-xs text-red-500'}>
          {permissionResolved === 'allow' ? t('permission.allowed') : t('permission.denied')}
        </p>
      )}
    </div>
  );
}
