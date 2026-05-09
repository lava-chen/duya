'use client';

import { useMemo } from 'react';
import type { Message } from '@/types/message';

interface ContextUsageRingProps {
  messages: Message[];
  modelName?: string;
  contextWindow?: number;
  onCompress?: () => void;
  isCompacting?: boolean;
}

interface UsageData {
  hasData: boolean;
  modelName: string;
  contextWindow: number;
  used: number;
  ratio: number;
  estimatedNextTurn: number;
  estimatedNextRatio: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  state: 'normal' | 'warning' | 'critical';
}

function formatTokens(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

function getContextWindow(modelName?: string): number {
  // Default context windows for common models
  if (!modelName) return 200000;
  const lower = modelName.toLowerCase();
  if (lower.includes('claude-3-opus')) return 200000;
  if (lower.includes('claude-3-sonnet')) return 200000;
  if (lower.includes('claude-3-haiku')) return 200000;
  if (lower.includes('claude-3-5-sonnet')) return 200000;
  if (lower.includes('gpt-4-turbo')) return 128000;
  if (lower.includes('gpt-4o')) return 128000;
  if (lower.includes('gpt-4')) return 8192;
  if (lower.includes('gpt-3.5')) return 16385;
  if (lower.includes('minimax')) return 200000;
  return 200000;
}

function useContextUsage(messages: Message[], modelName?: string): UsageData {
  return useMemo(() => {
    const contextWindow = getContextWindow(modelName);
    const noData: UsageData = {
      modelName: modelName || 'unknown',
      contextWindow,
      used: 0,
      ratio: 0,
      estimatedNextTurn: 0,
      estimatedNextRatio: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      hasData: false,
      state: 'normal',
    };

    // Find the last assistant message with tokenUsage
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== 'assistant' || !msg.tokenUsage) continue;

      try {
        const usage = msg.tokenUsage;
        const inputTokens = usage.input_tokens || 0;
        const cacheRead = usage.cache_hit_tokens || 0;
        const cacheCreation = usage.cache_creation_tokens || 0;
        const outputTokens = usage.output_tokens || 0;
        const used = inputTokens + cacheRead + cacheCreation;
        const ratio = contextWindow ? used / contextWindow : 0;

        // Estimate next turn: current input context + this turn's output + ~200 token overhead
        const estimatedNextTurn = used + outputTokens + 200;
        const estimatedNextRatio = contextWindow ? estimatedNextTurn / contextWindow : 0;

        // Warning state uses the higher of actual and estimated ratios
        const effectiveRatio = Math.max(ratio, estimatedNextRatio);
        let state: 'normal' | 'warning' | 'critical' = 'normal';
        if (effectiveRatio >= 0.95) state = 'critical';
        else if (effectiveRatio >= 0.8) state = 'warning';

        return {
          modelName: modelName || 'unknown',
          contextWindow,
          used,
          ratio,
          estimatedNextTurn,
          estimatedNextRatio,
          cacheReadTokens: cacheRead,
          cacheCreationTokens: cacheCreation,
          outputTokens,
          hasData: true,
          state,
        };
      } catch {
        continue;
      }
    }

    return noData;
  }, [messages, modelName]);
}

