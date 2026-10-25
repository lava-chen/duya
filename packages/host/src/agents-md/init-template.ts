/**
 * packages/host/src/agents-md/init-template.ts
 *
 * The `/init` template — the `AGENTS.md` duya writes at the ROOT of a code
 * repository when the user asks the app to "initialize" it.
 *
 * ## Why this is NOT the project AGENTS.md
 *
 * `apps/desktop/src/main/db/core/projectService.ts` seeds
 * `~/.duya/projects/<projectId>/AGENTS.md` — duya's own project metadata
 * directory, describing duya's plan toolchain. That file belongs to duya.
 * This one belongs to the USER's repository and is read by every agent that
 * opens the checkout. Different audience, different content, different
 * marker, different directory. The two are never interchangeable.
 *
 * ## The marker
 *
 * `<!-- duya-init:version N -->` — deliberately NOT the project's
 * `<!-- duya-agents-md:version N -->` prefix. Both files are called
 * AGENTS.md, so a shared prefix would let a file written for one be read as
 * the other, and would let `/init` treat a hand-written repository file as
 * something duya wrote.
 *
 * The version is what makes the write idempotent: a file whose recorded
 * version is at or above the current one is left alone (the user may have
 * edited it), a file below it is rewritten, and a file with no marker at all
 * counts as version 0.
 */

/**
 * The template version. Bump this when the seeded body changes materially;
 * files recorded below the current version are upgraded on the next write.
 */
export const INIT_AGENTS_MD_VERSION = 1 as const;

/** Marker embedded as an HTML comment at the top of every seeded file. */
export const INIT_AGENTS_MD_MARKER_PREFIX = '<!-- duya-init:version ';

/** Regex matching the marker line; captures the integer version. */
export const INIT_AGENTS_MD_MARKER_REGEX = /<!-- duya-init:version\s+(\d+)\s*-->/;

/**
 * Read the recorded version from an existing AGENTS.md body.
 *
 * Returns 0 when the marker is absent or malformed. A file without a marker is
 * treated as version 0 — the same rule the project seeder uses — which means
 * `/init` overwrites it. Callers that care about the difference between "duya
 * wrote this" and "the user wrote this" must read the marker themselves.
 */
export function readInitAgentsMdVersion(body: string): number {
  const match = body.match(INIT_AGENTS_MD_MARKER_REGEX);
  if (!match) return 0;
  const parsed = Number.parseInt(match[1] ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/** Build the marker line for a given version. */
export function initAgentsMdMarker(version: number): string {
  return `${INIT_AGENTS_MD_MARKER_PREFIX}${version} -->`;
}

/** The facts the template needs to describe the repository it lands in. */
export interface InitAgentsMdInput {
  /** The repository's directory name — the only thing duya can know for sure. */
  readonly repoName: string;
  /** The date the file was seeded, as `YYYY-MM-DD`. */
  readonly createdAt: string;
}

/**
 * The seeded body.
 *
 * A scaffold rather than a finished document: duya cannot know what this
 * repository does, so it writes the sections an agent needs and leaves the
 * repository-specific facts blank for the user (or the agent) to fill in.
 * Every placeholder is written as `_..._` so it is obvious what is still
 * missing.
 */
export function buildInitAgentsMdTemplate(input: InitAgentsMdInput): string {
  return `${initAgentsMdMarker(INIT_AGENTS_MD_VERSION)}
# ${input.repoName}

> Seeded by duya \`/init\` on ${input.createdAt}. This is the repository's
> AGENTS.md — the instructions every agent reads before touching this
> checkout. Edit it freely. duya only rewrites a file it wrote itself, and
> only when its own template version moves past the one recorded above.

## 1. What this repository is

_One paragraph: the goal, who it serves, and what "done" looks like._

- **Stack**: _language, framework, runtime versions_
- **Package manager**: _npm / pnpm / yarn / cargo / pip / ..._
- **Entry point**: _the file or command a new contributor starts from_

## 2. Layout

| Path | What lives there |
| --- | --- |
| \`src/\` | _..._ |

## 3. Commands

| Task | Command |
| --- | --- |
| Install dependencies | \`...\` |
| Build | \`...\` |
| Test | \`...\` |
| Lint / typecheck | \`...\` |

## 4. Conventions

- _Naming, file layout, error handling, logging._
- _Anything an agent would otherwise get wrong._

## 5. Do not

- Edit generated files, vendored code, or another author's migrations.
- Run destructive commands (force push, drop a database, delete branches)
  without asking first.
- Commit secrets, tokens, or local artifacts.

## 6. Before you finish

- Run the commands in section 3 and paste the real output.
- Keep one logical change per commit, and write the message in the
  imperative mood.
`;
}
