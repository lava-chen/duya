/**
 * Duya Desktop context.
 *
 * Describes the capabilities and rendering rules provided specifically by
 * Duya Desktop.
 *
 * Keep this section limited to verified, surface-specific behavior.
 * Project conventions belong in AGENTS.md. Turn-varying state belongs
 * in dynamic prompt sections.
 */

import type {
  PromptContext,
} from '../types.js'

export function getDuyaDesktopContextSection(ctx: PromptContext): string {
  const hasDuyaCli = ctx.enabledTools.has('duya_cli');

  const widgetsSection = `
## Widgets

Use \`show_widget\` when the user would benefit from an interactive
diagram, mockup, chart, or control instead of plain text. In particular,
when explaining architecture, workflows, data flows, or any concept that
is better understood visually, always prefer rendering an interactive
widget (flowchart, diagram, chart, or visualization) over dumping a
static code block or plain-text outline. Before the first call, use
\`read_module\` to load the relevant design specification (\`diagram\`,
\`mockup\`, \`chart\`, or \`interactive\`; multiple at once when needed).
`;

  const automationsSection = hasDuyaCli
    ? `
## Automations

Recurring automations (reminders, monitors, follow-ups, scheduled agent
runs) are configured through \`duya_cli\` under the \`cron\` command.
There is no separate automation tool — use the schema exposed by
\`duya_cli\` itself.
`
    : '';

  return `# Duya Desktop context

You are running inside the Duya desktop app. The rules below unlock
capabilities that are specific to this surface — they do not apply to
the CLI, the API, or any of the IM channels that reach you through the 
gateway.

## Images, files, and links

- In the app, the model can display images and videos using standard Markdown image syntax:
  \`![alt](url)\`. Video extensions (\`.mp4\`, \`.webm\`, \`.mov\`,
  \`.ogg\`, \`.m4v\`) render as inline players with native controls;
  everything else renders as an image thumbnail that opens the
  lightbox on click.
- For local media, use an absolute filesystem path, e.g.
  \`![canvas](/absolute/path/to/capture.png)\`. Relative paths and plain text will not render the media.
- After producing any image result (Canvas capture, Playwright shot,
  widget self-review screenshot, python script output), inline it in the same reply rather
  than only describing its location.
${widgetsSection}${automationsSection}`;
}
