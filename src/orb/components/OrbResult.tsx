/**
 * OrbResult — RESULT state.
 *
 * 350x350 结果卡片,显示 Agent 响应 + 操作按钮。
 * - Top: streaming rendered markdown
 * - Bottom toolbar: Esc / more menu / Insert Tab (primary)
 *
 * Insert Tab 把 result.rawText 通过 nut.js type 到当前焦点输入框;
 * focusedEntity.redacted=true 时 main 进程拒绝。
 */
import { useEffect, useRef, useState } from 'react';
import { BloubOrb, type OrbMoment } from '../bot/BloubOrb';
import type { ResultContent } from '../types';

interface OrbResultProps {
  result: ResultContent | null;
  /** 瞬时动画（长任务完成 burst），随卡片挂载播放一次。 */
  moment?: OrbMoment | null;
  onInsertTab: () => Promise<void>;
}

export function OrbResult({ result, moment = null, onInsertTab }: OrbResultProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [inserting, setInserting] = useState(false);
  const [insertError, setInsertError] = useState<string | null>(null);

  // Auto-scroll to bottom as the stream accumulates
  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [result?.rawText]);

  const handleInsertTab = async () => {
    setInserting(true);
    setInsertError(null);
    try {
      await onInsertTab();
    } catch (e) {
      setInsertError(e instanceof Error ? e.message : '插入失败');
    } finally {
      setInserting(false);
    }
  };

  return (
    <div className="orb-result orb-no-drag" role="dialog" aria-label="Duya 结果">
      <div className="orb-result-body" ref={bodyRef}>
        {result?.title && <h2>{result.title}</h2>}
        {result?.rawText ? (
          <div className="orb-result-text">{result.rawText}</div>
        ) : (
          <p style={{ color: 'var(--orb-fg-muted)' }}>等待结果...</p>
        )}
        {insertError && (
          <p style={{ color: 'var(--orb-state-error)', marginTop: 8 }}>
            {insertError}
          </p>
        )}
      </div>

      <div className="orb-result-toolbar">
        {/* 迷你小怪物：随卡片挂载把 moment（burst）播完，之后安静呼吸。 */}
        <BloubOrb size={26} moment={moment} fps={30} />
        <button
          className="orb-result-action"
          onClick={() => window.electronAPI?.orb?.collapse()}
          aria-label="关闭 (Esc)"
        >
          Esc
        </button>

        <button
          className="orb-result-action"
          aria-label="更多操作"
          title="更多操作"
        >
          ···
        </button>

        <button
          className="orb-result-action orb-result-action--primary"
          onClick={handleInsertTab}
          disabled={inserting || !result?.rawText}
          aria-label="插入到当前输入框 (Tab)"
          title="把结果输入到当前 App 输入框"
        >
          {inserting ? '插入中...' : 'Insert Tab'}
        </button>
      </div>
    </div>
  );
}