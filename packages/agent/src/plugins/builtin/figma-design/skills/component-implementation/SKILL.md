# Component Implementation

Turn a Figma node into a working frontend component. This skill
consumes the context from `design-context-extraction` and the mapping
from `design-system-mapping`, then writes the actual component file(s)
in the project's framework (React, Vue, Svelte, etc.).

## When to use

- The user says "implement this Figma frame as a React component" /
  "build this card from the design".
- A screen-level frame needs to be broken into child components and
  implemented in the project's existing structure.
- The user wants a one-off prototype component from a Figma node,
  separate from the design system.

## Process

1. Read the extracted Figma context and the mapping report. Confirm
   the target framework (React/Vue/Svelte), styling approach (CSS
   modules / Tailwind / styled-components), and file layout
   (`src/components/`, `src/ui/`, etc.).
2. For each Figma node identified as a new component:
   - Pick a file path consistent with the project's conventions. Do
     not invent new top-level directories.
   - Compose existing primitives (from the mapping) before writing
     new markup. Reuse `Button`, `Input`, `Card`, etc. instead of
     re-implementing them.
   - Apply design tokens (CSS variables, Tailwind classes) from the
     mapping — never hardcode color or spacing literals that have a
     token equivalent.
3. For text content, prefer the literal from Figma unless the user
   flagged it as placeholder. Mark placeholders explicitly
   (`{t('cta.submit')}` for i18n, or `TODO: replace copy`).
4. For assets (icons, images), reference the paths produced by
   `design-context-extraction`. Do not inline base64 in the
   component.
5. Run the project's typecheck and lint on the new file before
   reporting done. Fix obvious issues; surface non-obvious ones to
   the user.
6. Hand off to `visual-comparison` to verify the rendered result
   matches the Figma source.

## Tool call patterns

- Use the workspace file edit tools to write the component. Keep
  diffs minimal — one component per file unless the project
  convention groups related components.
- If the Figma node uses a variant property not present in the code
  component, extend the code component's prop union rather than
  forking. Surface the extension in the report.
- For responsive designs, prefer container queries (or the project's
  existing responsive primitive) over hardcoded breakpoints. The
  Figma frame often has separate layouts per breakpoint — implement
  them as responsive variants, not separate components.

## Confirmation boundary

- Reading the Figma context and the codebase: `read` tier,
  automatic.
- Writing the new component file: `write` tier, confirm with the
  user before the first write. Show the proposed file path and a
  one-line summary of the component shape.
- Modifying an existing shared component (extending its props,
  changing its token mapping): `modify` tier, confirm. Show the
  diff to the user before applying.
- Deleting or renaming an existing component to make room for the
  new one: `destructive` tier, strong explicit confirmation. Avoid
  unless the user explicitly asked.

## Pitfalls

- Figma frames often have absolute positioning that does not
  translate to the web. Translate to flex / grid based on the
  frame's intent, not the literal coordinates.
- Auto-layout in Figma maps cleanly to flexbox, but gap values and
  padding may need token rounding (e.g. Figma `12.5px` → token
  `spacing-3` if the system uses 4px grid).
- Component instances in Figma may override main-component props.
  Read the instance overrides from `get_code` and apply them as
  explicit props on the code component, not as new variants.
- Do not inline Figma comment text as production copy. Designers
  leave notes in frames that should never ship.
- `figma.get_code` may return pseudo-code for complex nodes. Treat
  it as a hint about hierarchy, not as a literal code template.
