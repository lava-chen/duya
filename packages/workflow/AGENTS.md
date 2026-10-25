# @duya/workflow

> Runtime-layer workflow definition and scheduling core. This package is zero-IO and is also consumed by `@duya/agent-runtime`.

## Responsibility and boundary

- Own DAG validation, expressions, full-definition hashing, journal and resume-token contracts, ready-set scheduling, retry/failure policy, recovery reconciliation, concurrency limits, and scheduler observations.
- Keep persistence, database access, worker assembly/execution, run progress delivery, and provider construction in Host. Inject clocks, randomness, sleep, journal access, and execution through narrow ports.
- Preserve YAML/DAG as the workflow definition surface. Do not add a second script-authoring surface, UI workflow redesign, or analysis tooling here.
- Keep imports within the declared runtime package dependencies in `architecture-policy.yaml`; do not add Host or Electron dependencies.

## Verification

- Run `npm run typecheck:workflow` and `npx vitest run packages/workflow/tests` for package changes, then run `npm run typecheck:all` and `npm run architecture:check` before integration.
- Keep tests host-independent where possible: scheduler tests use in-memory journals and injected ports, without a database or worker process.
- Do not add architecture baseline fingerprints to make a new dependency pass. Update this guide when package ownership or its boundary changes.
