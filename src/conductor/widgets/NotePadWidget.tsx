"use client";

import { useCallback } from "react";
import type { WidgetComponentProps } from "./registry";
import { Note } from "@phosphor-icons/react";

export function NotePadWidget({ data, onChange, readOnly }: WidgetComponentProps) {
  const content = (data.content as string) || "";
  const title = (data.title as string) || "";

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onChange({ ...data, content: e.target.value });
    },
    [data, onChange]
  );

  return (
    <div className="flex flex-col gap-2 h-full">
      {title && (
        <div className="flex items-center gap-1.5 text-[10px] text-[var(--muted)]">
          <Note size={10} />
          <span>{title}</span>
        </div>
      )}
      <textarea
        value={content}
        onChange={handleChange}
        readOnly={readOnly}
        placeholder={readOnly ? "" : "Write down your thoughts..."}
        className="w-full flex-1 bg-transparent border-none outline-none resize-none text-xs text-[var(--text)] placeholder:text-[var(--muted)] placeholder:opacity-40 leading-relaxed min-h-[60px]"
      />
    </div>
  );
}

export const NotePadDefinition = {
  kind: "builtin" as const,
  type: "note-pad",
  label: "Note Pad",
  component: NotePadWidget,
  defaultData: { content: "", title: "" },
  defaultConfig: { title: "📝 记事本" },
  defaultSize: { w: 4, h: 3 },
  minSize: { w: 2, h: 2 },
};
