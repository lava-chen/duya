"use client";

import { useState, useEffect } from "react";
import { SpinnerIcon } from "@/components/icons";

interface UpdateState {
  phase: "idle" | "downloading" | "progress" | "ready";
  version?: string;
  percent?: number;
  releaseNotes?: string;
}

export function UpdateBadge() {
  const [state, setState] = useState<UpdateState>({ phase: "idle" });

  useEffect(() => {
    const handleDownloading = (data: { version: string }) => {
      setState({ phase: "downloading", version: data.version });
    };

    const handleProgress = (data: { percent: number }) => {
      setState((s) => ({
        ...s,
        phase: "progress",
        percent: data.percent,
      }));
    };

    const handleReady = (data: { version: string; releaseNotes?: string }) => {
      setState({
        phase: "ready",
        version: data.version,
        releaseNotes: data.releaseNotes,
      });
    };

    const removeDownloading = window.electronAPI?.updater?.onDownloading?.(handleDownloading);
    const removeProgress = window.electronAPI?.updater?.onProgress?.(handleProgress);
    const removeReady = window.electronAPI?.updater?.onReady?.(handleReady);

    return () => {
      removeDownloading?.();
      removeProgress?.();
      removeReady?.();
    };
  }, []);

  if (state.phase === "idle") return null;

  if (state.phase === "downloading" || state.phase === "progress") {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <SpinnerIcon className="w-3 h-3 animate-spin" />
        {state.phase === "progress" && state.percent !== undefined
          ? `${state.percent}%`
          : "下载更新中"}
      </div>
    );
  }

  if (state.phase === "ready") {
    return (
      <button
        onClick={() => window.electronAPI?.updater?.install?.()}
        className="flex items-center gap-1 text-xs text-[var(--accent)] hover:opacity-80 transition-opacity"
        title={state.releaseNotes || ""}
      >
        <span>↑</span>
        <span>
          {state.version} 已就绪，点击重启安装
        </span>
      </button>
    );
  }

  return null;
}
