"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconChevronDown, IconGitCompare, IconSearch } from "@/components/icons";
import { getGitBranches } from "@/lib/git-ipc";
import type { GitBranchRef, GitCommitInfo, GitListBranchesResult } from "@/contracts/git";

export type ReviewScopeKind = "uncommitted" | "unstaged" | "staged" | "commit";

export interface ScopeSelection {
  scope: ReviewScopeKind;
  commitFrom: string;
  commitTo: string;
  /** Human label for the left side of the header (e.g. "master"). */
  baseLabel: string;
}

export interface ReviewScopePickerProps {
  workingDirectory: string;
  scope: ReviewScopeKind;
  baseLabel: string;
  /** Localised scope name for the trigger (e.g. "未提交 (HEAD → 工作区)"). */
  scopeLabel?: string;
  headLabel: string;
  commits: GitCommitInfo[];
  commitFrom: string;
  commitTo: string;
  onApply: (selection: ScopeSelection) => void;
}

/**
 * The `base › head` control that replaces the old native <select> chain.
 *
 * Branch comparison is expressed as a commit range: every ref carries its
 * head sha, so picking `master` as the base is `commitFrom = master.head`,
 * `commitTo = currentBranch.head`. That keeps the whole feature on the
 * existing `git:review-scoped` handler — no new IPC.
 */
export function ReviewScopePicker({
  workingDirectory,
  scope,
  baseLabel,
  scopeLabel,
  headLabel,
  commits,
  commitFrom,
  commitTo,
  onApply,
}: ReviewScopePickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [branches, setBranches] = useState<GitListBranchesResult | null>(null);
  const [loading, setLoading] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  useEffect(() => {
    if (!open || branches || !workingDirectory) return;
    let alive = true;
    setLoading(true);
    getGitBranches(workingDirectory)
      .then((result) => {
        if (alive) setBranches(result);
      })
      .catch(() => {
        if (alive) setBranches({ isGitRepo: false, locals: [], remotes: [] });
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, branches, workingDirectory]);

  const locals = useMemo(() => {
    const list = branches?.locals ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((branch) => branch.name.toLowerCase().includes(q));
  }, [branches, query]);

  const currentHead = useMemo<GitBranchRef | undefined>(() => {
    const list = branches?.locals ?? [];
    return list.find((branch) => branch.current) ?? list[0];
  }, [branches]);

  const applyBranchCompare = useCallback(
    (branch: GitBranchRef) => {
      if (!currentHead) return;
      onApply({
        scope: "commit",
        commitFrom: branch.head,
        commitTo: currentHead.head,
        baseLabel: branch.name,
      });
      close();
    },
    [close, currentHead, onApply],
  );

  const label = scopeLabel ?? (scope === "commit"
    ? `${baseLabel} › ${headLabel || currentHead?.name || ""}`
    : scope === "staged"
      ? "已暂存的更改"
      : scope === "unstaged"
        ? "未暂存的更改"
        : "未提交的更改");

  return (
    <div className="rev-scope" ref={rootRef}>
      <button
        type="button"
        className={`rev-scope-trigger${open ? " is-open" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="审阅范围"
        title="切换审查范围"
        onClick={() => setOpen((value) => !value)}
      >
        <IconGitCompare size={15} />
        <span className="rev-scope-label">{label}</span>
        <IconChevronDown size={12} className="rev-scope-chevron" />
      </button>

      {open ? (
        <div className="rev-picker" role="dialog" aria-label="审查范围">
          <div className="rev-picker-search">
            <IconSearch size={12} />
            <input
              value={query}
              spellCheck={false}
              placeholder="搜索分支"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          <div className="rev-picker-group">范围</div>
          <button
            type="button"
            className={`rev-picker-item${scope === "uncommitted" ? " is-on" : ""}`}
            aria-label="范围：所有更改"
            onClick={() => {
              onApply({ scope: "uncommitted", commitFrom, commitTo, baseLabel: "未提交的更改" });
              close();
            }}
          >
            所有更改
          </button>
          <button
            type="button"
            className={`rev-picker-item${scope === "staged" ? " is-on" : ""}`}
            aria-label="范围：已暂存"
            onClick={() => {
              onApply({ scope: "staged", commitFrom, commitTo, baseLabel: "已暂存的更改" });
              close();
            }}
          >
            已暂存的更改
          </button>
          <button
            type="button"
            className={`rev-picker-item${scope === "unstaged" ? " is-on" : ""}`}
            aria-label="范围：未暂存"
            onClick={() => {
              onApply({ scope: "unstaged", commitFrom, commitTo, baseLabel: "未暂存的更改" });
              close();
            }}
          >
            未暂存的更改
          </button>

          <button
            type="button"
            className={`rev-picker-item${scope === "commit" ? " is-on" : ""}`}
            aria-label="范围：指定提交"
            onClick={() => {
              onApply({ scope: "commit", commitFrom, commitTo, baseLabel });
            }}
          >
            指定提交…
          </button>

          <div className="rev-picker-group">对比分支</div>
          <div className="rev-picker-list">
            {loading ? <div className="rev-picker-empty">读取分支…</div> : null}
            {!loading && locals.length === 0 ? (
              <div className="rev-picker-empty">没有可对比的分支</div>
            ) : null}
            {locals.map((branch) => (
              <button
                key={branch.name}
                type="button"
                className={`rev-picker-item${branch.name === baseLabel ? " is-on" : ""}`}
                onClick={() => applyBranchCompare(branch)}
              >
                <span className="rev-picker-name">{branch.name}</span>
                {branch.current ? <span className="rev-picker-tag">当前</span> : null}
                {branch.name === "master" ? <span className="rev-picker-tag">默认</span> : null}
              </button>
            ))}
          </div>

          {commits.length > 0 ? (
            <>
              <div className="rev-picker-group">提交范围</div>
              <div className="rev-picker-commits">
                <select
                  value={commitFrom}
                  aria-label="起始提交"
                  onChange={(event) => onApply({ scope: "commit", commitFrom: event.target.value, commitTo, baseLabel })}
                >
                  {commits.map((commit) => (
                    <option key={commit.hash} value={commit.hash}>
                      {commit.hash.slice(0, 7)} {commit.subject}
                    </option>
                  ))}
                </select>
                <select
                  value={commitTo}
                  aria-label="目标提交"
                  onChange={(event) => onApply({ scope: "commit", commitFrom, commitTo: event.target.value, baseLabel })}
                >
                  {commits.map((commit) => (
                    <option key={commit.hash} value={commit.hash}>
                      {commit.hash.slice(0, 7)} {commit.subject}
                    </option>
                  ))}
                </select>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
