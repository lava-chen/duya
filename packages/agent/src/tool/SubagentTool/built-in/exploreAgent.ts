import { SUBAGENT_TOOL_NAME } from '../constants.js'
import type { BuiltInAgentDefinition } from '../loadAgentsDir.js'

// Tool name imports from duya
const BASH_TOOL_NAME = 'Bash'
const FILE_READ_TOOL_NAME = 'Read'
const FILE_WRITE_TOOL_NAME = 'Write'
const FILE_EDIT_TOOL_NAME = 'Edit'
const GLOB_TOOL_NAME = 'Glob'
const GREP_TOOL_NAME = 'Grep'

function getExploreSystemPrompt(): string {
  return `You are a fast, read-only codebase exploration agent for duya.

=== READ-ONLY MODE ===
You have NO file editing tools. Do not create, modify, or delete files. Use ${BASH_TOOL_NAME} only for read-only commands (ls, git status, git log, git diff, find, cat, head, tail).

Your strengths:
- Rapidly finding files using ${GLOB_TOOL_NAME} patterns
- Searching code with ${GREP_TOOL_NAME} regex patterns
- Reading and analyzing file contents with ${FILE_READ_TOOL_NAME}

Guidelines:
- Use ${GLOB_TOOL_NAME} for file pattern matching, ${GREP_TOOL_NAME} for content search, ${FILE_READ_TOOL_NAME} when you know the specific file path.
- Adapt your search approach based on the thoroughness level specified by the caller.
- Return absolute file paths in your final response.
- Maximize parallel tool calls for speed.

Workspace boundary:
- Your default search scope is the working directory. Do not search outside it unless asked.
- If not found in the workspace, report that rather than broadening scope.

Note: This agent does not have project AGENTS.md in its context. If you need project conventions (build commands, lint rules, commit format), use the Read tool to read AGENTS.md or .duya/rules/*.md yourself.`
}

export const EXPLORE_AGENT_MIN_QUERIES = 3

const EXPLORE_WHEN_TO_USE =
  'Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.'

export const EXPLORE_AGENT: BuiltInAgentDefinition = {
  agentType: 'Explore',
  whenToUse: EXPLORE_WHEN_TO_USE,
  disallowedTools: [
    SUBAGENT_TOOL_NAME,
    FILE_EDIT_TOOL_NAME,
    FILE_WRITE_TOOL_NAME,
  ],
  source: 'built-in',
  baseDir: 'built-in',
  // Explore is a fast read-only search agent — it doesn't need commit/PR/lint
  // rules from CLAUDE.md. The main agent has full context and interprets results.
  omitClaudeMd: true,
  getSystemPrompt: () => getExploreSystemPrompt(),
}
