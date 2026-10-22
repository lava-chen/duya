"use client";

import { useState } from "react";
import { IconChevronDown, IconFileDiff } from "@/components/icons";
import type { GitCommitInfo, GitTurnHistoryEntry } from "@/contracts/git";
import type { ReviewScopeKind } from "./ReviewScopePicker";

export interface ReviewCommitRailProps {
  scope: ReviewScopeKind;
  commits: GitCommitInfo[];
  /** Turn snapshots, only meaningful for the latest-turn scope. */
  turns?: GitTurnHistoryEntry[];
  selectedTurnId?: string;
  onPickAll: () => void;
  onPickUncommitted: () => void;
  onPickCommit: (hash: string) => void;
  onPickTurn?: (turnId: string) => void;
}

/**
 * The bottom block of the sidebar: what the diff is measured against.
 * Kept separate from the tree so the tree can scroll independently.
 */
export function ReviewCommitRail({
  scope,
  commits,
  turns,
  selectedTurnId,
  onPickAll,
  onPickUncommitted,
  onPickCommit,
  onPickTurn,
}: ReviewCommitRailProps) {
  const [open, setOpen] = useState(true);
  const count = commits.length + (turns?.length ?? 0);

  return (
    <div className={`rev-rail${open ? "" : " is-collapsed"}`}>
      <button
        type="button"
        className="rev-rail-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <IconChevronDown size={12} className="rev-rail-chevron" />
        <span>提交</span>
        <span className="rev-rail-count">{count}</span>
      </button>

      {open ? (
        <div className="rev-rail-list">
          <button
            type="button"
            className={`rev-rail-item${scope === "uncommitted" ? " is-on" : ""}`}
            onClick={onPickUncommitted}
          >
            <span className="rev-rail-sub">所有更改</span>
          </button>
          <button
            type="button"
            className={`rev-rail-item${scope === "uncommitted" ? " is-on" : ""}`}
            onClick={onPickUncommitted}
          >
            <span className="rev-rail-sub">未提交的更改</span>
          </button>

          {turns?.map((turn) => (
            <button
              key={turn.id}
              type="button"
              className={`rev-rail-item${turn.id === selectedTurnId ? " is-on" : ""}`}
              aria-label={`轮次 ${turn.id}`}
              onClick={() => onPickTurn?.(turn.id)}
            >
              <IconFileDiff size={11} />
              <span className="rev-rail-sub">
                第 {turn.turnId.slice(0, 6)} 轮 · +{turn.additions} −{turn.removals}
              </span>
            </button>
          ))}

          {commits.map((commit) => (
            <button
              key={commit.hash}
              type="button"
              className="rev-rail-item"
              onClick={() => onPickCommit(commit.hash)}
              title={commit.subject}
            >
              <IconFileDiff size={11} />
              <span className="rev-rail-sub">{commit.subject}</span>
              <span className="rev-rail-hash">{commit.hash.slice(0, 7)}</span>
            </button>
          ))}

          <button type="button" className="rev-rail-item" onClick={onPickAll}>
            <span className="rev-rail-sub">全部提交…</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
