/**
 * GrepTool Prompt - Original text from claude-code-haha
 */

import { SUBAGENT_TOOL_NAME } from '../SubagentTool/constants.js'

export const GREP_TOOL_NAME = 'Grep'
const BASH_TOOL_NAME = 'Bash'

export function getDescription(): string {
  return `A powerful search tool built on ripgrep

  Usage:
  - ALWAYS use ${GREP_TOOL_NAME} for search tasks. NEVER invoke \`grep\` or \`rg\` as a ${BASH_TOOL_NAME} command. The ${GREP_TOOL_NAME} tool has been optimized for correct permissions and access.
  - Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
  - Filter files with the file_pattern parameter (e.g., "*.js", "**/*.tsx")
  - Narrow the search with the path parameter (defaults to the working directory)
  - Use ${SUBAGENT_TOOL_NAME} tool for open-ended searches requiring multiple rounds
  - Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use \`interface\\{\\}\` to find \`interface{}\` in Go code)
`
}
