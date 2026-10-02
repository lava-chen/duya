/**
 * listener-polls.ts — per-provider pollers for routine event listeners
 * (Plan 476 P2.3d). Each poller turns one listener spec + its persisted
 * cursor into the events newer than that cursor, so the hub can dedupe
 * between ticks without any server-side state.
 *
 * duya is local-first: unlike grok (which delegates listener scheduling to
 * the Cursor cloud and consumes fire events), we poll the SaaS APIs
 * directly with the OAuth token from the user's App Connections. Both
 * pollers take the raw `fetch` as an argument — tests inject fakes and
 * nothing here touches the network at import time.
 *
 * Cursors are opaque strings owned by each poller:
 *   - github: the last seen event id (`List repository events` is
 *     newest-first); an empty/missing cursor means "first run" — seed the
 *     cursor WITHOUT emitting (a new listener must not replay the repo's
 *     entire history).
 *   - slack: the newest message `ts` in the channel (conversations.history
 *     newest-first); same seeding rule.
 */

import type { GithubEventTrigger, RoutineEvent, SlackEventTrigger } from './types.js';
import { sanitizeGithubEvent, sanitizeSlackEvent } from './trigger-match.js';

export interface PollOutcome {
  events: RoutineEvent[];
  /** Cursor to persist; null keeps the previous one. */
  cursor: string | null;
}

export interface PollArgs {
  accessToken: string;
  cursor: string | null;
  now: number;
  fetchImpl: typeof fetch;
}

const GITHUB_API = 'https://api.github.com';
const SLACK_API = 'https://slack.com/api';
const POLL_PAGE_SIZE = 30;
const MAX_EVENTS_PER_POLL = 25;

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  const response = await fetchImpl(url, { headers });
  const body: unknown = await response.json().catch(() => null);
  return { status: response.status, body };
}

// ==================== github ====================

interface GithubApiEvent {
  id?: string;
  type?: string;
  actor?: { login?: string };
  payload?: {
    action?: string;
    pull_request?: { title?: string; merged?: boolean; html_url?: string; user?: { login?: string } };
    comment?: { html_url?: string };
    issue?: { title?: string; html_url?: string; pull_request?: unknown };
    review?: { state?: string };
    assignee?: { login?: string };
  };
  created_at?: string;
  repo?: { name?: string };
}

/**
 * Poll GitHub repository events for one listener. The public `List
 * repository events` endpoint is newest-first and covers every v1 kind:
 *   pr-opened  ← PullRequestEvent action=opened
 *   pr-merged  ← PullRequestEvent action=closed + pull_request.merged
 *   review-*   ← PullRequestReviewEvent action=approved|changes_requested|commented
 *   pr-comment ← IssueCommentEvent whose issue carries pull_request
 *   issue-assigned ← IssuesEvent action=assigned
 */
