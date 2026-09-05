/**
 * groupTurn.ts — shared-room (group chat) mechanics (Plan 478).
 *
 * Faithful port of grok-bot 0.18 `source/host/groups/group-chat.ts` +
 * `source/host/extensions/transcript/group-chat-orchestrator.ts`, adapted to
 * duya:
 *   - the member's only voice into the room is the `post_to_room` tool
 *     (duya's SendMessage stays 1:1-with-user; plan 481 §3);
 *   - the member turn runs on the member's persistent bot session
 *     (`bot:<agentId>`) with the bot's own persona system prompt, so the
 *     group-member system prompt block is folded into the turn prompt by the
 *     main-side glue (grok passes it separately);
 *   - group definition lives in `~/.duya/groups.toml` (plan 478 §2.1), not a
 *     per-agent group.json — the config layer validates nesting/size, so
 *     SandGroupNestingError is not ported here.
 *
 * Pure over text + config: no I/O, no DB, no process state. The orchestrator
 * is dependency-injected exactly like grok's so the main-process dispatcher
 * (electron/wake/group-turn-dispatcher.ts) supplies the runtime seams.
 */

// ─── Tunables (grok group-chat.ts line 1) ───

export const GROUP_CONFIG_VERSION = 1;
/** Total member LLM turns per room turn. */
export const GROUP_MAX_MEMBER_TURNS = 10;
/** Round-robin rounds per room turn. */
export const GROUP_MAX_ROUNDS = 3;
/** History lines shown in a member turn prompt. */
export const GROUP_PROMPT_HISTORY_LIMIT = 24;
/** A member may send at most this many room messages per turn. */
export const GROUP_MAX_MESSAGES_PER_TURN = 2;

export const GROUP_CHAT_TAG_PREFIX = '[Group chat: ';

// ─── Types ───

export interface GroupMember {
  id: string;
  name: string;
  description?: string;
}

export interface GroupDescription {
  name: string;
  description?: string;
}

export type GroupMessage = {
  speaker: { kind: 'user'; name?: string } | { kind: 'member'; id: string; name: string };
  content: string;
};

// ─── Round-robin ordering (grok group-chat.ts line 3) ───

/** Rotate the speaking order so a different member opens each round. */
export function orderRoundSpeakers<T>(memberIds: readonly T[], round: number): T[] {
  if (memberIds.length === 0) return [];
  const offset = ((round % memberIds.length) + memberIds.length) % memberIds.length;
  return [...memberIds.slice(offset), ...memberIds.slice(0, offset)];
}

// ─── @mention parsing (grok group-chat.ts lines 7-9) ───

/** Handles a member's name can be mentioned by: full name, no-space form, first word. */
export function memberMentionHandles(name: string): string[] {
  const lower = name.trim().toLowerCase();
  if (!lower) return [];
  const handles = new Set([lower, lower.replace(/\s+/g, '')]);
  const first = lower.split(/\s+/)[0];
  if (first) handles.add(first);
  return [...handles];
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[a-z0-9]/.test(char);
}

/** True when `@handle` occurs in `lower` at an ASCII word boundary. */
function hasMentionAt(lower: string, handle: string): boolean {
  const needle = `@${handle}`;
  for (
    let index = lower.indexOf(needle);
    index >= 0;
    index = lower.indexOf(needle, index + 1)
  ) {
    if (!isWordChar(lower[index - 1]) && !isWordChar(lower[index + needle.length])) {
      return true;
    }
  }
  return false;
}

/**
 * Parse a message for @mentions of room members. `@everyone` / `@all` wake
 * the whole room (plan 478 §2.2 rule 1 — the branch mentions.ts deferred to
 * this plan).
 */
export function parseGroupMentions(
  text: string,
  members: readonly Pick<GroupMember, 'id' | 'name'>[],
): { isEveryone: boolean; memberIds: string[] } {
  const lower = text.toLowerCase();
  const memberIds: string[] = [];
  const seen = new Set<string>();
  for (const member of members) {
    if (!seen.has(member.id) && memberMentionHandles(member.name).some((handle) => hasMentionAt(lower, handle))) {
      memberIds.push(member.id);
      seen.add(member.id);
    }
  }
  return { isEveryone: /(?:^|[^a-z0-9])@(everyone|all)\b/.test(lower), memberIds };
}

/**
 * Who responds to the current room turn (grok resolveResponders): only
 * messages since the last user message count; @everyone/@all or no mentions
 * means every member responds, otherwise only the mentioned ones.
 */
