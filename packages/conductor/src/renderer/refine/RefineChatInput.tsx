"use client";

import { useState } from "react";
import { PaperPlaneTilt, Stop } from "@phosphor-icons/react";

interface RefineChatInputProps {
  disabled: boolean;
  running: boolean;
  onSend: (request: string) => void;
  onStop: () => void;
}

export function RefineChatInput({ disabled, running, onSend, onStop }: RefineChatInputProps) {
  const [value, setValue] = useState("");

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setValue("");
  };

  return (
    <div className="border-t border-[var(--border)] p-2 flex flex-col gap-2">
      <textarea
        data-testid="refine-chat-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        disabled={disabled}
        placeholder={
          running
            ? "Agent is iterating…"
            : "Describe the change (e.g. \"add 3 cooking tasks\", \"mark all done\")"
        }
        rows={2}
        className="w-full resize-none rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-xs text-[var(--text)] placeholder:text-[var(--muted)] placeholder:opacity-60 outline-none focus:border-[var(--accent)] disabled:opacity-50"
      />
      <div className="flex items-center justify-end gap-1.5">
        {running && (
          <button
            type="button"
            data-testid="refine-stop"
            onClick={onStop}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] text-[var(--error)] hover:bg-[var(--error-soft)] transition-colors"
          >
            <Stop size={10} weight="fill" />
            Stop
          </button>
        )}
        <button
          type="button"
          data-testid="refine-send"
          onClick={submit}
          disabled={disabled || !value.trim()}
          className="flex items-center gap-1 px-2 py-1 rounded-md bg-[var(--accent)] text-white text-[10px] hover:opacity-90 disabled:opacity-40 transition-opacity"
        >
          <PaperPlaneTilt size={10} weight="fill" />
          Send
        </button>
      </div>
    </div>
  );
}