/**
 * trigger-match.ts — declarative event-listener model for bot routines
 * (Plan 476 P2.3d; grok `automation-trigger.ts` semantics, polling port).
 *
 * A routine may carry `eventTriggers` (github / slack listeners). The
 * listener hub polls the backing SaaS APIs, normalizes each raw payload
 * into a `RoutineEvent` (whitelist fields, clamped lengths — outside data
 * is never trusted), and fires a routine when any of its listeners match.
 *
 * Matching semantics (grok parity):
 *   - github: repo (case-insensitive) + event kind in the list;
 *     `userAllowlist` gates per event kind — the PR owner for pr-opened /
 *     pr-merged, the actor for everything else; CI kinds are excluded from
 *     the v1 whitelist (polling check-runs reliably is out of scope).
 *   - slack: channel scope (`*` = any channel; `#name` / `C123…` /
 *     `@user` compared case-insensitively after the sigil) + match kind —
 *     mention (isMention), keyword (substring, case-insensitive), message
 *     (anything).
 */

import type {
  GithubEventTrigger,
  RoutineEvent,
  RoutineEventTrigger,
  SlackEventTrigger,
} from './types.js';

/** v1 whitelist — polling-detectable GitHub event kinds (no CI kinds). */
export const GITHUB_POLL_EVENT_KINDS = [
  'pr-opened',
  'pr-merged',
  'review-approved',
  'review-changes-requested',
  'review-commented',
  'pr-comment',
  'issue-assigned',
] as const;

export const TRIGGER_MAX_REPO_LENGTH = 140;
export const TRIGGER_MAX_CHANNEL_LENGTH = 120;
export const TRIGGER_MAX_KEYWORD_LENGTH = 120;
export const TRIGGER_MAX_ALLOWLIST = 50;
export const TRIGGER_MAX_LISTENERS = 8;

function token(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.replace(/[\r\n]+/g, ' ').trim().slice(0, max);
  return value || null;
}

function isGithubRepo(repo: string): boolean {
  // owner/name, concretely: no whitespace, no extra slashes, no wildcards
  // (grok parity — "one concrete repo").
  return /^[^\s/*]+\/[^\s/*]+$/.test(repo);
}

function parseGithub(value: Record<string, unknown>): GithubEventTrigger | null {
  const repo = token(value.repo, TRIGGER_MAX_REPO_LENGTH);
  if (repo == null || !isGithubRepo(repo)) return null;
  const events: string[] = [];
  for (const entry of Array.isArray(value.events) ? value.events : []) {
    if (typeof entry === 'string' && (GITHUB_POLL_EVENT_KINDS as readonly string[]).includes(entry) && !events.includes(entry)) {
      events.push(entry);
    }
    if (events.length >= GITHUB_POLL_EVENT_KINDS.length) break;
  }
  if (!events.length) return null;
  const allowlist: string[] = [];
  for (const entry of Array.isArray(value.userAllowlist) ? value.userAllowlist : []) {
    const login = token(entry, 80)?.replace(/^@+/, '');
    if (login && !allowlist.some((x) => x.toLowerCase() === login.toLowerCase())) allowlist.push(login);
    if (allowlist.length >= TRIGGER_MAX_ALLOWLIST) break;
  }
  return {
    type: 'github',
    repo,
    events,
    ...(allowlist.length ? { userAllowlist: allowlist } : {}),
  };
}

function parseSlack(value: Record<string, unknown>): SlackEventTrigger | null {
  const channel = token(value.channel, TRIGGER_MAX_CHANNEL_LENGTH);
  if (channel == null) return null;
  const match = typeof value.match === 'object' && value.match !== null ? (value.match as Record<string, unknown>) : null;
  if (!match) return null;
  if (match.kind === 'mention' || match.kind === 'message') {
    return { type: 'slack', channel, match: { kind: match.kind } };
  }
  if (match.kind === 'keyword') {
    const keyword = token(match.keyword, TRIGGER_MAX_KEYWORD_LENGTH);
    if (keyword == null) return null;
    return { type: 'slack', channel, match: { kind: 'keyword', keyword } };
  }
  return null;
}

/**
 * Validate + normalize one listener spec (agent tool input / TOML read).
 * Returns null for unrecognized shapes so bad entries degrade instead of
 * poisoning the whole routine.
 */
export function parseEventTriggerSpec(value: unknown): RoutineEventTrigger | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.type === 'github') return parseGithub(record);
  if (record.type === 'slack') return parseSlack(record);
  return null;
}

