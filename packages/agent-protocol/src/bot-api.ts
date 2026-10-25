/**
 * bot-api.ts — the minimal Bot application DTOs (framework plan S1).
 *
 * The personal-agent framework plan (docs/exec-plans/active/
 * 2026-10-25-personal-bot-framework.md, slice S1) starts the Bot domain with
 * the one use case every client already has: identity. These types are the
 * WIRE shape of that use case — the command / receipt / record contract the
 * Host Bot service exposes to Desktop, TUI and channel adapters.
 *
 * ## What is deliberately NOT here
 *
 * Scheduling, inbox, runs, delivery and memory are later slices (S3–S5) and
 * have no DTO here: a protocol module that carries types for unbuilt
 * behavior is a promise the wire cannot keep yet. The same discipline limits
 * the record to identity fields; model / workspace / tools stay in the
 * config-agent tables they live in today and are NOT duplicated into the
 * canonical view.
 *
 * ## Revision semantics
 *
 * `revision` is the optimistic-concurrency token of one bot's identity. It
 * starts at 1 on a facade create, increments on every facade update, and
 * reads 0 for legacy entries written before the facade existed — 0 meaning
 * "never written through the contract", not "first version". A caller that
 * read a bot at revision N passes `expectedRevision: N` on update; the
 * service rejects a stale N with `bot_revision_conflict` instead of silently
 * clobbering the newer write. Callers that cannot carry a revision (the
 * agent-side identity tools) omit it and accept last-writer-wins, exactly as
 * they behave today — the conflict path is opt-in so existing clients do not
 * break on the seam.
 *
 * ## requestId semantics
 *
 * A create carrying a `requestId` is idempotent across process crashes: the
 * identity journal records the requestId with its receipt, and a retry of
 * the same command returns the SAME receipt with `deduplicated: true` rather
 * than allocating a second bot. This is the plan's §5 contract
 * ("可重试命令带 requestId") reduced to the identity slice.
 */

/** The canonical, client-facing Bot identity view. */
export interface BotRecord {
  id: string;
  /** Display name: profile.json first, config.toml as fallback, id last. */
  name: string;
  /** Role subtitle (profile.json only; empty when unset). */
  title: string;
  /** One-line role description with the same precedence as `name`. */
  description: string;
  /** See the header; 0 = written before the facade existed. */
  revision: number;
}

/** Retryable create command. `name` is required and trimmed. */
export interface CreateBotCommand {
  name: string;
  description?: string | undefined;
  /**
   * Deduplication key. When provided, a retried create with the same id
   * returns the original receipt instead of creating a second bot.
   */
  requestId?: string | undefined;
}

/** Identity patch; only the fields present change. */
export interface UpdateBotCommand {
  id: string;
  name?: string | undefined;
  description?: string | undefined;
  /** Reject instead of overwrite when the stored revision moved on. */
  expectedRevision?: number | undefined;
}

/** What a create / update answers. Shape-compatible with the legacy
 * `{ id, name }` the `config:agents:*` bridge actions already return. */
export interface BotCommandReceipt {
  id: string;
  name: string;
  revision: number;
  /** True when a create was served from the requestId journal, not executed. */
  deduplicated?: boolean | undefined;
}

/** Error codes of the Bot identity application service. */
export type BotErrorCode =
  | 'bot_invalid_name'
  | 'bot_not_found'
  | 'bot_soft_deleted'
  | 'bot_revision_conflict';

/**
 * The structured failure the service throws. `code` is the machine-readable
 * contract; `details` carries the conflict numbers (stored / expected) the
 * caller needs to re-read and retry — an error that hides them is an error
 * the caller cannot recover from.
 */
export interface BotErrorDetail {
  code: BotErrorCode;
  message: string;
  details?: Record<string, unknown> | undefined;
}
