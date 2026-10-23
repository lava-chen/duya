/**
 * RecorderView — the recordings half of the workflow management surface
 * (plan 556 Phase 5).
 *
 * Reads recorder sessions back from disk and lets the user inspect the event timeline:
 *
 *   control strip   start / stop / discard a live recording, with the
 *                   same counters the always-on-top badge shows
 *   session list    one row per recording (started at / duration /
 *                   events / apps), opened for detail
 *   session detail  the event timeline, grouped by app. Rows expand into
 *                   recorded element metadata on demand.
 *
 * Privacy note surfaced in the UI: password fields arrive already
 * redacted (`<redacted>`) — the recorder redacts on the way to disk, so
 * this view can never show a captured password even if it wanted to.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { useTranslation } from "@/hooks/useTranslation";
import type { TranslationKey } from "@/i18n";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { EmptyState, PageCard } from "@/components/ui/page";
import {
  CaretDownIcon,
  CaretRightIcon,
  CursorClickIcon,
  GlobeIcon,
  IconRefresh,
  KeyIcon,
  ListChecksIcon,
  StopIcon,
  TextAaIcon,
  TrashIcon,
} from "@/components/icons";
import {
  cancelRecordingIPC,
  deleteRecorderSessionIPC,
  formatRecorderClock,
  formatRecorderDuration,
  getRecorderSessionIPC,
  getRecorderStatusIPC,
  listRecorderSessionsIPC,
  onRecorderStatusChangedIPC,
  startRecordingIPC,
  stopRecordingIPC,
} from "@/lib/recorder-ipc";
import type {
  LoadedRecorderSession,
  RecorderElement,
  RecorderEventView,
  RecorderSessionSummary,
  RecorderStatusSnapshot,
} from "@/lib/recorder-types";

type Busy = null | "start" | "stop" | "cancel" | "delete";


export function RecorderView() {
  const { t } = useTranslation();

  const [status, setStatus] = useState<RecorderStatusSnapshot | null>(null);
  const [sessions, setSessions] = useState<RecorderSessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<LoadedRecorderSession | null>(null);
  const [expandedRow, setExpandedRow] = useState<number | null>(null);


  const recording = status?.status === "recording" || status?.status === "starting";

  const loadSessions = useCallback(async () => {
    try {
      setSessions(await listRecorderSessionsIPC());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [snapshot] = await Promise.all([getRecorderStatusIPC(), loadSessions()]);
      if (cancelled) return;
      setStatus(snapshot);
      setLoading(false);
    })();
    // Live status: the main process pushes on every transition, so the
    // list only has to reload when a recording ENDS (new session on disk).
    const unsubscribe = onRecorderStatusChangedIPC((snapshot) => {
      setStatus((prev) => {
        if (prev && prev.status !== "idle" && snapshot.status === "idle") {
          void loadSessions();
        }
        return snapshot;
      });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [loadSessions]);

  // Live duration while recording (the pushed snapshot is transition-only).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [recording]);
  const liveDuration =
    status?.startedAt && recording ? now - status.startedAt : status?.durationMs ?? null;

  // ── actions ──

  const handleStart = async () => {
    setBusy("start");
    setError(null);
    const result = await startRecordingIPC();
    if (!result.ok) setError(result.error ?? "start failed");
    setStatus((await getRecorderStatusIPC()) ?? null);
    setBusy(null);
  };

  const handleStop = async () => {
    setBusy("stop");
    setError(null);
    const result = await stopRecordingIPC();
    if (!result.ok) setError(result.error ?? "stop failed");
    setStatus((await getRecorderStatusIPC()) ?? null);
    await loadSessions();
    setBusy(null);
  };

  const handleCancel = async () => {
    setBusy("cancel");
    setError(null);
    const result = await cancelRecordingIPC();
    if (!result.ok) setError(result.error ?? "cancel failed");
    setStatus((await getRecorderStatusIPC()) ?? null);
    await loadSessions();
    setBusy(null);
  };

  const openSession = async (sessionId: string) => {
    setSelectedId(sessionId);
    setDetail(null);
    setExpandedRow(null);
    setError(null);
    const loaded = await getRecorderSessionIPC(sessionId);
    if (!loaded) {
      setError(t("recorder.loading"));
      return;
    }
    setDetail(loaded);
  };

  const closeSession = () => {
    setSelectedId(null);
    setDetail(null);
  };

  const handleDelete = async (sessionId: string) => {
    if (!window.confirm(t("recorder.deleteConfirm"))) return;
    setBusy("delete");
    await deleteRecorderSessionIPC(sessionId);
    if (selectedId === sessionId) closeSession();
    await loadSessions();
    setBusy(null);
  };

  // ── timeline: group events by app ──

  const timeline = useMemo(() => buildTimeline(detail?.events ?? []), [detail]);

  return (
    <div className="flex flex-col gap-4">
      {/* ── control strip ── */}
      <PageCard padding="md" className="flex flex-wrap items-center gap-3">
        <span
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${
            recording ? "bg-red-500 animate-pulse" : "bg-[var(--border)]"
          }`}
        />
        <span className="text-sm font-semibold text-foreground">
          {recording ? t("recorder.recording") : t("recorder.idle")}
        </span>
        {recording && (
          <span className="text-xs text-muted-foreground">
            {formatRecorderDuration(liveDuration)} · {status?.eventCount ?? 0} {t("recorder.events")}
          </span>
        )}
        {status?.degraded && <span className="text-xs text-amber-500">{t("recorder.degraded")}</span>}

        <div className="ml-auto flex items-center gap-2">
          {recording ? (
            <>
              <Button variant="danger" size="sm" onClick={handleStop} disabled={busy !== null}>
                <StopIcon size={14} />
                {t("recorder.stop")}
              </Button>
              <Button variant="ghost" size="sm" onClick={handleCancel} disabled={busy !== null}>
                {t("recorder.cancel")}
              </Button>
            </>
          ) : (
            <Button variant="primary" size="sm" onClick={handleStart} disabled={busy !== null}>
              <CursorClickIcon size={14} />
              {t("recorder.start")}
            </Button>
          )}
        </div>
        {!recording && <p className="w-full text-xs text-muted-foreground">{t("recorder.idleHint")}</p>}
      </PageCard>

      {error && (
        <PageCard padding="md">
          <p className="text-xs text-error">{error}</p>
        </PageCard>
      )}

      {/* ── session list ── */}
      {!selectedId && (
        <PageCard padding="none">
          <div className="flex items-center gap-2 border-b border-border/50 px-4 py-2.5">
            <ListChecksIcon size={14} className="text-muted-foreground" />
            <span className="text-sm font-semibold text-foreground">{t("recorder.sessions")}</span>
            <span className="text-xs text-muted-foreground">· {sessions.length}</span>
            <div className="ml-auto">
              <IconButton aria-label={t("recorder.refresh")} size="sm" onClick={() => void loadSessions()}>
                <IconRefresh size={14} />
              </IconButton>
            </div>
          </div>

          {loading && <div className="px-4 py-6 text-xs text-muted-foreground">{t("recorder.loading")}</div>}

          {!loading && sessions.length === 0 && (
            <EmptyState
              icon={<CursorClickIcon size={24} />}
              title={t("recorder.empty")}
              description={t("recorder.emptyHint")}
            />
          )}

          {!loading &&
            sessions.map((session) => (
              <div
                key={session.sessionId}
                className="flex flex-wrap items-center gap-3 border-b border-border/50 px-4 py-2.5 last:border-b-0 hover:bg-[var(--surface-hover)]"
                data-testid={`recorder-session-${session.sessionId}`}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => void openSession(session.sessionId)}
                >
                  <div className="truncate text-sm font-medium text-foreground">
                    {new Date(session.startedAt).toLocaleString()}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>{formatRecorderDuration((session.endedAt ?? session.startedAt) - session.startedAt)}</span>
                    <span>
                      · {session.eventCount} {t("recorder.events")}
                    </span>
                    {session.apps.slice(0, 4).map((app) => (
                      <span key={app.processName} className="rounded bg-[var(--chip)] px-1.5 py-0.5">
                        {app.name || app.processName} · {app.hits}
                      </span>
                    ))}
                  </div>
                </button>
                <div className="flex shrink-0 items-center gap-1">
                  <Button variant="secondary" size="sm" onClick={() => void openSession(session.sessionId)}>
                    {t("recorder.view")}
                  </Button>
                  <IconButton
                    aria-label={t("recorder.delete")}
                    size="sm"
                    variant="danger"
                    onClick={() => void handleDelete(session.sessionId)}
                    disabled={busy !== null}
                  >
                    <TrashIcon size={14} />
                  </IconButton>
                </div>
              </div>
            ))}
        </PageCard>
      )}

      {/* ── session detail ── */}
      {selectedId && (
        <>
          <PageCard padding="md" className="flex flex-wrap items-center gap-3">
            <Button variant="ghost" size="sm" onClick={closeSession}>
              {t("recorder.back")}
            </Button>
            <span className="text-sm font-semibold text-foreground">{t("recorder.detail.title")}</span>
            {detail && (
              <span className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                <span className="font-mono">{detail.summary.sessionId}</span>
                <span>
                  {t("recorder.detail.duration")}{" "}
                  {formatRecorderDuration(
                    (detail.summary.endedAt ?? detail.summary.startedAt) - detail.summary.startedAt,
                  )}
                </span>
                <span>
                  {t("recorder.detail.count")} {detail.events.length}
                </span>
              </span>
            )}
            <div className="ml-auto flex items-center gap-2">
              <IconButton
                aria-label={t("recorder.delete")}
                size="sm"
                variant="danger"
                onClick={() => void handleDelete(selectedId)}
                disabled={busy !== null}
              >
                <TrashIcon size={14} />
              </IconButton>
            </div>
          </PageCard>

          {detail?.dropped.length ? (
            <PageCard padding="sm">
              <p className="text-xs text-amber-500">
                {t("recorder.detail.dropped").replace("{n}", String(detail.dropped.length))}
              </p>
            </PageCard>
          ) : null}

          {/* ── timeline ── */}
          <PageCard padding="none">
            <div className="flex items-center gap-2 border-b border-border/50 px-4 py-2.5">
              <ListChecksIcon size={14} className="text-muted-foreground" />
              <span className="text-sm font-semibold text-foreground">{t("recorder.detail.timeline")}</span>
              <span className="text-xs text-muted-foreground">· {detail?.events.length ?? 0}</span>
            </div>

            {!detail && <div className="px-4 py-6 text-xs text-muted-foreground">{t("recorder.loading")}</div>}
            {detail && detail.events.length === 0 && (
              <div className="px-4 py-6 text-xs text-muted-foreground">{t("recorder.detail.noEvents")}</div>
            )}

            {timeline.map((group) => (
              <div key={group.key}>
                <div className="flex items-center gap-2 bg-[var(--surface)] px-4 py-1.5 text-[11px] text-muted-foreground">
                  <GlobeIcon size={12} />
                  <span className="font-medium">{group.appLabel}</span>
                  <span>· {group.rows.length}</span>
                </div>
                {group.rows.map((row) => (
                  <EventRow
                    key={row.index}
                    row={row}
                    open={expandedRow === row.index}
                    onToggle={() => setExpandedRow(expandedRow === row.index ? null : row.index)}
                  />
                ))}
              </div>
            ))}
          </PageCard>
        </>
      )}
    </div>
  );
}

// ─── timeline pieces ───

interface TimelineRow {
  index: number;
  event: RecorderEventView;
}

interface TimelineGroup {
  key: string;
  appLabel: string;
  rows: TimelineRow[];
}

/** Group events by app, in arrival order. */
function buildTimeline(events: RecorderEventView[]): TimelineGroup[] {
  const groups: TimelineGroup[] = [];
  events.forEach((event, index) => {
    const label = event.app.name || event.app.processName || "unknown";
    const last = groups[groups.length - 1];
    if (last && last.appLabel === label) {
      last.rows.push({ index, event });
    } else {
      groups.push({ key: `${event.app.processName}-${index}`, appLabel: label, rows: [{ index, event }] });
    }
  });
  return groups;
}
