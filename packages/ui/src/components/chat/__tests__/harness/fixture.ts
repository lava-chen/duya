/**
 * Deterministic fixture for the streaming-render benchmark.
 *
 * Same bytes on every run so before/after numbers are comparable:
 *   - REPLY: one long assistant reply (prose + table + 3 fenced code blocks)
 *   - TOOLS / TOOL_STORM: tool calls interleaved into the reply
 *   - CHUNK: characters emitted per animation frame
 */

export const CHUNK = 20;

const CODE_TS = `import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

export interface Route {
  method: string;
  path: string;
  handler: (ctx: Ctx) => Promise<Response>;
}

export function createRouter(routes: Route[]) {
  const table = new Map<string, Route>();
  for (const route of routes) {
    table.set(\`\${route.method} \${route.path}\`, route);
  }
  return async function dispatch(req: Request): Promise<Response> {
    const route = table.get(\`\${req.method} \${new URL(req.url).pathname}\`);
    if (!route) return new Response('not found', { status: 404 });
    return route.handler({ req, res: createServer() });
  };
}`;

const CODE_PY = `from dataclasses import dataclass
from typing import Iterable


@dataclass(frozen=True)
class Window:
    start: int
    end: int

    def overlaps(self, other: "Window") -> bool:
        return self.start < other.end and other.start < self.end


def merge(windows: Iterable[Window]) -> list[Window]:
    out: list[Window] = []
    for w in sorted(windows, key=lambda x: x.start):
        if out and w.start <= out[-1].end:
            out[-1] = Window(out[-1].start, max(out[-1].end, w.end))
        else:
            out.append(w)
    return out`;

const CODE_BASH = `set -euo pipefail

npm run typecheck:all
npm run architecture:check
npx vitest run packages/ui/src/components/chat

echo "perf-streaming fixture build ok"`;

export const REPLY = `## Streaming render profile

The renderer currently re-parses the whole markdown document on every
animation frame while a reply is still growing. This fixture reproduces
the shape of a real answer: a heading, several prose paragraphs, a table,
and three fenced code blocks of different languages.

### Why the cost grows

Every token that arrives extends the trailing text block. The block is
re-parsed from scratch, every code fence inside it is re-tokenized and
re-highlighted, and the resulting React tree is reconciled against the
previous one. The work per frame therefore grows with the length of the
reply, which is the quadratic behaviour we want to remove.

| Phase | Cost per frame | Scales with |
| --- | --- | --- |
| Markdown parse | high | document length |
| Syntax highlight | high | sum of code length |
| React reconcile | medium | node count |

The table above is itself part of the markdown, so it is re-parsed too.

### A first code block

\`\`\`ts
${CODE_TS}
\`\`\`

### A second code block

\`\`\`python
${CODE_PY}
\`\`\`

The prose between the fences keeps growing, so both fences above are
complete but still sit inside the block that is being re-rendered.

### A third code block

\`\`\`bash
${CODE_BASH}
\`\`\`

### Closing notes

- The stable prefix of a reply should not be re-parsed.
- Completed code fences should not be re-highlighted.
- Tool rows that already finished should not re-render.

Final paragraph so the fixture ends with prose rather than a fence.
`;

export interface ToolFixture {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result: string;
}

/** Tool calls interleaved into the reply, in stream order. */
export const TOOLS: ToolFixture[] = [
  {
    id: 'toolu_01',
    name: 'Bash',
    input: { command: 'npm run typecheck:all' },
    result: 'exit 0\ntypecheck passed in 41s',
  },
  {
    id: 'toolu_02',
    name: 'Read',
    input: { file_path: 'packages/ui/src/components/chat/MarkdownRenderer.tsx' },
    result: 'Read 371 lines from packages/ui/src/components/chat/MarkdownRenderer.tsx',
  },
  {
    id: 'toolu_03',
    name: 'Edit',
    input: { file_path: 'packages/ui/src/components/chat/CodeBlock.tsx' },
    result: 'Applied 1 edit to packages/ui/src/components/chat/CodeBlock.tsx',
  },
  {
    id: 'toolu_04',
    name: 'Bash',
    input: { command: 'npx vitest run packages/ui/src/components/chat' },
    result: 'exit 0\nTest Files 12 passed (12)',
  },
  {
    id: 'toolu_05',
    name: 'Grep',
    input: { pattern: 'ReactMarkdown', path: 'packages/ui/src' },
    result: 'packages/ui/src/components/chat/MarkdownRenderer.tsx:377',
  },
  {
    id: 'toolu_06',
    name: 'Bash',
    input: { command: 'npm run architecture:check' },
    result: 'exit 0\narchitecture baseline unchanged',
  },
  {
    id: 'toolu_07',
    name: 'Read',
    input: { file_path: 'packages/ui/src/components/chat/StreamingMessage.tsx' },
    result: 'Read 410 lines from packages/ui/src/components/chat/StreamingMessage.tsx',
  },
  {
    id: 'toolu_08',
    name: 'Bash',
    input: { command: 'git status --short' },
    result: 'exit 0\n M packages/ui/src/components/chat/CodeBlock.tsx',
  },
];

/** A burst of tool events — the `perf/stream-tool-storm` fixture. */
export const TOOL_STORM: ToolFixture[] = Array.from({ length: 40 }, (_, index) => ({
  id: `toolu_storm_${String(index + 1).padStart(3, '0')}`,
  name: index % 3 === 0 ? 'Bash' : index % 3 === 1 ? 'Read' : 'Grep',
  input:
    index % 3 === 0
      ? { command: `npm run test -- --filter ${index}` }
      : index % 3 === 1
        ? { file_path: `packages/ui/src/components/chat/File${index}.tsx` }
        : { pattern: `symbol${index}`, path: 'packages/ui/src' },
  result: `exit 0\nstorm tool ${index} finished`,
}));