/** Validate a full listener list (create/update path). Throws with a reason. */
export function parseEventTriggerList(value: unknown): RoutineEventTrigger[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('eventTriggers must be an array of listener specs');
  const parsed: RoutineEventTrigger[] = [];
  for (const entry of value.slice(0, TRIGGER_MAX_LISTENERS)) {
    const trigger = parseEventTriggerSpec(entry);
    if (trigger == null) {
      throw new Error(
        `eventTriggers entry not recognized: ${JSON.stringify(entry).slice(0, 200)} — expected { type: 'github', repo, events } or { type: 'slack', channel, match }`,
      );
    }
    parsed.push(trigger);
  }
  return parsed;
}

// ==================== matching ====================

function splitScope(value: string): { sigil: string; name: string } {
  const sigil = value.startsWith('#') || value.startsWith('@') ? value[0] : '';
  return { sigil, name: value.slice(sigil.length).toLowerCase() };
}

function slackChannelMatches(scope: string, actual: string): boolean {
  if (scope === '*') return true;
  const a = splitScope(scope);
  const b = splitScope(actual);
  return !(a.sigil && b.sigil && a.sigil !== b.sigil) && a.name === b.name;
}

function admit(users: readonly string[], subject: unknown): boolean {
  if (typeof subject !== 'string') return false;
  return users.some((u) => u.toLowerCase() === subject.toLowerCase());
}

function githubListenerMatches(listener: GithubEventTrigger, event: RoutineEvent): boolean {
  if (event.source !== 'github') return false;
  if (listener.repo.toLowerCase() !== event.repo.toLowerCase()) return false;
  if (!listener.events.includes(event.kind)) return false;
  const users = listener.userAllowlist ?? [];
  if (!users.length) return true;
  // grok gate rules: pr lifecycle events gate on the PR owner; review
  // events gate on BOTH the actor and the PR owner.
  if (event.kind === 'pr-opened' || event.kind === 'pr-merged') {
    return admit(users, event.prOwner);
  }
  if (event.kind === 'review-approved' || event.kind === 'review-changes-requested' || event.kind === 'review-commented') {
    return admit(users, event.actor) && admit(users, event.prOwner);
  }
  return admit(users, event.actor);
}

function slackListenerMatches(listener: SlackEventTrigger, event: RoutineEvent): boolean {
  if (event.source !== 'slack') return false;
  if (!slackChannelMatches(listener.channel, event.channel)) return false;
  switch (listener.match.kind) {
    case 'mention':
      return event.isMention === true;
    case 'message':
      return true;
    case 'keyword':
      return event.text.toLowerCase().includes(listener.match.keyword.toLowerCase());
  }
}

/** Does this listener match a normalized event? */
export function listenerMatchesEvent(listener: RoutineEventTrigger, event: RoutineEvent): boolean {
  return listener.type === 'github'
    ? githubListenerMatches(listener, event)
    : slackListenerMatches(listener, event);
}

/** Does any of a routine's listeners match? */
export function eventTriggersMatch(triggers: readonly RoutineEventTrigger[], event: RoutineEvent): boolean {
  return triggers.some((listener) => listenerMatchesEvent(listener, event));
}

// ==================== presentation ====================

const GITHUB_KIND_LABELS: Record<string, string> = {
  'pr-opened': 'a PR opens',
  'pr-merged': 'a PR merges',
  'review-approved': 'a review approves a PR',
  'review-changes-requested': 'a review requests changes',
  'review-commented': 'a review comments on a PR',
  'pr-comment': 'a PR comment lands',
  'issue-assigned': 'an issue is assigned',
};

