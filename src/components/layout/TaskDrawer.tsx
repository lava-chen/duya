"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  CaretRightIcon,
  CheckIcon,
  CircleIcon,
  SpinnerIcon,
  PlusIcon,
  TrashIcon,
  ArrowCounterClockwiseIcon,
  XIcon,
} from "@/components/icons";
import { useConversationStore } from "@/stores/conversation-store";
import { setTaskDrawerOpen, useTaskDrawerOpen } from "./task-drawer-store";

interface Task {
  id: string;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
  owner?: string;
  blocks: string[];
  blockedBy: string[];
}

const statusIcons: Record<Task["status"], React.ReactNode> = {
  pending: <CircleIcon size={12} className="text-muted-foreground/40" />,
  in_progress: <SpinnerIcon size={12} className="text-accent animate-spin" />,
  completed: <CheckIcon size={12} className="text-green-500" />,
};

const statusColors: Record<Task["status"], string> = {
  pending: "text-muted-foreground/80",
  in_progress: "text-foreground font-medium",
  completed: "text-muted-foreground/40 line-through",
};

const POLL_INTERVAL_MS = 1000;

export function useTaskList(threadId: string | null) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchTasks = useCallback(async () => {
    if (!threadId) {
      setTasks([]);
      return;
    }
    setLoading(true);
    try {
      const raw = await window.electronAPI?.thread?.getTasks?.(threadId);
      if (raw) {
        const parsed = (raw as Task[]).map((t) => ({
          ...t,
          blocks: t.blocks || [],
          blockedBy: t.blockedBy || [],
        }));
        setTasks(parsed);
      } else {
        setTasks([]);
      }
    } catch (err) {
      console.error("[TaskDrawer] fetch failed:", err);
    } finally {
      setLoading(false);
    }
  }, [threadId]);

  useEffect(() => {
    setTasks([]);
    void fetchTasks();
  }, [threadId, fetchTasks]);

  return { tasks, setTasks, loading, fetchTasks };
}

export function TaskDrawer() {
  const open = useTaskDrawerOpen();
  const onClose = useCallback(() => setTaskDrawerOpen(false), []);
  const activeThreadId = useConversationStore((s) => s.activeThreadId);
  const { tasks, setTasks, loading, fetchTasks } = useTaskList(open ? activeThreadId : null);

  const [collapsed, setCollapsed] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [draftSubject, setDraftSubject] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Always-on polling while drawer is open. Cheaper than the old
  // hasInProgressRef gate (which missed pending→in_progress transitions
  // and made the UI feel stale).
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => {
      void fetchTasks();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [open, fetchTasks]);

  // ESC to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const handleAddTask = useCallback(async () => {
    const subject = draftSubject.trim();
    const description = draftDescription.trim();
    if (!subject || !activeThreadId || submitting) return;
    setSubmitting(true);
    try {
      await window.electronAPI?.thread?.createTask?.({
        id: crypto.randomUUID(),
        session_id: activeThreadId,
        subject,
        description: description || subject,
      });
      setDraftSubject("");
      setDraftDescription("");
      setComposerOpen(false);
      await fetchTasks();
    } catch (err) {
      console.error("[TaskDrawer] createTask failed:", err);
    } finally {
      setSubmitting(false);
    }
  }, [draftSubject, draftDescription, activeThreadId, submitting, fetchTasks]);

  const handleToggleStatus = useCallback(
    async (task: Task) => {
      const next = task.status === "completed" ? "pending" : "completed";
      // Optimistic update so the row reflects the new state immediately,
      // even if the IPC roundtrip is slow.
      setTasks((prev) =>
        prev.map((t) => (t.id === task.id ? { ...t, status: next } : t))
      );
      try {
        await window.electronAPI?.thread?.updateTask?.(task.id, { status: next });
        void fetchTasks();
      } catch (err) {
        console.error("[TaskDrawer] updateTask failed:", err);
        // Revert on failure.
        setTasks((prev) =>
          prev.map((t) => (t.id === task.id ? { ...t, status: task.status } : t))
        );
      }
    },
    [fetchTasks, setTasks]
  );

  const handleDelete = useCallback(
    async (task: Task) => {
      setTasks((prev) => prev.filter((t) => t.id !== task.id));
      try {
        await window.electronAPI?.thread?.deleteTask?.(task.id);
      } catch (err) {
        console.error("[TaskDrawer] deleteTask failed:", err);
        void fetchTasks();
      }
    },
    [fetchTasks, setTasks]
  );

  const completed = tasks.filter((t) => t.status === "completed").length;
  const pending = tasks.length - completed;

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-40 bg-black/30"
            onClick={onClose}
            aria-hidden
          />
          <motion.aside
            key="drawer"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "tween", duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="fixed top-0 right-0 z-50 h-full flex flex-col"
            style={{
              width: 480,
              maxWidth: "92vw",
              background: "var(--bg-canvas)",
              borderLeft: "1px solid var(--border)",
              borderRadius: "12px 0 0 12px",
              boxShadow: "-8px 0 32px rgba(0,0,0,0.28)",
            }}
            role="dialog"
            aria-label="任务列表"
          >
            <DrawerHeader
              pending={pending}
              completed={completed}
              collapsed={collapsed}
              onToggleCollapsed={() => setCollapsed((c) => !c)}
              onAdd={() => setComposerOpen((v) => !v)}
              onClose={onClose}
            />

            <AnimatePresence initial={false}>
              {composerOpen && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.15, ease: "easeOut" }}
                  style={{ overflow: "hidden" }}
                >
                  <div
                    className="px-3 py-2 space-y-1.5"
                    style={{ borderBottom: "1px solid var(--border)" }}
                  >
                    <input
                      type="text"
                      value={draftSubject}
                      onChange={(e) => setDraftSubject(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          void handleAddTask();
                        }
                      }}
                      placeholder="Subject"
                      className="w-full bg-transparent text-xs text-foreground placeholder:text-muted-foreground/50 outline-none border border-border/50 rounded px-2 py-1 focus:border-accent"
                      autoFocus
                    />
                    <textarea
                      value={draftDescription}
                      onChange={(e) => setDraftDescription(e.target.value)}
                      placeholder="Description (optional)"
                      rows={2}
                      className="w-full bg-transparent text-[11px] text-foreground placeholder:text-muted-foreground/50 outline-none border border-border/50 rounded px-2 py-1 resize-none focus:border-accent"
                    />
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => void handleAddTask()}
                        disabled={!draftSubject.trim() || submitting}
                        className="px-2 py-0.5 text-[11px] rounded bg-accent text-accent-foreground disabled:opacity-40 hover:opacity-90 transition-opacity"
                      >
                        {submitting ? "Adding…" : "Add"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setComposerOpen(false);
                          setDraftSubject("");
                          setDraftDescription("");
                        }}
                        className="px-2 py-0.5 text-[11px] rounded text-muted-foreground hover:text-foreground transition-colors"
                      >
                        Cancel
                      </button>
                      <span className="text-[10px] text-muted-foreground/50 ml-auto">
                        Enter to add
                      </span>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
              {!collapsed && (
                <div className="px-2 py-1.5 space-y-0.5">
                  {tasks.length === 0 && !loading && (
                    <div className="text-[11px] text-muted-foreground/50 px-2 py-6 text-center">
                      No tasks. Click <span className="text-foreground/70">+ Task</span> to add one.
                    </div>
                  )}
                  {tasks.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      onToggleStatus={() => void handleToggleStatus(task)}
                      onDelete={() => void handleDelete(task)}
                    />
                  ))}
                </div>
              )}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

