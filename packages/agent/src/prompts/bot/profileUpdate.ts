/**
 * ProfileUpdateEnvelope (Plan 474 §2.2 / P3.1).
 *
 * When a bot's identity (name/description) changes mid-session, the change
 * must be *announced* to the model as a hidden history message — silently
 * changing the frozen identity section would break the frozen-snapshot
 * contract and the model would keep acting under the stale identity. The
 * envelope is one hidden runtime_context message:
 *
 *   <<BOT_AGENT_PROFILE_UPDATE:v1:<base64url JSON {name,description,changedAt}>>>
 *
 * Idempotency key is `changedAt`: `getLatestProfileUpdate` scans the
 * timeline for the newest envelope, and the announcer only appends when the
 * detected change is newer than everything already announced.
 *
 * Compaction folding (§2.2, grok A7 analog): envelopes are a temporary
 * mechanism. When a compaction persists (summaryEpoch advances), the newest
 * announced update is folded into the identity baseline and marked folded —
 * afterwards the rendered identity section carries the merged view and the
 * history envelope no longer needs to survive. In duya the baseline data
 * source (profile.json) is re-read every turn, so folding *is* the rendered
 * view; both paths share {@link mergeProfileUpdate} so the prompt is
 * identical before and after folding.
 */

export const PROFILE_UPDATE_ENVELOPE_TAG = 'BOT_AGENT_PROFILE_UPDATE'
export const PROFILE_UPDATE_ENVELOPE_VERSION = 'v1'

/** Authoritative identity change announced to the model. */
export interface ProfileUpdate {
  name?: string
  description?: string
  /** ISO timestamp; doubles as the idempotency key. */
  changedAt: string
}

/** The identity the model has last been told about (announced or folded). */
export interface ProfileBaseline {
  name?: string
  description?: string
  /** changedAt of the newest update reflected in this baseline. */
  foldedUntil?: string
}

/** Wrap a payload in `<<TAG:version:<base64url>>>` (Plan 474 §2.2 format). */
export function buildProfileUpdateEnvelope(update: ProfileUpdate): string {
  const json = JSON.stringify(update)
  // base64url without padding: URL-safe for message content and stable.
  const encoded = Buffer.from(json, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return `<<${PROFILE_UPDATE_ENVELOPE_TAG}:${PROFILE_UPDATE_ENVELOPE_VERSION}:${encoded}>>`
}

/** Inverse of {@link buildProfileUpdateEnvelope}; null on any malformation. */
export function parseProfileUpdateEnvelope(content: string): ProfileUpdate | null {
  const match = content.match(
    new RegExp(
      `<<${PROFILE_UPDATE_ENVELOPE_TAG}:${PROFILE_UPDATE_ENVELOPE_VERSION}:([A-Za-z0-9_-]+)>>`,
    ),
  )
  if (!match) return null
  try {
    const b64 = match[1]!.replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    const parsed: unknown = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    const record = parsed as Record<string, unknown>
    if (typeof record.changedAt !== 'string' || record.changedAt === '') return null
    const update: ProfileUpdate = { changedAt: record.changedAt }
    if (typeof record.name === 'string' && record.name !== '') update.name = record.name
    if (typeof record.description === 'string' && record.description !== '') {
      update.description = record.description
    }
    if (update.name === undefined && update.description === undefined) return null
    return update
  } catch {
    return null
  }
}

/**
 * Compare the announced baseline against the current identity. Returns the
 * update to announce, or null when nothing differs (idempotent under
 * repeated calls with an up-to-date baseline).
 */
export function detectProfileUpdate(
  baseline: ProfileBaseline,
  current: { name?: string; description?: string },
  changedAt: string = new Date().toISOString(),
): ProfileUpdate | null {
  const update: ProfileUpdate = { changedAt }
  let changed = false
  if (current.name !== undefined && current.name !== baseline.name) {
    update.name = current.name
    changed = true
  }
  if (current.description !== undefined && current.description !== baseline.description) {
    update.description = current.description
    changed = true
  }
  return changed ? update : null
}

/**
 * Merge an update over a baseline (update wins for fields it carries).
 * Shared by the fold path and the render path (§2.2: 压缩前后共用同一合并
 * 函数，保证提示词一致).
 */
export function mergeProfileUpdate(
  baseline: ProfileBaseline,
  update: ProfileUpdate | null,
): ProfileBaseline {
  if (!update) return { ...baseline }
  const merged: ProfileBaseline = {
    name: update.name ?? baseline.name,
    description: update.description ?? baseline.description,
    // Fold marker: newest of the two, so re-announcing an older envelope
    // after a fold is impossible.
    foldedUntil:
      !baseline.foldedUntil || update.changedAt > baseline.foldedUntil
        ? update.changedAt
        : baseline.foldedUntil,
  }
  return merged
}

/**
 * Newest envelope payload in a sequence of message contents (timeline order
 * independent — comparison is by `changedAt`). Returns null when the
 * history carries no envelope.
 */
export function getLatestProfileUpdate(contents: Iterable<string>): ProfileUpdate | null {
  let latest: ProfileUpdate | null = null
  for (const content of contents) {
    const update = parseProfileUpdateEnvelope(content)
    if (!update) continue
    if (!latest || update.changedAt > latest.changedAt) latest = update
  }
  return latest
}

/**
 * True when the update is already covered by the baseline (announced earlier
 * or folded) — the announcer uses this to stay idempotent per changedAt.
 */
export function isProfileUpdateFolded(baseline: ProfileBaseline, update: ProfileUpdate): boolean {
  return baseline.foldedUntil !== undefined && update.changedAt <= baseline.foldedUntil
}