export function resolveResponders<T extends Pick<GroupMember, 'id' | 'name'>>(
  members: readonly T[],
  history: readonly GroupMessage[],
): T[] {
  let start = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.speaker.kind === 'user') {
      start = index;
      break;
    }
  }
  let everyone = false;
  const mentioned = new Set<string>();
  for (const message of history.slice(start)) {
    const targets = parseGroupMentions(message.content, members);
    everyone ||= targets.isEveryone;
    for (const id of targets.memberIds) mentioned.add(id);
  }
  return everyone || mentioned.size === 0 ? [...members] : members.filter((member) => mentioned.has(member.id));
}

// ─── (pass) silence (grok group-chat.ts line 11) ───

/** Empty content or a bare "(pass)" means the member stays silent. */
export function isPassContent(content: string): boolean {
  const trimmed = content.trim();
  return !trimmed || /^\(?\s*pass\s*\)?\.?$/i.test(trimmed);
}

/** Streaming-prefix guard: a "(p…" draft is likely heading to "(pass)". */
export function isPotentialPassPrefix(text: string): boolean {
  const trimmed = text.trim();
  return !trimmed || isPassContent(trimmed) || /^\(?\s*(?:p(?:a(?:s(?:s\s*\)?\.?)?)?)?)?$/i.test(trimmed);
}

// ─── Prompt rendering (grok group-chat.ts lines 12-17) ───

export function groupDisplayName(group: GroupDescription): string {
  return group.name.trim() || 'the group';
}

export function describeGroup(group: GroupDescription): string {
  const name = groupDisplayName(group);
  const description = (group.description ?? '').trim();
  return description ? `"${name}" — ${description}` : `"${name}"`;
}

export function formatGroupChatTag(
  group: GroupDescription,
  peers: readonly Pick<GroupMember, 'name'>[],
): string {
  return `${GROUP_CHAT_TAG_PREFIX}"${groupDisplayName(group)}"${peers.length > 0 ? ` - with ${peers.map((peer) => peer.name).join(', ')}` : ''}]`;
}

export function formatGroupLine(message: GroupMessage, viewerId: string): string {
  if (message.speaker.kind === 'user') {
    return message.speaker.name
      ? `${message.speaker.name} (user): ${message.content}`
      : `User: ${message.content}`;
  }
  return `${message.speaker.name}${message.speaker.id === viewerId ? ' (you)' : ''}: ${message.content}`;
}

export function formatGroupHistory(
  history: readonly GroupMessage[],
  viewerId: string,
  limit = GROUP_PROMPT_HISTORY_LIMIT,
): string {
  const recent = history.slice(-limit);
  return recent.length === 0
    ? '(no messages yet)'
    : recent.map((message) => formatGroupLine(message, viewerId)).join('\n');
}

/**
 * The group-member conduct block. duya folds this into the wake prompt head
 * (the member's bot session already carries its persona system prompt),
 * so it is phrased as an in-turn contract rather than a full persona.
 */
export function buildGroupMemberSystemPrompt(
  member: GroupMember,
  group: GroupDescription,
  peers: readonly GroupMember[],
): string {
  const lines: string[] = [];
  lines.push(`You are ${member.name}, one participant in a group chat (${describeGroup(group)}).`);
  if (peers.length > 0) {
    lines.push('', 'Other participants in the room:', ...peers.map((peer) => `- ${peer.name}${peer.description ? ` (${peer.description})` : ''}`));
  }
  lines.push(
    '',
    peers.length > 0
      ? `Right now you are speaking in this group chat, with ${peers.map((peer) => peer.name).join(', ')}.`
      : 'Right now you are speaking in this group chat.',
    'Everything above is a hidden group-chat turn, not your user chat: the room does not see your plain text or tool calls. Do the work first with your tools, then deliver the result to the room.',
    '',
    `Stay in character as ${member.name}. The ONLY way to say something the room can see is the post_to_room tool. Keep each message short and conversational (at most ${GROUP_MAX_MESSAGES_PER_TURN} messages this turn). If you have nothing new worth adding, call post_to_room with exactly "(pass)". Never reveal private one-on-one context — what your user tells you in private stays private.`,
  );
  return lines.join('\n');
}

/** Everything the member said since they last spoke (grok line 16). */
export function messagesSinceMemberLastSpoke(
  history: readonly GroupMessage[],
  memberId: string,
): readonly GroupMessage[] {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const speaker = history[index]?.speaker;
    if (speaker?.kind === 'member' && speaker.id === memberId) return history.slice(index + 1);
  }
  return history;
}

export function buildGroupTurnPrompt(args: {
  member: GroupMember;
  group: GroupDescription;
  peers: readonly GroupMember[];
  newMessages: readonly GroupMessage[];
}): string {
  const lines = [
    formatGroupChatTag(args.group, args.peers),
    args.newMessages.length === 0
      ? 'No new messages in the room since your last turn.'
      : `New messages in the room (oldest first):\n${formatGroupHistory(args.newMessages, args.member.id)}`,
    '',
    `It's your turn, ${args.member.name}. Reply in character with post_to_room if you have something worth adding, or send "(pass)" if you don't.`,
  ];
  return lines.join('\n');
}