/** Human line for UI + prompts ("When a PR opens in acme/widgets"). */
export function describeEventTrigger(trigger: RoutineEventTrigger): string {
  if (trigger.type === 'github') {
    const phrases = trigger.events.map((kind) => GITHUB_KIND_LABELS[kind] ?? kind);
    const joined =
      phrases.length <= 1
        ? phrases[0] ?? ''
        : `${phrases.slice(0, -1).join(', ')} or ${phrases[phrases.length - 1]}`;
    const scope = trigger.userAllowlist?.length
      ? ` (by @${trigger.userAllowlist.join(', @')})`
      : '';
    return `When ${joined} in ${trigger.repo}${scope}`;
  }
  const where = trigger.channel === '*' ? 'anywhere on Slack' : `in ${trigger.channel}`;
  if (trigger.match.kind === 'mention') return `When @mentioned ${where}`;
  if (trigger.match.kind === 'keyword') return `When "${trigger.match.keyword}" is mentioned ${where}`;
  return `On any message ${where}`;
}

function escapeText(value: string): string {
  return value.replace(/</g, '‹').replace(/>/g, '›');
}

function line(value: unknown, max = 120): string {
  return typeof value === 'string' ? value.replace(/[\r\n]+/g, ' ').trim().slice(0, max) : '';
}

/** One-line summary of a normalized event ("actor in #eng: …"). */
export function describeEvent(event: RoutineEvent): string {
  if (event.source === 'github') {
    return `${GITHUB_KIND_LABELS[event.kind] ?? event.kind} in ${event.repo}: "${line(event.title)}" by ${event.actor}`;
  }
  if (event.isMention) {
    return `${event.sender} mentioned the bot in ${event.channel}: "${line(event.text)}"`;
  }
  return `${event.sender} in ${event.channel}: "${line(event.text)}"`;
}

/** Grok parity: payloads render inside a source-named tag, escaped. */
export function buildEventContextBlock(event: RoutineEvent): string {
  const tag = event.source === 'github' ? 'github_event' : 'slack_message';
  return `<${tag}>\n${escapeText(JSON.stringify(event, null, 2))}\n</${tag}>`;
}

// ==================== event sanitization ====================

const EVENT_TEXT_MAX = 4000;
const EVENT_TITLE_MAX = 400;
const EVENT_URL_MAX = 600;

function str(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.slice(0, max);
}

/**
 * Whitelist + clamp a raw polled payload into a RoutineEvent. Unknown
 * fields are dropped (prompt-injection defense); invalid shapes return
 * null so one bad payload never wedges a poll cycle.
 */
export function sanitizeGithubEvent(raw: Record<string, unknown>): RoutineEvent | null {
  const repo = str(raw.repo, TRIGGER_MAX_REPO_LENGTH);
  const kind = str(raw.kind, 80);
  if (!repo || !kind || !(GITHUB_POLL_EVENT_KINDS as readonly string[]).includes(kind)) return null;
  return {
    source: 'github',
    repo,
    kind,
    title: str(raw.title, EVENT_TITLE_MAX) ?? '',
    actor: str(raw.actor, 120) ?? 'someone',
    ...(str(raw.url, EVENT_URL_MAX) ? { url: str(raw.url, EVENT_URL_MAX) as string } : {}),
    ...(str(raw.prOwner, 120) ? { prOwner: str(raw.prOwner, 120) as string } : {}),
    timestampMs: typeof raw.timestampMs === 'number' && Number.isFinite(raw.timestampMs) ? raw.timestampMs : Date.now(),
  };
}

export function sanitizeSlackEvent(raw: Record<string, unknown>): RoutineEvent | null {
  const channel = str(raw.channel, TRIGGER_MAX_CHANNEL_LENGTH);
  const ts = str(raw.ts, 40);
  if (!channel || !ts) return null;
  return {
    source: 'slack',
    channel,
    sender: str(raw.sender, 120) ?? 'someone',
    text: str(raw.text, EVENT_TEXT_MAX) ?? '',
    isMention: raw.isMention === true,
    ts,
    timestampMs: typeof raw.timestampMs === 'number' && Number.isFinite(raw.timestampMs) ? raw.timestampMs : Date.now(),
  };
}

/** Stable per-listener dedupe key (used for idempotent cursor writes). */
export function eventTriggerKey(trigger: RoutineEventTrigger, index: number): string {
  return trigger.type === 'github'
    ? `github:${trigger.repo.toLowerCase()}:${index}`
    : `slack:${trigger.channel.toLowerCase()}:${index}`;
}
