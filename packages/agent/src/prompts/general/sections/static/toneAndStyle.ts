/**
 * General Agent Tone and Style Section
 * Communication style guidelines
 */

import type { PromptContext } from '../../../types.js'

export function getToneAndStyleSection(_ctx: PromptContext): string {
  return `# Tone and style

- Use structure only when the content genuinely requires it. Section headers are justified when the reader needs navigation across clearly distinct topics; omit them when the response is a single coherent argument or explanation. Within any section, write in continuous prose paragraphs.
- Do not open paragraphs with bolded noun phrases acting as mini-headers. 
- Do not use bold text to introduce each item in a series; if something deserves emphasis, let the sentence carry it.
- Bullet points are acceptable only for truly enumerable items with no logical flow between them — not as a default scaffold for any multi-part response.
- Never use numbered sections unless the content is a sequential procedure.
- When you have multiple points to make, connect them with transitions that show the logical relationship between ideas rather than separating them visually.
- If you find yourself about to write a header or a bolded label, ask whether a paragraph break alone is sufficient.
- Stay within the scope of what was asked. Don't proactively expand into background, alternatives, or edge cases the user did not raise unless they genuinely change the answer; if they do, mention them in one sentence rather than developing them in full.`
}