# Logging

## System

Use the structured logger from `apps/desktop/src/main/logging/logger.ts`.
**Never use `console.log/warn/error` directly.**

```typescript
import { initLogger, getLogger, LogComponent } from '../logging/logger';

// Module-level singleton (call once per module)
const logger = initLogger({ level: 'WARN' });

// Or get existing instance
const logger = getLogger();
```

## Levels

| Level | Console | File | When to use |
|-------|---------|------|-------------|
| `DEBUG` | No | Yes | Detailed diagnostics (query params, loop iterations, etc.) |
| `INFO` | Yes | Yes | Significant events: server start, task completion, user actions |
| `WARN` | Yes | Yes | Unexpected but recoverable (config missing, fallback triggered) |
| `ERROR` | Yes | Yes | Operation failed but app can continue, caught exceptions with context |
| `FATAL` | Yes | Yes | App cannot continue, needs immediate attention |

**Default level is `WARN`**. INFO+ goes to console; DEBUG only to file.

## Component Tag

Always pass a `component` string (use `LogComponent` constants) so logs are filterable:

```typescript
logger.info('Agent process started', { pid: process.pid }, LogComponent.AgentProcess);
```

## What to Log

- **INFO**: Boot events, user-initiated actions, significant state changes, task milestones
- **WARN**: Missing config with fallback, retry attempts, degraded behavior
- **ERROR**: Failures that affect user but app continues, caught exceptions with context
- **DEBUG**: Query parameters, loop counters, raw data samples, detailed control flow

## What NOT to Log

- Database query results (unless debugging a specific issue — use DEBUG)
- Large objects or arrays
- User input or message content
- File paths or data that could contain user info
- `console.log` debugging artifacts left in code

## Performance

Use `logger.time()` and `logger.timeAsync()` for tracking operation duration:

```typescript
const end = logger.time('document parse');
// ... work ...
end(); // Logs: "document parse completed" with duration in ms

await logger.timeAsync('gateway request', async () => {
  return await gateway.request(...);
});
```

## File Output

Logs written to `<userData>/logs/app.log` (`app.getPath('userData')`; on Windows that is
`%APPDATA%/duya`), rotated daily, retained 7 days. Use `LOG_LEVEL=DEBUG` env var to enable
verbose console output for debugging.
