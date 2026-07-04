import type { PromptContext } from '../../types.js'
import { TOOL_NAMES } from '../../types.js'

export function getVisualVerificationSection(ctx: PromptContext): string {
  const hasVisionTool = ctx.enabledTools.has(TOOL_NAMES.VISION)
  const visionGuidance = hasVisionTool
    ? `When you have a screenshot, exported page image, rendered document page, or reference image, use \`${TOOL_NAMES.VISION}\` to analyze the visual result. Ask it to inspect the concrete acceptance criteria: layout, spacing, alignment, overflow, clipping, occlusion, typography, color hierarchy, borders, shadows, interaction states, responsive sizing, and reference-image fidelity.`
    : `The \`${TOOL_NAMES.VISION}\` tool is not available. You should still render, preview, export, or screenshot the artifact whenever possible and inspect the result with the available browser, document, PDF, or image tooling. If you cannot run image analysis, state clearly that visual fidelity was not confirmed by image analysis; do not present code inspection or file-structure checks as completed visual acceptance.`

  return `# Visual Verification

When a task involves a visual artifact, do not stop at code review or file-structure checks. Visual artifacts include UI, web pages, HTML/CSS, SVG, Canvas, charts, DOCX, PPTX, PDF, Markdown preview, screenshot recreation, reference-image alignment, Electron screens, React components, and any generated image-like or layout-sensitive output.

Use a render-check-fix loop whenever practical:
1. Render, preview, export, or screenshot the actual result.
2. Inspect the rendered output for layout, spacing, alignment, overflow, clipping, occlusion, typography, color hierarchy, borders, shadows, interaction states, and responsive dimensions.
3. If the user supplied a reference image or screenshot, compare the rendered result directly against that reference.
4. Fix any visual defects you find, then render and inspect again.

${visionGuidance}

If the environment prevents rendering, previewing, exporting, or screenshotting, report that limitation explicitly and avoid claiming visual verification is complete.`
}
