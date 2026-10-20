/**
 * prefill-chat-input-event.ts - Plan 311 Phase 2.
 *
 * Dispatch helper for pre-filling the chat input box with a workflow
 * template prompt. The prompt is visible and editable — it is NOT
 * auto-sent. The user reviews it in the input box and presses Enter
 * when ready.
 *
 * Usage (from Capabilities detail page or any panel):
 *
 *   dispatchPrefillChatInput("Run a literature review on …");
 *
 * `MessageInput.tsx` listens for the event and writes the value into
 * the input box. When the chat view is not yet mounted (e.g. the user
 * is on the settings page), the value is stashed as a pending prefill
 * and consumed on the next `MessageInput` mount.
 */

export const PREFILL_CHAT_INPUT_EVENT = 'duya:prefill-chat-input';

export interface PrefillChatInputDetail {
  value: string;
}

// Module-level stash so a dispatch that happens before `MessageInput`
// mounts (e.g. from the settings page right before the view switches
// to chat) is not lost. `MessageInput` calls `consumePendingPrefill()`
// on mount and clears the stash.
let pendingPrefill: string | null = null;

export function dispatchPrefillChatInput(value: string): void {
  if (typeof window === 'undefined') return;
  pendingPrefill = value;
  window.dispatchEvent(
    new CustomEvent<PrefillChatInputDetail>(PREFILL_CHAT_INPUT_EVENT, {
      detail: { value },
    }),
  );
}

/**
 * Read and clear the pending prefill. Called by `MessageInput` on
 * mount so a dispatch that arrived while the component was unmounted
 * is still honored.
 */
export function consumePendingPrefill(): string | null {
  const v = pendingPrefill;
  pendingPrefill = null;
  return v;
}
