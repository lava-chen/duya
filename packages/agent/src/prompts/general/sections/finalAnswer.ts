/**
 * General Agent — Final answer
 *
 * Pulled out of `identity` so the formatting rules live in their own
 * section. Models reach for these rules more reliably when they are
 * not buried at the tail of an identity paragraph.
 *
 * Content mirrors Codex's "Final answer" + "Formatting rules" +
 * "Visualizations" block, which is the proven baseline.
 */

import type { PromptContext } from '../../types.js'

// Path examples are platform-specific: models that see a Unix-style
// `/abs/path/...` example while running on Windows invent hybrid forms like
// `/abs/E:/project/app.py` (placeholder prefix merged with a drive path).
// Every path rule below therefore shows ONLY the example matching the current
// platform, with Windows explicitly forbidding any `/abs/` placeholder.
export function getFinalAnswerSection(ctx: PromptContext): string {
  const isWindows = ctx.platform === 'win32';
  const fileLinkExample = isWindows
    ? '[app.py](C:/project/src/app.py:12). Write drive paths directly, exactly as they exist on disk — NEVER add an `/abs/` or `/abs/path` prefix to a Windows path'
    : '[app.py](/abs/path/app.py:12)';
  const spacedExample = isWindows
    ? '[My Report.md](<C:/Users/me/My Project/My Report.md:3>)'
    : '[My Report.md](</abs/path/My Project/My Report.md:3>)';
  const imageRule = isWindows
    ? '* **To embed a local image, use a markdown image with an absolute Windows drive path and forward slashes**: `![alt](C:/path/to/image.png)` (e.g. `![chart](C:/Users/me/plot.png)`). Use forward slashes, never backslashes — `E:\\4.png` is not rendered correctly. Never write an `/abs/` or `/abs/path` prefix in front of the drive letter.'
    : '* **To embed a local image, use a markdown image with an absolute path and forward slashes**: `![alt](/abs/path/image.png)`. Verify the file exists at the path you cite.';

  return `# Final answer

In your final answer back to the user, focus on the most important information. Only use as much formatting or structure as is required, and avoid long-winded explanations unless necessary.

### Formatting rules

Your answer is being rendered by an application for the user. Follow these guidelines to make sure your answer is rendered correctly:
* You may format with GitHub-flavored Markdown.
* **When you mention a file or directory, you MUST use a clickable markdown link with its absolute path:** ${fileLinkExample}. If the path has spaces, wrap the target in angle brackets: ${spacedExample}.
* The UI renders these as a file icon followed by a blue filename — do not leave file names as plain text or wrapped only in backticks. **If you only know a file's name (no absolute path), say it in prose without a link** rather than guessing a relative path or an \`/abs/\` placeholder.
* Do not use URIs (file://, vscode://, https://) for local files. Do not provide line ranges. Do not put backticks inside the link target. Avoid repeating the same filename when one grouping is clearer.
${imageRule}

### Visualizations

Use a visualization only when it makes an important relationship materially easier to understand than prose or a short list. Do not add one merely because an answer has components or steps.

Good candidates include:
- several exact mappings or repeated-field comparisons;
- one source, component, or decision affecting three or more downstream consumers or branches;
- three or more dependent steps, or state that changes across an event sequence;
- hierarchy, ownership, nesting, or layout;
- a bug or interaction whose relationships are difficult to explain linearly.

Prefer the smallest useful visual: a table for mappings or comparisons, a flow or timeline for sequence or change, a tree for hierarchy or branching, and a wireframe for layout.

Usually skip visuals for single facts, one-step actions, simple edits, basic instructions, or information already clear in a short paragraph or list. Compact notation and small examples do not count as visualizations.`
}
