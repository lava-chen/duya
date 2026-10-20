"use client";

/**
 * RemoveProjectConfirm — Plan 547 Phase 4b.
 *
 * Shared confirm modal for the "delete project" menu action used by both the
 * sidebar `ProjectGroupItem` ⋯ menu and the projects page "移除项目" menu.
 *
 * Replaces the previous window.confirm() flow with an explicit, locale-aware
 * dialog that:
 *   - Shows the project name + paths count + sessions count (the user can
 *     audit exactly what will be lost before clicking through).
 *   - Has a checkbox "also delete all sessions under this project" that the
 *     user must opt into for the cascade delete.
 *   - Defaults to "keep sessions" (project entity only) — the safe default.
 *
 * Visual: matches the existing settings / dialog vocabulary (rounded card,
 * var(--surface) / var(--border), primary + ghost buttons). The checkbox
 * uses the same accent color as the page header select-all chip.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import type { ProjectEntity } from "@/stores/projects-store";
import {
  getSessionIdsUnderProject,
  deleteProjectAndSessions,
  deleteProject,
} from "@/lib/project-actions";
import { useProjectsStore } from "@/stores/projects-store";

interface RemoveProjectConfirmProps {
  open: boolean;
  project: ProjectEntity | null;
  onCancel: () => void;
  onSuccess?: (alsoDeletedSessions: number) => void;
  onFailure?: (reason: string) => void;
}

export function RemoveProjectConfirm({
  open,
  project,
  onCancel,
  onSuccess,
  onFailure,
}: RemoveProjectConfirmProps) {
  const { t } = useTranslation();
  const [alsoDeleteSessions, setAlsoDeleteSessions] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Reset the checkbox each time the dialog re-opens so the user always
  // starts from the safe "keep sessions" default.
  useEffect(() => {
    if (open) setAlsoDeleteSessions(false);
  }, [open]);

  if (!open || !project) return null;

  const invalidate = useProjectsStore.getState().invalidate;
  const sessionIds = getSessionIdsUnderProject(project);
  const sessionsCount = sessionIds.length;
  const pathsCount = project.paths.length;

  const handleConfirm = async () => {
    setSubmitting(true);
    try {
      if (alsoDeleteSessions) {
        const result = await deleteProjectAndSessions(project);
        if (!result.projectDeleted) {
          onFailure?.("project-delete-failed");
          return;
        }
        invalidate();
        onSuccess?.(result.sessionsDeleted);
      } else {
        const ok = await deleteProject(project);
        if (!ok) {
          onFailure?.("project-delete-failed");
          return;
        }
        invalidate();
        onSuccess?.(0);
      }
    } finally {
      setSubmitting(false);
      onCancel();
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="remove-project-confirm-title"
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
          id="remove-project-confirm-title"
          className="text-base font-semibold"
          style={{ color: "var(--text)" }}
        >
          {t("projects.removeProjectConfirm", {
            name: project.name,
            pathsCount,
            sessionsCount,
          })}
        </h2>

        <label
          className="flex items-start gap-2 cursor-pointer select-none"
          style={{ color: "var(--text)" }}
        >
          <input
            type="checkbox"
            checked={alsoDeleteSessions}
            disabled={sessionsCount === 0}
            onChange={(e) => setAlsoDeleteSessions(e.target.checked)}
            style={{ marginTop: 2 }}
          />
          <span className="text-sm">
            {t("projects.removeProjectDeleteSessions")}
          </span>
        </label>

        <p className="text-xs" style={{ color: "var(--muted)" }}>
          {sessionsCount === 0
            ? t("projects.removeProjectSessionsHint", { count: 0 })
            : t("project.removeProjectSessionsHint", { count: sessionsCount })}
        </p>

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
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
            onClick={handleConfirm}
            disabled={submitting}
            className="px-3 py-1.5 rounded-md text-sm font-medium"
            style={{
              backgroundColor: "var(--error, #d9534f)",
              color: "white",
              opacity: submitting ? 0.7 : 1,
            }}
          >
            {t("projects.removeProject")}
          </button>
        </div>
      </div>
    </div>
  );
}