export async function pollGithubListener(
  trigger: GithubEventTrigger,
  args: PollArgs,
): Promise<PollOutcome> {
  const url = new URL(`${GITHUB_API}/repos/${trigger.repo}/events`);
  url.searchParams.set('per_page', String(POLL_PAGE_SIZE));
  const { status, body } = await fetchJson(args.fetchImpl, url.toString(), {
    Authorization: `Bearer ${args.accessToken}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  });
  if (status === 401 || status === 403) {
    throw new Error(`github auth rejected (HTTP ${status})`);
  }
  if (status === 404) {
    throw new Error(`github repo not found: ${trigger.repo}`);
  }
  if (status !== 200 || !Array.isArray(body)) {
    throw new Error(`github events poll failed (HTTP ${status})`);
  }

  const apiEvents = body as GithubApiEvent[];
  // First run: seed the cursor at the newest event WITHOUT emitting, so a
  // fresh listener does not replay history.
  if (args.cursor == null) {
    const newest = apiEvents[0]?.id;
    return { events: [], cursor: newest ?? String(args.now) };
  }

  const events: RoutineEvent[] = [];
  let newestId = args.cursor;
  for (const raw of apiEvents) {
    if (!raw.id || raw.id === args.cursor) break; // reached the last seen event
    const mapped = mapGithubApiEvent(raw, trigger.repo, args.now);
    if (mapped != null && trigger.events.includes(String(mapped.kind))) {
      const sanitized = sanitizeGithubEvent(mapped);
      if (sanitized) events.push(sanitized);
    }
    if (!newestId || BigInt(raw.id) > BigInt(newestId)) newestId = raw.id;
    if (events.length >= MAX_EVENTS_PER_POLL) break;
  }
  return { events, cursor: newestId };
}

function mapGithubApiEvent(
  raw: GithubApiEvent,
  repo: string,
  now: number,
): Record<string, unknown> | null {
  const actor = raw.actor?.login ?? 'someone';
  const base = { repo, actor, timestampMs: timestampOf(raw.created_at, now) };
  switch (raw.type) {
    case 'PullRequestEvent': {
      if (raw.payload?.action === 'opened') {
        return { ...base, kind: 'pr-opened', title: raw.payload.pull_request?.title ?? '', url: raw.payload.pull_request?.html_url, prOwner: raw.payload.pull_request?.user?.login };
      }
      if (raw.payload?.action === 'closed' && raw.payload.pull_request?.merged === true) {
        return { ...base, kind: 'pr-merged', title: raw.payload.pull_request?.title ?? '', url: raw.payload.pull_request?.html_url, prOwner: raw.payload.pull_request?.user?.login };
      }
      return null;
    }
    case 'PullRequestReviewEvent': {
      const state = raw.payload?.review?.state;
      const kind = state === 'approved' ? 'review-approved' : state === 'changes_requested' ? 'review-changes-requested' : state === 'commented' ? 'review-commented' : null;
      return kind == null ? null : { ...base, kind, title: raw.payload?.pull_request?.title ?? '' };
    }
    case 'IssueCommentEvent': {
      if (raw.payload?.issue == null || typeof raw.payload.issue.pull_request === 'undefined') return null;
      return { ...base, kind: 'pr-comment', title: raw.payload.issue.title ?? '', url: raw.payload.comment?.html_url };
    }
    case 'IssuesEvent': {
      if (raw.payload?.action !== 'assigned') return null;
      return { ...base, kind: 'issue-assigned', title: raw.payload.issue?.title ?? '', url: raw.payload.issue?.html_url };
    }
    default:
      return null;
  }
}

function timestampOf(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : fallback;
}

// ==================== slack ====================

interface SlackHistoryMessage {
  type?: string;
  ts?: string;
  text?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
}

/**
 * Poll one Slack channel's history. `resolveChannelId` maps a trigger's
 * channel (id, `#name`, or `@user`) to a real channel id — implemented by
 * the hub via conversations.list so the poller stays single-purpose.
 */
export async function pollSlackListener(
  trigger: SlackEventTrigger,
  args: PollArgs & { resolveChannelId: (channel: string) => Promise<string | null> },
): Promise<PollOutcome> {
  const channelId = await args.resolveChannelId(trigger.channel);
  if (!channelId) {
    throw new Error(`slack channel not found: ${trigger.channel} (is the bot a member?)`);
  }
  const url = new URL(`${SLACK_API}/conversations.history`);
  url.searchParams.set('channel', channelId);
  url.searchParams.set('limit', String(POLL_PAGE_SIZE));
  const { status, body } = await fetchJson(args.fetchImpl, url.toString(), {
    Authorization: `Bearer ${args.accessToken}`,
  });
  const record = (body ?? null) as Record<string, unknown> | null;
  if (status !== 200 || !record || record.ok !== true) {
    const apiError: unknown = record?.error;
    const error = typeof apiError === 'string' ? apiError : `HTTP ${status}`;
    throw new Error(`slack history poll failed: ${error}`);
  }
  const messages = (Array.isArray(record.messages) ? record.messages : []) as SlackHistoryMessage[];

  if (args.cursor == null) {
    const newest = messages[0]?.ts;
    return { events: [], cursor: newest ?? String(args.now) };
  }

  const events: RoutineEvent[] = [];
  let newestTs = args.cursor;
  for (const message of messages) {
    if (!message.ts) continue;
    if (message.ts === args.cursor) break; // reached the last seen message
    // Bot's own messages and message_changed/Bot-subtypes are noise.
    if (message.bot_id || (message.subtype && message.subtype !== 'thread_broadcast')) continue;
    const sanitized = sanitizeSlackEvent({
      channel: trigger.channel,
      sender: message.user ?? 'someone',
      text: message.text ?? '',
      // Slack mention rendering: <@U123…> — anything containing it counts.
      isMention: typeof message.text === 'string' && message.text.includes('<@'),
      ts: message.ts,
      timestampMs: Math.floor(parseFloat(message.ts) * 1000) || args.now,
    });
    if (sanitized) events.push(sanitized);
    if (newestTs === args.cursor || message.ts > newestTs) newestTs = message.ts;
    if (events.length >= MAX_EVENTS_PER_POLL) break;
  }
  return { events, cursor: newestTs };
}