function DrawerHeader({
  pending,
  completed,
  collapsed,
  onToggleCollapsed,
  onAdd,
  onClose,
}: {
  pending: number;
  completed: number;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onAdd: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className="flex items-center gap-2 px-3 py-2.5"
      style={{ borderBottom: "1px solid var(--border)" }}
    >
      <button
        type="button"
        onClick={onToggleCollapsed}
        className="flex items-center gap-1.5 hover:bg-muted/20 transition-colors rounded px-1 -ml-1"
      >
        <CaretRightIcon
          size={10}
          className={`text-muted-foreground transition-transform duration-200 ${
            collapsed ? "" : "rotate-90"
          }`}
        />
        <span className="text-muted-foreground uppercase tracking-wider text-[11px]">
          <span className="font-medium text-foreground">{pending}</span> pending
        </span>
        {completed > 0 && (
          <span className="text-[10px] text-green-500/70">· {completed} done</span>
        )}
      </button>
      <button
        type="button"
        onClick={onAdd}
        className="ml-auto flex items-center gap-1 px-1.5 py-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
        title="Add task"
      >
        <PlusIcon size={12} />
        <span className="text-[10px]">Task</span>
      </button>
      <button
        type="button"
        onClick={onClose}
        className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
        title="Close"
        aria-label="Close"
      >
        <XIcon size={14} />
      </button>
    </div>
  );
}

function TaskRow({
  task,
  onToggleStatus,
  onDelete,
}: {
  task: Task;
  onToggleStatus: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className="group flex items-center gap-1.5 py-1 px-1.5 rounded hover:bg-muted/20 transition-colors"
      title={task.description}
    >
      <button
        type="button"
        onClick={onToggleStatus}
        className="shrink-0 hover:scale-110 transition-transform"
        title={task.status === "completed" ? "Reopen" : "Mark done"}
      >
        {statusIcons[task.status]}
      </button>
      <span
        className={`text-[11px] truncate flex-1 min-w-0 ${statusColors[task.status]}`}
      >
        {task.status === "in_progress" && task.activeForm
          ? task.activeForm
          : task.subject}
      </span>
      {task.owner && task.status !== "completed" && (
        <span className="text-[9px] text-muted-foreground/40 shrink-0">
          {task.owner}
        </span>
      )}
      {task.blockedBy.length > 0 && (
        <span className="text-[9px] text-orange-500/60 shrink-0">
          blocked
        </span>
      )}
      <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 shrink-0 transition-opacity">
        {task.status === "completed" ? (
          <button
            type="button"
            onClick={onToggleStatus}
            className="p-0.5 rounded text-muted-foreground hover:text-foreground"
            title="Reopen"
          >
            <ArrowCounterClockwiseIcon size={11} />
          </button>
        ) : null}
        <button
          type="button"
          onClick={onDelete}
          className="p-0.5 rounded text-muted-foreground hover:text-red-500"
          title="Delete"
        >
          <TrashIcon size={11} />
        </button>
      </div>
    </div>
  );
}
