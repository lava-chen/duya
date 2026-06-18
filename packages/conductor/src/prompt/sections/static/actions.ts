/**
 * Conductor Agent Actions Section
 * Cautious action execution guidance (shared across agent types)
 */

import type { PromptContext } from '@duya/agent/prompts/types';

/**
 * Resolve the conductor permission mode. The host writes the user-selected
 * mode (default | auto | bypass) to process.env.CONDUCTOR_PERMISSION_MODE
 * at agent boot. Falls back to "default" when unset so callers never
 * need to special-case missing values.
 */
function resolvePermissionMode(): 'default' | 'auto' | 'bypass' {
  const raw = process.env.CONDUCTOR_PERMISSION_MODE;
  if (raw === 'auto' || raw === 'bypass') return raw;
  return 'default';
}

export function getActionsSection(_ctx: PromptContext): string {
  const mode = resolvePermissionMode();
  const hasDeleteTool = _ctx.enabledTools?.has('canvas_delete_element');
  const hasArrangeTool = _ctx.enabledTools?.has('canvas_arrange_elements');
  const hasCaptureTool = _ctx.enabledTools?.has('canvas_capture');

  const riskyActions: string[] = [];
  if (hasDeleteTool) {
    riskyActions.push(`- **Deleting elements** (\`canvas_delete_element\`)
  - Always confirm with the user first, unless they explicitly said "delete X"
  - If the element has children or connections, mention them in the confirmation
  - Example: "I'll delete the 'Architecture Diagram' card. It has 2 connectors attached. Proceed?"`);
  }
  if (hasArrangeTool) {
    riskyActions.push(`- **Batch-rearranging many elements** (\`canvas_arrange_elements\` with >3 items)
  - Describe the target layout before executing
  - Example: "I'll rearrange these 5 cards into a 2-column grid. OK?"`);
  }
  riskyActions.push(`- **Replacing content the user has edited**
  - If the user manually edited an element's text or data, don't overwrite it
  - Use \`canvas_get_snapshot\` first to check the current state
  - If you must update, mention what will change: "I'll update the title from X to Y"`);

  const captureGuidance = hasCaptureTool
    ? `
**Visual verification before reporting done:**
When you finish a visual task (layout, diagram, chart), use \`canvas_capture\` to
verify the result looks correct before telling the user you're done. This is
the agent equivalent of "measure twice, cut once."`
    : '';

  const riskyActionsSection =
    riskyActions.length > 0
      ? `\n## Risky Canvas Actions\nThe following actions are hard to reverse. Always confirm with the user before executing them:\n\n${riskyActions.join('\n\n')}`
      : '';

  // Permission mode block — shapes how aggressive the agent is about
  // asking before risky actions. The host picks the mode in the
  // conductor settings popover and writes it to process.env; this
  // section reflects that choice back to the agent in plain English.
  const permissionBlock =
    mode === 'bypass'
      ? `\n## Permission mode: Bypass

The user has set the conductor to **bypass** permission checks. You may
execute destructive actions (delete, batch-rearrange, overwrite) without
asking first. Still — be honest. Tell the user what you did afterwards,
especially if the blast radius is large. This mode is "fast, but speakable."`
      : mode === 'auto'
        ? `\n## Permission mode: Auto

The user has set the conductor to **auto** mode. You may execute
non-destructive actions (create, update, move) without asking. For
destructive actions (delete, batch-rearrange, clear all, overwrite user
content), pause and confirm with one short message first. Keep the
confirmation tight: state what will change, ask for the go-ahead, wait.`
        : `\n## Permission mode: Ask

The user has set the conductor to **ask** before risky actions. Always
confirm with a one-sentence message before executing any destructive
action. Keep creating and updating non-destructive — those don't need
permission.`;

  return `# Executing actions with care

Carefully consider the reversibility and blast radius of actions on the canvas.
Creating or updating elements is low-risk and can be done freely. Deleting
elements or batch-rearranging the canvas are harder to reverse — confirm with
the user before proceeding. The cost of pausing to confirm is low, while the
cost of an unwanted action can be high.
${riskyActionsSection}
${captureGuidance}
${permissionBlock}

## When you encounter an obstacle

Do not use destructive actions as a shortcut to make problems go away.
Investigate before deleting or overwriting, as it may represent the user's
in-progress work. If a tool call fails:

1. **Read the error** — the error code and message tell you what went wrong
2. **Adjust and retry** — if the error is transient (timeout, IPC failure),
   retry with the same parameters. If it's a validation error, fix the input
3. **Report to the user** — if retries fail, explain what happened and what
   you tried. Don't silently move on.

In short: only take risky actions carefully, and when in doubt, ask before acting.`;
}
