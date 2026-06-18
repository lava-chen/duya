"use client";

interface DiffPreviewProps {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export function DiffPreview({ before, after }: DiffPreviewProps) {
  if (!before || !after) return null;

  const keys = Array.from(
    new Set([...Object.keys(before), ...Object.keys(after)]),
  ).sort();

  return (
    <div
      data-testid="refine-diff-preview"
      className="grid grid-cols-2 gap-2 text-[10px] font-mono"
    >
      <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
        <div className="px-2 py-1 bg-[var(--main-bg)] border-b border-[var(--border)] text-[var(--muted)]">
          before
        </div>
        <pre className="p-2 overflow-auto max-h-40">
          {keys
            .map((k) => `${k}: ${JSON.stringify(before[k])}`)
            .join("\n")}
        </pre>
      </div>
      <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
        <div className="px-2 py-1 bg-[var(--main-bg)] border-b border-[var(--border)] text-[var(--muted)]">
          after
        </div>
        <pre className="p-2 overflow-auto max-h-40">
          {keys
            .map((k) => {
              const same = JSON.stringify(before[k]) === JSON.stringify(after[k]);
              return same
                ? `${k}: ${JSON.stringify(after[k])}`
                : `${k}: ${JSON.stringify(after[k])} ←`;
            })
            .join("\n")}
        </pre>
      </div>
    </div>
  );
}