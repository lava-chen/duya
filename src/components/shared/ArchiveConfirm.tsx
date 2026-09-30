"use client";

/**
 * ArchiveConfirm — Plan 582 (G9).
 *
 * The confirm step for archiving a session. Archiving used to fire straight
 * from the row menu with no confirmation at all, which is a problem now that
 * the operation is a batch: `db:session:archive` takes the session's whole
 * spawn subtree with it, so one click on a parent conversation files away
 * every sub-agent session underneath it too.
 *
 * The copy states what actually happens rather than what a generic "are you
 * sure?" would imply. All three of these were true in the code and none of
 * them were visible anywhere in the UI:
 *
 *   - Archiving is reversible ("取消归档" restores the files and the row).
 *   - Archiving also archives every sub-agent session spawned by this one
 *     (G2 widened the unit of work to the subtree).
 *   - Archiving moves the conversation files on disk, into an `archived/`
 *     bucket — it is not just a status flag.
 *
 * The reverse case — DELETE — is deliberately NOT routed through a dialog
 * here. `db:session:delete` is a soft delete (`status='deleted'`, no cascade)
 * with no undo path in the renderer, so it is a different promise than
 * archive and gets its own wording at its own call site rather than sharing
 * a component that would have to lie about one of them.
 */

import { useTranslation } from "@/hooks/useTranslation";

interface ArchiveConfirmProps {
  open: boolean;
  /** Session title, shown so the user can see which row they clicked. */
  title: string;
  /** Number of sub-agent sessions that will be archived alongside it. */
  childCount: number;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}

export function ArchiveConfirm({
  open,
  title,
  childCount,
  onCancel,
  onConfirm,
}: ArchiveConfirmProps) {
  const { t } = useTranslation();

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="archive-confirm-title"
      data-testid="archive-confirm"
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.45)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="flex flex-col gap-3 rounded-xl p-5 shadow-xl"
        style={{
          backgroundColor: "var(--surface)",
          border: "1px solid var(--border)",
          color: "var(--text)",
          minWidth: 360,
          maxWidth: 480,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="archive-confirm-title"
          className="text-base font-semibold"
          style={{ color: "var(--text)" }}
        >
          {t("thread.archiveConfirmTitle")}
        </h2>

        <p className="text-sm" style={{ color: "var(--text)" }}>
          {t("thread.archiveConfirmBody", { title: title || t("thread.newThread") })}
        </p>

        <p className="text-xs" style={{ color: "var(--muted)" }}>
          {childCount > 0
            ? t("thread.archiveConfirmWithChildren", { count: childCount })
            : t("thread.archiveConfirmHint")}
        </p>

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 rounded-md text-sm"
            style={{
              backgroundColor: "transparent",
              border: "1px solid var(--border)",
              color: "var(--text)",
            }}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            data-testid="archive-confirm-ok"
            onClick={() => void onConfirm()}
            className="px-3 py-1.5 rounded-md text-sm font-medium"
            style={{
              backgroundColor: "var(--accent)",
              color: "var(--bg-canvas, white)",
            }}
          >
            {t("thread.archiveConfirmAction")}
          </button>
        </div>
      </div>
    </div>
  );
}
