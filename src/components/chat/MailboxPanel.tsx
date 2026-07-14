/**
 * MailboxPanel.tsx - AgentMailbox message list (Plan202)
 *
 * Renders a clean stash-style list of queued mailbox messages above the
 * StreamingInputBar. The panel is intentionally headerless — the user
 * asked for a "list of messages, no toolbar" pattern. All row-level
 * actions (guide / delete / more) live on each MailboxBubble.
 *
 * PR1: show + per-row guide/delete/more
 * PR2: claim/observe/apply
 */

"use client";

import React, { useEffect, useCallback, useMemo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useShallow } from "zustand/react/shallow";
import {
  useMailboxStore,
  type MailboxRow,
  type MailboxKind,
  type MailboxStatus,
} from "@/stores/mailbox-store";
import { MailboxBubble } from "./MailboxBubble";

interface MailboxPanelProps {
  sessionId: string;
  /**
   * Optional callback for the "more" menu on a single row (reclassify, etc).
   */
  onMore?: (row: MailboxRow) => void;
  /**
   * Optional override for the rows. When provided, the panel skips
   * the zustand store subscription and renders the supplied rows.
   * Useful for Storybook and tests where the IPC-backed store is
   * unavailable.
   */
  rowsOverride?: MailboxRow[];
}

const VISIBLE_STATUSES: MailboxStatus[] = ["pending", "observed"];

export function MailboxPanel({
  sessionId,
  onMore,
  rowsOverride,
}: MailboxPanelProps) {
  const storeRows = useMailboxStore(
    useShallow((state) => state.getBySession(sessionId)),
  );
  const rows = rowsOverride ?? storeRows;

  const list = useMailboxStore((state) => state.list);
  const cancel = useMailboxStore((state) => state.cancel);
  const edit = useMailboxStore((state) => state.edit);
  const guide = useMailboxStore((state) => state.guide);

  // Initial load + refetch on session change
  useEffect(() => {
    void list(sessionId, { limit: 100 });
  }, [sessionId, list]);

  const visibleRows = useMemo(
    () =>
      rows.filter((r) => VISIBLE_STATUSES.includes(r.status)),
    [rows],
  );

  const handleEdit = useCallback(
    (id: string, patch: { content?: string; kind?: MailboxKind }) => {
      void edit(id, patch);
    },
    [edit],
  );

  const handleCancel = useCallback(
    (id: string) => {
      void cancel(id, "user_cancelled_via_bubble");
    },
    [cancel],
  );

  const handleGuide = useCallback(
    async (row: MailboxRow) => {
      await guide(row.id);
    },
    [guide],
  );

  if (visibleRows.length === 0) return null;

  return (
    <div className="mailbox-panel-wrapper">
      <div className="mailbox-panel">
        {/* Body — list of queued messages. No header toolbar by design. */}
        <AnimatePresence initial={false}>
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <div className="mailbox-panel-body">
              {visibleRows.map((row) => (
                <MailboxBubble
                  key={row.id}
                  row={row}
                  onEdit={handleEdit}
                  onCancel={handleCancel}
                  onGuide={handleGuide}
                  onMore={onMore}
                />
              ))}
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
