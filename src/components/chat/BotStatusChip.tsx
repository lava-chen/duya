/**
 * BotStatusChip — Compact pill label for tool_use / thinking status.
 * Used as a slim inline status indicator before a tool expands.
 * Inspired by grok-bot's sand-outline-item + sand-status-chip pattern.
 */
export function BotStatusChip({
  label,
  icon,
  status = "default",
  className = "bot-chat-status-chip",
}: {
  label: string;
  icon?: React.ReactNode;
  status?: "pending" | "failed" | "default";
  className?: string;
}) {
  return (
    <span className={`${className} ${status === "pending" ? "bot-chat-status-chip--pending" : ""} ${status === "failed" ? "bot-chat-status-chip--failed" : ""}`}>
      {icon && <span className="bot-chat-status-chip__icon">{icon}</span>}
      {label}
    </span>
  );
}