/** Combined wake prompt for a member turn (duya glue: system block + turn). */
export function buildGroupMemberWakePrompt(args: {
  member: GroupMember;
  group: GroupDescription;
  peers: readonly GroupMember[];
  newMessages: readonly GroupMessage[];
}): string {
  return [
    buildGroupMemberSystemPrompt(args.member, args.group, args.peers),
    '',
    buildGroupTurnPrompt(args),
  ].join('\n');
}

// ─── Orchestrator (grok group-chat-orchestrator.ts, ported as-is) ───

export interface GroupOrchestratorDeps {
  resolveMembers(ids: readonly string[]): Promise<GroupMember[]>;
  readHistory(): readonly GroupMessage[];
  /** Epoch check — a stale turn (superseded by a newer post) unwinds. */
  isCurrent(): boolean;
  /**
   * Run one member's LLM turn. Resolves with the texts the member posted to
   * the room (captured from post_to_room tool calls); (pass)/empty entries
   * are filtered by the orchestrator.
   */
  runMemberTurn(args: {
    member: GroupMember;
    systemPrompt: string;
    prompt: string;
  }): Promise<readonly string[]>;
  /**
   * Persist one spoken message into the room transcript. duya's PostToRoom
   * tool already writes the room transcript from the worker, so the
   * main-side dep is typically a no-op kept for symmetry and tests.
   */
  postMemberMessage(member: GroupMember, content: string): void;
  finalizeMemberTurn?(member: GroupMember): void;
}

/** Drives a bounded, epoch-cancellable round robin for one room turn. */
export class GroupChatOrchestrator {
  constructor(readonly deps: GroupOrchestratorDeps) {}

  async run(args: {
    group: GroupDescription;
    memberIds: readonly string[];
    /** Per-room overrides (plan 478 §2.2 rule 3); defaults to grok constants. */
    maxRounds?: number;
    maxMemberTurns?: number;
  }): Promise<void> {
    const members = await this.deps.resolveMembers(args.memberIds);
    if (members.length === 0) return;
    const maxRounds = args.maxRounds ?? GROUP_MAX_ROUNDS;
    const maxMemberTurns = args.maxMemberTurns ?? GROUP_MAX_MEMBER_TURNS;

    const memberById = new Map(members.map((member) => [member.id, member]));
    let totalMessages = 0;

    for (let round = 0; round < maxRounds; round += 1) {
      if (!this.deps.isCurrent()) return;
      const responderIds = resolveResponders(members, this.deps.readHistory()).map((member) => member.id);
      let messagesThisRound = 0;

      for (const memberId of orderRoundSpeakers(responderIds, round)) {
        if (totalMessages >= maxMemberTurns || !this.deps.isCurrent()) return;
        const member = memberById.get(memberId);
        if (member == null) continue;

        // A failed member turn is a pass, not a room-wide failure (grok
        // group-chat-glue comment). The duya glue is thinner than grok's, so
        // the catch lives here where the semantic belongs.
        let sent: string[];
        try {
          sent = await this.runOneTurn(args.group, member, members);
        } catch (err) {
          if (!this.deps.isCurrent()) return;
          void err;
          continue;
        }
        let hitCap = false;
        for (const content of sent) {
          this.deps.postMemberMessage(member, content);
          totalMessages += 1;
          messagesThisRound += 1;
          if (totalMessages >= maxMemberTurns) {
            hitCap = true;
            break;
          }
        }
        this.deps.finalizeMemberTurn?.(member);
        if (hitCap) return;
      }

      // Everyone passed (or every turn failed) — no idle rounds.
      if (messagesThisRound === 0) return;
    }
  }

  async runOneTurn(
    group: GroupDescription,
    member: GroupMember,
    members: readonly GroupMember[],
  ): Promise<string[]> {
    const peers = members.filter((other) => other.id !== member.id);
    const history = this.deps.readHistory();
    const newMessages = messagesSinceMemberLastSpoke(history, member.id);
    const sent = await this.deps.runMemberTurn({
      member,
      systemPrompt: buildGroupMemberSystemPrompt(member, group, peers),
      prompt: buildGroupTurnPrompt({ member, group, peers, newMessages }),
    });

    const spoken: string[] = [];
    for (const content of sent) {
      if (isPassContent(content)) continue;
      const trimmed = content.trim();
      if (trimmed.length === 0) continue;
      spoken.push(trimmed);
      if (spoken.length >= GROUP_MAX_MESSAGES_PER_TURN) break;
    }
    return spoken;
  }
}
