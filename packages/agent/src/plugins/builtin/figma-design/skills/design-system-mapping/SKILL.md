# Design System Mapping

Map Figma components and styles to the project's existing component
library and design tokens. Use this skill after `design-context-extraction`
has loaded the Figma context and before `component-implementation`
writes any code — the mapping decides whether a Figma node becomes a
new component, a variant of an existing one, or a one-off layout.

## When to use

- The user is implementing a Figma frame and asks "do we already have
  a component for this?".
- A design audit needs to verify that the Figma library and the code
  library are in sync.
- `component-implementation` needs to know which existing primitives
  (Button, Card, Input) to reuse before composing a new screen.

## Process

1. Read the extracted Figma context (output of
   `design-context-extraction`). Identify the Figma component
   instances and their main-component definitions.
2. Read the project's component inventory. Look for `package.json`
   (or equivalent) and the component directory (`src/components/`,
   `src/ui/`, etc.). Build a list of existing components by name and
   prop signature.
3. For each Figma component, propose a mapping:
   - **Direct reuse** — Figma main component matches an existing code
     component by name and prop shape.
   - **Variant** — Figma main component is a new variant of an
     existing code component (e.g. a `size="lg"` version).
   - **New component** — no match in code; needs to be created.
   - **One-off layout** — not a component, just composed primitives.
4. Map Figma styles (color, text, effect) to the project's design
   tokens (CSS custom properties, Tailwind config, theme file). Flag
   any Figma style that has no matching token — that is a token gap
   to resolve with the designer.
5. Report the mapping as a table: Figma component → code component /
   new / one-off, plus the token mapping. Surface conflicts the
   designer needs to resolve before implementation begins.

## Tool call patterns

- `figma.list_components(file_key)` returns the Figma component
  inventory. Use it to cross-check rather than relying on the
  extraction output alone.
- `figma.list_styles(file_key)` returns text / color / effect styles.
  Pair with `figma.get_variable_defs` — styles and variables are
  related but distinct in Figma.
- Use the workspace file tools to read the code component inventory.
  Do not import components at runtime to introspect them — read the
  source files.

## Confirmation boundary

All activity in this skill is `read` tier because it only reads
Figma metadata and the local codebase. If the user asks to record
the mapping as a markdown file in the repo, treat that as `write`
and confirm the path first.

## Pitfalls

- Figma component names follow designer conventions; code component
  names follow the framework's. `Button/Primary/Large` in Figma may
  map to `<Button variant="primary" size="lg">` in code. Match on
  semantics, not on the literal name.
- Variant properties in Figma are flat strings; code props are often
  typed unions. Note type mismatches in the report so the
  implementation skill can address them.
- A Figma "component" may actually be a frame the designer forgot to
  publish as a main component. Flag these so the designer can fix
  the source rather than the implementer working around it.
- Tokens can be defined as Figma variables, Figma styles, or both.
  Prefer variables (resolved by `get_variable_defs`) over styles
  when both exist — variables carry mode information.
