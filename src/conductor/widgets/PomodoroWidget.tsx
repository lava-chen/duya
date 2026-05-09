"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { WidgetComponentProps } from "./registry";
import { Play, Pause, ArrowClockwise } from "@phosphor-icons/react";

export function PomodoroWidget({ data, onChange, readOnly }: WidgetComponentProps) {
  const duration = ((data.duration as number) || 25) * 60; // minutes to seconds
  const [timeLeft, setTimeLeft] = useState(duration);
  const [isRunning, setIsRunning] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (isRunning) {
      intervalRef.current = setInterval(() => {
        setTimeLeft((prev) => {
          if (prev <= 1) {
            setIsRunning(false);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isRunning]);

  const toggle = useCallback(() => {
    if (readOnly) return;
    setIsRunning((prev) => !prev);
  }, [readOnly]);

  const reset = useCallback(() => {
    setIsRunning(false);
    setTimeLeft(duration);
  }, [duration]);

  const minutes = Math.floor(timeLeft / 60);
  const seconds = timeLeft % 60;
  const display = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

  const progress = 1 - timeLeft / duration;
  const circleLen = 283; // 2 * PI * 45
  const offset = circleLen - progress * circleLen;

  return (
    <div className="flex flex-col items-center justify-center gap-3 h-full">
      <div className="relative">
        <svg width="110" height="110" viewBox="0 0 110 110">
          <circle
            cx="55"
            cy="55"
            r="45"
            fill="none"
            stroke="var(--border)"
            strokeWidth="6"
          />
          <circle
            cx="55"
            cy="55"
            r="45"
            fill="none"
            stroke="var(--accent)"
            strokeWidth="6"
            strokeDasharray={circleLen}
            strokeDashoffset={offset}
            strokeLinecap="round"
            transform="rotate(-90 55 55)"
            style={{ transition: "stroke-dashoffset 0.5s ease" }}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-xl font-mono font-bold text-[var(--text)] tabular-nums">
            {display}
          </span>
        </div>
      </div>

      {!readOnly && (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={toggle}
            className="flex items-center justify-center w-9 h-9 rounded-full bg-[var(--accent)] text-white hover:opacity-90 transition-opacity"
          >
            {isRunning ? <Pause size={16} weight="fill" /> : <Play size={16} weight="fill" />}
          </button>
          <button
            type="button"
            onClick={reset}
            className="flex items-center justify-center w-8 h-8 rounded-full border border-[var(--border)] text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors"
          >
            <ArrowClockwise size={14} />
          </button>
        </div>
      )}

      {readOnly && (
        <span className="text-xs text-[var(--muted)]">
          {duration / 60} min focus
        </span>
      )}
    </div>
  );
}

export const PomodoroDefinition = {
  kind: "builtin" as const,
  type: "pomodoro",
  label: "Pomodoro Timer",
  component: PomodoroWidget,
  defaultData: { duration: 25 },
  defaultConfig: { title: "🍅 番茄钟" },
  defaultSize: { w: 3, h: 3 },
  minSize: { w: 2, h: 2 },
};