export function ContextUsageRing({ messages, modelName, contextWindow, onCompress, isCompacting = false }: ContextUsageRingProps) {
  const usage = useContextUsage(messages, modelName);
  const effectiveContextWindow = contextWindow || usage.contextWindow;

  const size = 18;
  const strokeWidth = 2.5;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - usage.ratio * circumference;

  // Color based on context state
  let strokeColor = 'var(--muted)';
  if (usage.hasData) {
    if (usage.state === 'critical') strokeColor = 'var(--error)';
    else if (usage.state === 'warning') strokeColor = 'var(--warning)';
    else strokeColor = 'var(--success)';
  }

  return (
    <div className="context-usage-ring-wrapper">
      <button
        type="button"
        className="context-usage-ring-trigger"
        aria-label="Context usage"
      >
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="context-usage-ring-svg">
          {/* Background circle */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={strokeWidth}
            className="context-usage-ring-bg"
          />
          {/* Usage arc */}
          {usage.hasData && usage.ratio > 0 && (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              strokeWidth={strokeWidth}
              strokeDasharray={circumference}
              strokeDashoffset={offset}
              strokeLinecap="round"
              className="context-usage-ring-fill"
              style={{ stroke: strokeColor }}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          )}
        </svg>
      </button>

      {/* Hover Card */}
      <div className="context-usage-ring-card">
        {!usage.hasData ? (
          <p className="context-usage-ring-no-data">No usage data available</p>
        ) : (
          <div className="context-usage-ring-content">
            <div className="context-usage-ring-row">
              <span className="context-usage-ring-label">Used</span>
              <span className="context-usage-ring-value">{formatTokens(usage.used)}</span>
            </div>
            <div className="context-usage-ring-row">
              <span className="context-usage-ring-label">Total</span>
              <span className="context-usage-ring-value">{formatTokens(effectiveContextWindow)}</span>
            </div>
            <div className="context-usage-ring-row">
              <span className="context-usage-ring-label">Usage</span>
              <span className="context-usage-ring-value">{(usage.ratio * 100).toFixed(1)}%</span>
            </div>
            {usage.estimatedNextTurn > 0 && (
              <div className="context-usage-ring-row">
                <span className="context-usage-ring-label">Next Est.</span>
                <span className={`context-usage-ring-value ${usage.estimatedNextRatio >= 0.8 ? 'context-usage-ring-warning' : ''}`}>
                  ~{formatTokens(usage.estimatedNextTurn)} ({(usage.estimatedNextRatio * 100).toFixed(1)}%)
                </span>
              </div>
            )}
            <div className="context-usage-ring-divider" />
            <div className="context-usage-ring-row">
              <span className="context-usage-ring-label">Cache Read</span>
              <span className="context-usage-ring-value">{formatTokens(usage.cacheReadTokens)}</span>
            </div>
            <div className="context-usage-ring-row">
              <span className="context-usage-ring-label">Cache Create</span>
              <span className="context-usage-ring-value">{formatTokens(usage.cacheCreationTokens)}</span>
            </div>
            <div className="context-usage-ring-row">
              <span className="context-usage-ring-label">Output</span>
              <span className="context-usage-ring-value">{formatTokens(usage.outputTokens)}</span>
            </div>
            {usage.state !== 'normal' && (
              <p className={`context-usage-ring-hint ${usage.state === 'critical' ? 'context-usage-ring-critical' : 'context-usage-ring-warning'}`}>
                {usage.state === 'critical'
                  ? 'Context window nearly full. Consider starting a new session.'
                  : 'Context window filling up. Consider compacting soon.'}
              </p>
            )}
            {onCompress && usage.hasData && usage.state !== 'normal' && (
              <div className="context-usage-ring-divider" />
            )}
            {onCompress && usage.hasData && usage.state !== 'normal' && (
              <button
                type="button"
                className="context-usage-ring-compress-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onCompress();
                }}
                disabled={isCompacting}
              >
                {isCompacting ? 'Compacting...' : 'Compress Context'}
              </button>
            )}
            <p className="context-usage-ring-estimate">Based on recent response estimation</p>
          </div>
        )}
      </div>

      <style>{`
        .context-usage-ring-wrapper {
          position: relative;
          display: inline-flex;
        }

        .context-usage-ring-trigger {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 4px;
          background: transparent;
          border: none;
          cursor: pointer;
          border-radius: 4px;
          transition: background-color 0.15s ease;
        }

        .context-usage-ring-trigger:hover {
          background-color: var(--bg-hover);
        }

        .context-usage-ring-svg {
          display: block;
        }

        .context-usage-ring-bg {
          stroke: var(--border);
        }

        .context-usage-ring-fill {
          transition: stroke-dashoffset 0.3s ease, stroke 0.3s ease;
        }

        .context-usage-ring-card {
          position: absolute;
          bottom: calc(100% + 8px);
          right: 0;
          width: 220px;
          padding: 12px;
          background: var(--main-bg);
          border: 1px solid var(--border);
          border-radius: 8px;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
          opacity: 0;
          visibility: hidden;
          transform: translateY(4px);
          transition: opacity 0.15s ease, transform 0.15s ease, visibility 0.15s ease;
          z-index: 100;
          pointer-events: none;
        }

        .context-usage-ring-wrapper:hover .context-usage-ring-card {
          opacity: 1;
          visibility: visible;
          transform: translateY(0);
          pointer-events: auto;
        }

        .context-usage-ring-no-data {
          margin: 0;
          font-size: 12px;
          color: var(--muted);
          text-align: center;
        }

        .context-usage-ring-content {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .context-usage-ring-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 11px;
          line-height: 1.4;
        }

        .context-usage-ring-label {
          color: var(--muted);
        }

        .context-usage-ring-value {
          color: var(--text);
          font-weight: 500;
        }

        .context-usage-ring-warning {
          color: var(--warning) !important;
        }

        .context-usage-ring-critical {
          color: var(--error) !important;
        }

        .context-usage-ring-divider {
          height: 1px;
          background: var(--border);
          margin: 4px 0;
        }

        .context-usage-ring-hint {
          margin: 4px 0 0 0;
          padding-top: 6px;
          border-top: 1px solid var(--border);
          font-size: 10px;
          line-height: 1.4;
        }

        .context-usage-ring-estimate {
          margin: 4px 0 0 0;
          padding-top: 6px;
          border-top: 1px solid var(--border);
          font-size: 10px;
          color: var(--muted);
          line-height: 1.4;
        }

        .context-usage-ring-compress-btn {
          width: 100%;
          padding: 6px 8px;
          margin-top: 2px;
          background: var(--accent);
          color: var(--accent-fg, #fff);
          border: none;
          border-radius: 4px;
          font-size: 11px;
          font-weight: 500;
          cursor: pointer;
          transition: opacity 0.15s ease;
          line-height: 1.4;
        }

        .context-usage-ring-compress-btn:hover:not(:disabled) {
          opacity: 0.85;
        }

        .context-usage-ring-compress-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      `}</style>
    </div>
  );
}
