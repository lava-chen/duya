import type { BotSessionPhase } from './bot/use-bot-session-phase';

/**
 * BotTypingIndicator — Shows different states for bot session activity.
 *
 * Plan 491 P0.3: Bot session state machine.
 *
 * States:
 *   - streaming: Three bouncing dots (Telegram-style)
 *   - thinking:  "思考中..." with a subtle pulse
 *   - tool:      "使用工具中..." with tool activity indicator
 *   - waiting_approval: "等待确认..." with clock/pause icon
 *   - error:     "错误" with error icon
 *
 * For 'idle', this component should not be rendered at all.
 */
export function BotTypingIndicator({
  className = 'bot-chat-typing',
  phase = 'streaming',
}: {
  className?: string;
  phase?: BotSessionPhase;
}) {
  // idle should not render - caller should conditionally render
  if (phase === 'idle') {
    return null;
  }

  // Error state
  if (phase === 'error') {
    return (
      <div className={`${className} ${className}--error`} aria-hidden="true" role="status">
        <span className={`${className}__error-icon`}>⚠</span>
        <span className={`${className}__text`}>错误</span>
      </div>
    );
  }

  // Waiting for approval
  if (phase === 'waiting_approval') {
    return (
      <div className={`${className} ${className}--waiting`} aria-hidden="true" role="status">
        <span className={`${className}__wait-icon`}>⏸</span>
        <span className={`${className}__text`}>等待确认...</span>
      </div>
    );
  }

  // Tool state
  if (phase === 'tool') {
    return (
      <div className={`${className} ${className}--tool`} aria-hidden="true" role="status">
        <span className={`${className}__tool-icon`}>⚙</span>
        <span className={`${className}__text`}>使用工具中...</span>
      </div>
    );
  }

  // Thinking state
  if (phase === 'thinking') {
    return (
      <div className={`${className} ${className}--thinking`} aria-hidden="true" role="status">
        <span className={`${className}__thinking-dots`}>...</span>
        <span className={`${className}__text`}>思考中</span>
      </div>
    );
  }

  // Default: streaming (three bouncing dots)
  return (
    <div className={className} aria-hidden="true" role="status">
      <span />
      <span />
      <span />
    </div>
  );
}
