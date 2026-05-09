"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  CaretRightIcon,
  CheckIcon,
  CircleIcon,
  SpinnerIcon,
} from "@/components/icons";
import { useConversationStore } from "@/stores/conversation-store";

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
  pending: <CircleIcon size={10} className="text-muted-foreground/40" />,
  in_progress: <SpinnerIcon size={10} className="text-accent animate-spin" />,
  completed: <CheckIcon size={10} className="text-green-500" />,
};

const statusColors: Record<Task["status"], string> = {
  pending: "text-muted-foreground/60",
  in_progress: "text-foreground font-medium",
  completed: "text-muted-foreground/40 line-through",
};

export function TaskListPanel() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [loading, setLoading] = useState(false);
  const hasInProgressRef = useRef(false);

  const activeThreadId = useConversationStore((s) => s.activeThreadId);

  const fetchTasks = useCallback(async () => {
    if (!activeThreadId) {
      setTasks([]);
      return;
    }
    setLoading(true);
    try {
      const raw = await window.electronAPI?.thread?.getTasks?.(activeThreadId);
      if (raw) {
        const parsed = (raw as Task[]).map((t) => ({
          ...t,
          blocks: t.blocks || [],
          blockedBy: t.blockedBy || [],
        }));
        setTasks(parsed);
        hasInProgressRef.current = parsed.some(
          (t) => t.status === "in_progress"
        );
      } else {
        setTasks([]);
      }
    } catch (err) {
      console.error("[TaskListPanel] fetch failed:", err);
    } finally {
      setLoading(false);
    }
  }, [activeThreadId]);

  useEffect(() => {
    fetchTasks();
    const interval = setInterval(() => {
      if (hasInProgressRef.current) fetchTasks();
    }, 2000);
    return () => clearInterval(interval);
  }, [fetchTasks]);

  if (tasks.length === 0 && !loading) return null;

  const completed = tasks.filter((t) => t.status === "completed").length;
  const inProgress = tasks.filter((t) => t.status === "in_progress").length;

  return (
    <div style={{ borderBottom: "1px solid var(--border)" }}>
      {/* Header */}
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex items-center gap-1.5 w-full px-3 py-2 text-[11px] hover:bg-muted/20 transition-colors"
      >
        <CaretRightIcon
          size={10}
          className={`text-muted-foreground transition-transform duration-200 ${
            collapsed ? "" : "rotate-90"
          }`}
        />
        <span className="text-muted-foreground uppercase tracking-wider">
          <span className="font-medium text-foreground">{tasks.length}</span>{" "}
          tasks
        </span>
        {completed > 0 && (
          <span className="text-[10px] text-green-500/80 ml-auto">
            {completed} done
          </span>
        )}
        {inProgress > 0 && !completed && (
          <span className="text-[10px] text-accent/80 ml-auto">
            {inProgress} active
          </span>
        )}
      </button>

      {/* Task list */}
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <div className="px-3 pb-2 space-y-0.5 max-h-[200px] overflow-y-auto scrollbar-thin">
              {tasks.map((task) => (
                <div
                  key={task.id}
                  className="flex items-center gap-1.5 py-0.5 px-1.5 rounded hover:bg-muted/15 transition-colors"
                  title={task.description}
                >
                  <span className="shrink-0">{statusIcons[task.status]}</span>
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
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
