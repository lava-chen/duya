# agent-face

Animated agent avatar: bloub's morphing character engine wearing a fixed duya
superellipse tile. Used wherever an agent needs a living face — workflow agent
nodes, bot contacts, sidebars.

## Layout (flat, no engine/ subdirectory)

**Ported verbatim from bloub** (`E:\cloned-projects\bloub\src\bot`, framework-free,
French comments kept as-is so the files stay diffable against upstream):
`math.ts`, `profiles.ts`, `shape.ts`, `face.ts`, `expressions.ts`, `decor.ts`,
`states.ts`, `skins.ts`, `eyefit.ts`, `engine.ts`.

**duya-side code (English comments):**
- `tile.ts` — the fixed superellipse body (24x20, ratio 1.2, exponent 2.8),
  the identity color ring, and eye-fit registration.
- `clock.ts` — one shared rAF clock for all mounted faces.
- `status.ts` — duya run status -> engine state / rest mood mapping.
- `AgentFace.tsx` — the React shell: engine per face, frames applied to SVG
  attributes via refs (no React re-render while animating), IntersectionObserver
  pulls offscreen faces off the clock.

## Two copies of this engine — deliberately not merged

`apps/desktop/src/renderer/orb/bot/` holds the same bloub engine, and a
duplication sweep flagged it for convergence. It was reviewed and **left
alone on purpose**:

- This copy is the newer one. `git --follow` on the shared files shows
  `components/agent-face/` as the destination of the move, and the engine
  files here are a verbatim port of bloub with French comments kept intact.
- The two have diverged on the duya side in opposite directions. `orb/bot/`
  grew `repere.ts` and `pointer-mood.ts` (orb-specific pointer tracking);
  `agent-face/` grew `tile.ts`, `clock.ts`, `status.ts` and `AgentFace.tsx`
  (the fixed superellipse and the shared clock).
- Merging them would therefore produce a union that neither copy's upstream
  can be diffed against — a superset, not a convergence. Two ports of one
  small vendored engine is a smaller cost than losing diffability against
  upstream.

Revisit this only if one of the two call sites is retired.

## Adaptations vs upstream

- `eyefit.ts` adds `registerEyeFitShape(radii)`: upstream builds its eye-offset
  table only from the `SHAPES` catalogue; our superellipse registers itself at
  import time (see `tile.ts`), keyed by array reference like upstream.
- Bloub's customizer (shape/color/expression picking, cycles, export) is not
  ported: our shape is fixed by `tile.ts`, colors come from `AGENT_FACE_COLORS`,
  and state selection goes through `status.ts`.
- Dots' depth haze approximates bloub's paper-mix without resolving the paper
  color (our backing defaults to transparent so eye holes adapt to any surface).

## Usage

```tsx
import { AgentFace, AGENT_FACE_COLORS } from "@/components/agent-face/AgentFace";

<AgentFace status="running" size={20} color={AGENT_FACE_COLORS[avatarIndex % 9]} />
```

Catalog animations beyond the status mapping (`thinking`, `notify`, `burst`, ...)
can be triggered with the `state` prop; see `states.ts` for the full list.
