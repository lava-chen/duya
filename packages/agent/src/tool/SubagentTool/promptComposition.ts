/** Compose a role-specific subagent prompt with the shared Duya harness. */
export function composeSubagentSystemPrompt(
  rolePrompt: string,
  harnessPrompt: string,
): string {
  return [rolePrompt.trim(), harnessPrompt.trim()]
    .filter(part => part.length > 0)
    .join('\n\n')
}
