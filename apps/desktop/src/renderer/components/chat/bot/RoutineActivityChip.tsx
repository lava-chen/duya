import { useTranslation } from "@/hooks/useTranslation";
import { ClockCounterClockwiseIcon } from "@/components/icons";
import type { RoutineActivityMeta } from "@/types/message";

/**
 * Routine lifecycle chip in the bot-direct transcript (same bare centered
 * structure as the DM/channel chips — no pill background, no shadow): one
 * chip per routine create/update/pause/resume/delete marker row, clock icon
 * in front, not clickable — the details live on the automation page.
 */
export function RoutineActivityChip({ meta }: { meta: RoutineActivityMeta }) {
  const { t } = useTranslation();
  const key =
    meta.action === "created"
      ? "bot.routine.chipCreated"
      : meta.action === "updated"
        ? "bot.routine.chipUpdated"
        : meta.action === "deleted"
          ? "bot.routine.chipDeleted"
          : meta.action === "paused"
            ? "bot.routine.chipPaused"
            : "bot.routine.chipResumed";

  return (
    <div className="bot-chat-dm-chip-wrap">
      <span className="bot-chat-channel-chip bot-chat-routine-chip">
        <span className="bot-chat-channel-chip__icons bot-chat-routine-chip__icon" aria-hidden="true">
          <ClockCounterClockwiseIcon size={14} />
        </span>
        <span className="bot-chat-channel-chip__text">
          {t(key, { name: meta.name })}
        </span>
      </span>
    </div>
  );
}
