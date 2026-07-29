/**
 * Concise usage guidance injected when the Skill tool becomes available.
 * The dynamic Skills section owns the catalog so it is never duplicated here.
 */

export const COMMAND_NAME_TAG = 'command-name';

export function getPrompt(): string {
  return `Load instructions for one skill listed in the current Skills catalog.

Use an exact catalog name and optional arguments. The result contains the skill's full instructions; follow them only after it is returned. Do not invoke a skill merely because its name is adjacent to the task, and do not claim to have used one unless this tool was called.

If a <${COMMAND_NAME_TAG}> tag is already present in the current turn, that skill is loaded; follow its instructions rather than loading it again.`;
}
