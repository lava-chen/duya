// @ts-nocheck
/**
 * Feishu Document Comment Handler
 *
 * Handles Feishu document comment events and AI-powered replies.
 * Integrates with duya's AI agent via GatewayManager IPC.
 */

import type { FeishuEvent, FeishuConfigOptions } from './types.js';
import {
  resolveRule,
  isUserAllowed,
  loadPairingList,
  invalidateRulesCache,
} from './comment-rules.js';

interface CommentEvent {
  eventId: string;
  commentId: string;
  replyId: string;
  isMentioned: boolean;
  timestamp: string;
  fileToken: string;
  fileType: string;
  noticeType: string;
  fromOpenId: string;
  toOpenId: string;
}

interface DocumentMeta {
  title: string;
  url: string;
  docType: string;
}

interface CommentDetail {
  isWhole: boolean;
  quote: string;
  replies: CommentReply[];
}

interface CommentReply {
  replyId: string;
  userId: string;
  text: string;
  createTime: string;
}

interface SessionEntry {
  messages: Array<{ role: string; content: string; ts: number }>;
  lastUpdate: number;
}

const MAX_SESSION_MESSAGES = 50;
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const COMMENT_RETRY_LIMIT = 6;
const COMMENT_RETRY_DELAY_MS = 1000;

export class FeishuCommentHandler {
  private fileToken = '';
  private fileType = '';
  private appId = '';
  private appSecret = '';
  private accessToken = '';
  private tokenExpiresAt = 0;
  private baseUrl = 'https://open.feishu.cn/open-apis';
  private domain: 'feishu' | 'lark' = 'feishu';
  private sessionCache = new Map<string, SessionEntry>();
  private onInboundMessage: ((msg: CommentInboundMessage) => void) | null = null;

  constructor(options?: FeishuConfigOptions) {
    if (options) {
      this.configure(options);
    }
  }

  configure(options: FeishuConfigOptions): void {
    this.appId = options.app_id ?? '';
    this.appSecret = options.app_secret ?? '';
    this.domain = options.domain ?? 'feishu';
    this.baseUrl = this.domain === 'lark' ? 'https://open.larksuite.com/open-apis' : 'https://open.feishu.cn/open-apis';
  }

  /** Stop handler and cleanup */
  stop(): void {
    this.sessionCache.clear();
  }

  setOnInboundMessage(handler: (msg: CommentInboundMessage) => void): void {
    this.onInboundMessage = handler;
  }

  /** Handle document comment event */
  async handleCommentEvent(event: FeishuEvent, botOpenId: string): Promise<void> {
    const commentEvent = this.parseDriveCommentEvent(event);
    if (!commentEvent) {
      console.log('[Feishu Comment] Failed to parse drive comment event');
      return;
    }

    console.log('[Feishu Comment] Event parsed:', {
      eventId: commentEvent.eventId,
      commentId: commentEvent.commentId,
      fileToken: commentEvent.fileToken,
      fileType: commentEvent.fileType,
      fromOpenId: commentEvent.fromOpenId,
    });

    // Skip self-reply to avoid loops
    if (commentEvent.fromOpenId === botOpenId) {
      console.log('[Feishu Comment] Skipping self-reply');
      return;
    }

    // Skip if not addressed to bot
    if (commentEvent.toOpenId && commentEvent.toOpenId !== botOpenId) {
      console.log('[Feishu Comment] Not addressed to this bot, skipping');
      return;
    }

    // Check allowed notice types
    if (commentEvent.noticeType && !['add_comment', 'add_reply'].includes(commentEvent.noticeType)) {
      console.log('[Feishu Comment] Skipping notice_type:', commentEvent.noticeType);
      return;
    }

    if (!commentEvent.fileToken || !commentEvent.fileType || !commentEvent.commentId) {
      console.log('[Feishu Comment] Missing required fields');
      return;
    }

    this.fileToken = commentEvent.fileToken;
    this.fileType = commentEvent.fileType;

    // Check access control
    const docKey = `${commentEvent.fileType}:${commentEvent.fileToken}`;
    const rule = resolveRule(docKey);

    if (!rule.enabled) {
      console.log('[Feishu Comment] Comment handling disabled for:', docKey);
      return;
    }

    if (!isUserAllowed(commentEvent.fromOpenId, rule)) {
      console.log('[Feishu Comment] User not allowed:', commentEvent.fromOpenId, 'policy:', rule.policy);
      return;
    }

    console.log('[Feishu Comment] Access granted for user:', commentEvent.fromOpenId);

    // Add OK reaction
    if (commentEvent.replyId) {
      this.addCommentReaction(commentEvent.fileToken, commentEvent.fileType, commentEvent.replyId, 'OK').catch((err) => {
        console.warn('[Feishu Comment] Failed to add reaction:', err);
      });
    }

    // Build comment context and send to AI
    try {
      await this.processCommentWithAI(commentEvent);
    } catch (err) {
      console.error('[Feishu Comment] Error processing comment:', err);
    }

    // Remove OK reaction (best effort)
    if (commentEvent.replyId) {
      this.deleteCommentReaction(commentEvent.fileToken, commentEvent.fileType, commentEvent.replyId, 'OK').catch(() => {});
    }
  }

  /** Parse drive.notice.comment_add_v1 event */
  private parseDriveCommentEvent(event: FeishuEvent): CommentEvent | null {
    const e = event.event as unknown as Record<string, unknown>;
    if (!e) return null;

    const noticeMeta = (e.notice_meta as Record<string, unknown>) ?? {};

    const fromUser = (noticeMeta.from_user_id as Record<string, unknown>) ?? {};
    const toUser = (noticeMeta.to_user_id as Record<string, unknown>) ?? {};

    return {
      eventId: String(e.event_id ?? ''),
      commentId: String(e.comment_id ?? ''),
      replyId: String(e.reply_id ?? ''),
      isMentioned: Boolean(e.is_mentioned),
      timestamp: String(e.timestamp ?? ''),
      fileToken: String(noticeMeta.file_token ?? ''),
      fileType: String(noticeMeta.file_type ?? ''),
      noticeType: String(noticeMeta.notice_type ?? ''),
      fromOpenId: String(fromUser.open_id ?? ''),
      toOpenId: String(toUser.open_id ?? ''),
    };
  }

  /** Process comment with AI */
  private async processCommentWithAI(commentEvent: CommentEvent): Promise<void> {
    // Fetch document meta and comment details in parallel
    const [meta, commentDetail] = await Promise.all([
      this.queryDocumentMeta(commentEvent.fileToken, commentEvent.fileType),
      this.batchQueryComment(commentEvent.fileToken, commentEvent.fileType, commentEvent.commentId),
    ]);

    if (!meta || !commentDetail) {
      console.error('[Feishu Comment] Failed to fetch document or comment details');
      return;
    }

    const docTitle = meta.title || 'Untitled';
    const docUrl = meta.url || '';
    const isWhole = commentDetail.isWhole;
    const quoteText = commentDetail.quote;

    console.log('[Feishu Comment] Document:', docTitle, 'is_whole:', isWhole);

    // Fetch timeline (whole comments or local thread)
    let timeline: CommentReply[] = [];
    let currentReplyText = '';

    if (isWhole) {
      timeline = await this.listWholeComments(commentEvent.fileToken, commentEvent.fileType);
      // Find the current reply text
      const currentReply = timeline.find((r) => r.replyId === commentEvent.replyId);
      if (currentReply) {
        currentReplyText = currentReply.text;
      } else if (timeline.length > 0) {
        // Fallback to last reply
        const last = timeline[timeline.length - 1];
        currentReplyText = last?.text ?? '';
      }
    } else {
      timeline = await this.listCommentReplies(commentEvent.fileToken, commentEvent.fileType, commentEvent.commentId);
      // Find the root and target text
      if (timeline.length > 0) {
        currentReplyText = timeline.find((r) => r.replyId === commentEvent.replyId)?.text ?? timeline[timeline.length - 1]?.text ?? '';
      }
    }

    if (!currentReplyText) {
      console.warn('[Feishu Comment] No reply text found');
      return;
    }

    // Build prompt for AI
    const prompt = this.buildCommentPrompt({
      docTitle,
      docUrl,
      fileToken: commentEvent.fileToken,
      fileType: commentEvent.fileType,
      commentId: commentEvent.commentId,
      isWhole,
      quoteText,
      rootCommentText: timeline[0]?.text ?? '',
      targetReplyText: currentReplyText,
      timeline,
    });

    console.log('[Feishu Comment] Built prompt, sending to AI...');

    // Send to AI via IPC
    if (this.onInboundMessage) {
      const sessionKey = `comment-${commentEvent.fileToken}`;
      const inboundMsg: CommentInboundMessage = {
        platform: 'feishu',
        platformUserId: commentEvent.fromOpenId,
        platformChatId: `comment:${commentEvent.fileToken}`,
        platformMsgId: commentEvent.commentId,
        text: prompt,
        ts: Date.now(),
        threadId: sessionKey,
        commentContext: {
          docTitle,
          docUrl,
          isWhole,
          commentId: commentEvent.commentId,
          fileToken: commentEvent.fileToken,
          fileType: commentEvent.fileType,
        },
      };

      this.onInboundMessage(inboundMsg);

      // Store this request to handle response later
      this.addToSession(sessionKey, 'user', prompt);
    }
  }

  /** Build prompt for comment AI */
  private buildCommentPrompt(ctx: {
    docTitle: string;
    docUrl: string;
    fileToken: string;
    fileType: string;
    commentId: string;
    isWhole: boolean;
    quoteText: string;
    rootCommentText: string;
    targetReplyText: string;
    timeline: CommentReply[];
  }): string {
    const lines: string[] = [];

    if (ctx.isWhole) {
      lines.push(`The user added a comment in "${ctx.docTitle}".`);
      lines.push(`Current user comment text: "${this.truncate(ctx.targetReplyText, 220)}"`);
      lines.push('This is a whole-document comment.');
      lines.push('This comment mentioned you (@mention is for routing, not task content).');
      lines.push(`Document link: ${ctx.docUrl}`);
      lines.push(`Current commented document:`);
      lines.push(`- file_type=${ctx.fileType}`);
      lines.push(`- file_token=${ctx.fileToken}`);
      lines.push('');
      lines.push(`Whole-document comment timeline (${ctx.timeline.length} entries):`);
    } else {
      lines.push(`The user added a reply in "${ctx.docTitle}".`);
      lines.push(`Current user comment text: "${this.truncate(ctx.targetReplyText, 220)}"`);
      if (ctx.rootCommentText) {
        lines.push(`Original comment text: "${this.truncate(ctx.rootCommentText, 220)}"`);
      }
      if (ctx.quoteText) {
        lines.push(`Quoted content: "${this.truncate(ctx.quoteText, 500)}"`);
      }
      lines.push('This comment mentioned you (@mention is for routing, not task content).');
      lines.push(`Document link: ${ctx.docUrl}`);
      lines.push(`Current commented document:`);
      lines.push(`- file_type=${ctx.fileType}`);
      lines.push(`- file_token=${ctx.fileToken}`);
      lines.push(`- comment_id=${ctx.commentId}`);
      lines.push('');
      lines.push(`Current comment card timeline (${ctx.timeline.length} entries):`);
    }

    // Add timeline entries (limit to avoid token overflow)
    const selected = this.selectTimeline(ctx.timeline, ctx.targetReplyText);
    for (const reply of selected) {
      const marker = reply.userId === 'self' ? ' <-- YOU' : '';
      lines.push(`[${reply.userId}] ${this.truncate(reply.text, 200)}${marker}`);
    }

    lines.push('');
    lines.push('This is a Feishu document comment thread, not an IM chat.');
    lines.push('Your reply will be posted automatically. Just output the reply text.');
    lines.push('Use the thread timeline above as the main context.');
    lines.push('Reply in the same language as the user\'s comment unless they request otherwise.');
    lines.push('Use plain text only. Do not use Markdown, headings, bullet lists, tables, or code blocks.');
    lines.push('Do not show your reasoning process. Do not start with "I will", "Let me", or "I\'ll first".');
    lines.push('Output only the final user-facing reply.');
    lines.push('If no reply is needed, output exactly NO_REPLY.');

    return lines.join('\n');
  }

  /** Select relevant timeline entries */
  private selectTimeline(timeline: CommentReply[], targetText: string): CommentReply[] {
    const limit = 20;
    if (timeline.length <= limit) return timeline;

    const selected: CommentReply[] = [];
    const targetIndex = timeline.findIndex((r) => r.text === targetText);

    // Always include first
    selected.push(timeline[0]);

    // Always include target if found
    if (targetIndex >= 0 && targetIndex < timeline.length) {
      selected.push(timeline[targetIndex]);
    }

    // Always include last
    selected.push(timeline[timeline.length - 1]);

    // Expand around target
    let lo = targetIndex - 1;
    let hi = targetIndex + 1;
    while (selected.length < limit && (lo >= 0 || hi < timeline.length)) {
      if (lo >= 0 && !selected.find((r) => r.replyId === timeline[lo].replyId)) {
        selected.push(timeline[lo]);
      }
      lo--;
      if (hi < timeline.length && !selected.find((r) => r.replyId === timeline[hi].replyId)) {
        selected.push(timeline[hi]);
      }
      hi++;
    }

    return selected.sort((a, b) => timeline.indexOf(a) - timeline.indexOf(b));
  }

  /** Truncate text */
  private truncate(text: string, limit: number): string {
    if (text.length <= limit) return text;
    return text.substring(0, limit) + '...';
  }

  // ---------------------------------------------------------------------------
  // Feishu API calls
  // ---------------------------------------------------------------------------

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.accessToken && now < this.tokenExpiresAt - 60_000) {
      return this.accessToken;
    }

    const response = await fetch(`${this.baseUrl}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });

    if (!response.ok) {
      throw new Error(`Failed to get access token: ${response.status}`);
    }

    const data = (await response.json()) as { tenant_access_token?: string; expire?: number };
    this.accessToken = data.tenant_access_token ?? '';
    this.tokenExpiresAt = now + (data.expire ?? 7200) * 1000;
    console.log('[Feishu Comment] Access token refreshed');
    return this.accessToken;
  }

  private async apiRequest<T>(path: string, options?: { method?: string; body?: unknown; queries?: Record<string, string> }): Promise<T> {
    const token = await this.getAccessToken();
    const searchParams = options?.queries
      ? '?' + new URLSearchParams(options.queries).toString()
      : '';
    const response = await fetch(`${this.baseUrl}${path}${searchParams}`, {
      method: options?.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: options?.body ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Feishu API error ${response.status}: ${errorText}`);
    }

    return (await response.json()) as T;
  }

  private async queryDocumentMeta(fileToken: string, fileType: string): Promise<DocumentMeta | null> {
    try {
      const data = await this.apiRequest<{
        data?: { metas?: Array<{ title?: string; url?: string; doc_type?: string }> };
      }>('/drive/v1/metas/batch_query', {
        method: 'POST',
        body: {
          request_docs: [{ doc_token: fileToken, doc_type: fileType }],
          with_url: true,
        },
      });

      const metas = data.data?.metas;
      if (metas && metas.length > 0) {
        return {
          title: metas[0].title ?? '',
          url: metas[0].url ?? '',
          docType: metas[0].doc_type ?? fileType,
        };
      }
      return null;
    } catch (err) {
      console.error('[Feishu Comment] Failed to query document meta:', err);
      return null;
    }
  }

  private async batchQueryComment(fileToken: string, fileType: string, commentId: string): Promise<CommentDetail | null> {
    for (let attempt = 0; attempt < COMMENT_RETRY_LIMIT; attempt++) {
      try {
        const data = await this.apiRequest<{
          data?: { items?: Array<{
            is_whole?: boolean;
            quote?: string;
            reply_list?: { replies?: Array<{ reply_id?: string; user_id?: string; create_time?: string; content?: string }> };
          }> };
        }>(`/drive/v1/files/${fileToken}/comments/batch_query`, {
          method: 'POST',
          body: {
            comment_ids: [commentId],
          },
          queries: { file_type: fileType, user_id_type: 'open_id' },
        });

        const items = data.data?.items;
        if (items && items.length > 0) {
          const item = items[0];
          const replyList = item.reply_list ?? {};
          const replies = (replyList.replies ?? []).map((r) => ({
            replyId: String(r.reply_id ?? ''),
            userId: String(r.user_id ?? ''),
            createTime: String(r.create_time ?? ''),
            text: this.extractReplyText(r.content),
          }));

          return {
            isWhole: item.is_whole ?? false,
            quote: item.quote ?? '',
            replies,
          };
        }
        return null;
      } catch (err) {
        console.warn(`[Feishu Comment] batch_query retry ${attempt + 1}/${COMMENT_RETRY_LIMIT}:`, err);
        if (attempt < COMMENT_RETRY_LIMIT - 1) {
          await this.delay(COMMENT_RETRY_DELAY_MS);
        }
      }
    }
    return null;
  }

  private async listWholeComments(fileToken: string, fileType: string): Promise<CommentReply[]> {
    const allReplies: CommentReply[] = [];
    let pageToken = '';

    for (let page = 0; page < 5; page++) {
      try {
        const queries: Array<[string, string]> = [
          ['file_type', fileType],
          ['is_whole', 'true'],
          ['page_size', '100'],
          ['user_id_type', 'open_id'],
        ];
        if (pageToken) {
          queries.push(['page_token', pageToken]);
        }

        const queryString = queries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
        const data = await this.apiRequest<{
          data?: {
            items?: Array<{
              reply_list?: { replies?: Array<{ reply_id?: string; user_id?: string; create_time?: string; content?: string }> };
            }>;
            has_more?: boolean;
            page_token?: string;
          };
        }>(`/drive/v1/files/${fileToken}/comments?${queryString}`);

        for (const item of data.data?.items ?? []) {
          for (const reply of item.reply_list?.replies ?? []) {
            allReplies.push({
              replyId: String(reply.reply_id ?? ''),
              userId: String(reply.user_id ?? ''),
              createTime: String(reply.create_time ?? ''),
              text: this.extractReplyText(reply.content),
            });
          }
        }

        if (!data.data?.has_more) break;
        pageToken = data.data?.page_token ?? '';
      } catch (err) {
        console.error('[Feishu Comment] list_whole_comments failed:', err);
        break;
      }
    }

    return allReplies;
  }

  private async listCommentReplies(fileToken: string, fileType: string, commentId: string): Promise<CommentReply[]> {
    const allReplies: CommentReply[] = [];
    let pageToken = '';

    for (let page = 0; page < 5; page++) {
      try {
        const queries: Array<[string, string]> = [
          ['file_type', fileType],
          ['page_size', '100'],
          ['user_id_type', 'open_id'],
        ];
        if (pageToken) {
          queries.push(['page_token', pageToken]);
        }

        const queryString = queries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
        const data = await this.apiRequest<{
          data?: {
            items?: Array<{
              reply_id?: string;
              user_id?: string;
              create_time?: string;
              content?: string;
            }>;
            has_more?: boolean;
            page_token?: string;
          };
        }>(`/drive/v1/files/${fileToken}/comments/${commentId}/replies?${queryString}`);

        for (const reply of data.data?.items ?? []) {
          allReplies.push({
            replyId: String(reply.reply_id ?? ''),
            userId: String(reply.user_id ?? ''),
            createTime: String(reply.create_time ?? ''),
            text: this.extractReplyText(reply.content),
          });
        }

        if (!data.data?.has_more) break;
        pageToken = data.data?.page_token ?? '';
      } catch (err) {
        console.error('[Feishu Comment] list_replies failed:', err);
        break;
      }
    }

    return allReplies;
  }

  private extractReplyText(content: unknown): string {
    if (!content) return '';
    let parsed = content;
    if (typeof content === 'string') {
      try {
        parsed = JSON.parse(content);
      } catch {
        return content;
      }
    }

    const c = parsed as Record<string, unknown>;
    const elements = c.elements as Array<Record<string, unknown>> | undefined;
    if (!elements) return String(content);

    const parts: string[] = [];
    for (const elem of elements) {
      if (elem.type === 'text_run') {
        const textRun = elem.text_run as Record<string, unknown> | undefined;
        parts.push(String(textRun?.text ?? ''));
      }
    }
    return parts.join('');
  }

  /** Add reaction to comment reply */
  private async addCommentReaction(fileToken: string, fileType: string, replyId: string, reactionType: string): Promise<void> {
    try {
      await this.apiRequest(`/drive/v2/files/${fileToken}/comments/reaction`, {
        method: 'POST',
        body: {
          action: 'add',
          reply_id: replyId,
          reaction_type: reactionType,
        },
        queries: { file_type: fileType },
      });
    } catch (err) {
      console.warn('[Feishu Comment] add reaction failed:', err);
    }
  }

  /** Delete reaction from comment reply */
  private async deleteCommentReaction(fileToken: string, fileType: string, replyId: string, reactionType: string): Promise<void> {
    try {
      await this.apiRequest(`/drive/v2/files/${fileToken}/comments/reaction`, {
        method: 'POST',
        body: {
          action: 'delete',
          reply_id: replyId,
          reaction_type: reactionType,
        },
        queries: { file_type: fileType },
      });
    } catch (err) {
      console.warn('[Feishu Comment] delete reaction failed:', err);
    }
  }

  /** Reply to comment thread */
  async replyToComment(fileToken: string, fileType: string, commentId: string, text: string): Promise<boolean> {
    const sanitized = this.sanitizeCommentText(text);

    try {
      const data = await this.apiRequest<{ code?: number; msg?: string }>(
        `/drive/v1/files/${fileToken}/comments/${commentId}/replies`,
        {
          method: 'POST',
          body: {
            content: {
              elements: [{ type: 'text_run', text_run: { text: sanitized } }],
            },
          },
          queries: { file_type: fileType },
        }
      );

      if (data.code === 0) {
        console.log('[Feishu Comment] Reply posted successfully');
        return true;
      }
      console.warn('[Feishu Comment] Reply failed:', data.msg);
      return false;
    } catch (err) {
      console.error('[Feishu Comment] Reply to comment failed:', err);
      return false;
    }
  }

  /** Add whole-document comment */
  async addWholeComment(fileToken: string, fileType: string, text: string): Promise<boolean> {
    const sanitized = this.sanitizeCommentText(text);

    try {
      const data = await this.apiRequest<{ code?: number; msg?: string }>(
        `/drive/v1/files/${fileToken}/new_comments`,
        {
          method: 'POST',
          body: {
            file_type: fileType,
            reply_elements: [{ type: 'text', text: sanitized }],
          },
        }
      );

      if (data.code === 0) {
        console.log('[Feishu Comment] Whole comment added successfully');
        return true;
      }
      console.warn('[Feishu Comment] add_whole_comment failed:', data.msg);
      return false;
    } catch (err) {
      console.error('[Feishu Comment] add_whole_comment failed:', err);
      return false;
    }
  }

  /** Deliver comment reply with fallback */
  async deliverCommentReply(fileToken: string, fileType: string, commentId: string, text: string, isWhole: boolean): Promise<boolean> {
    // Chunk long text
    const chunks = this.chunkText(text, 4000);
    console.log(`[Feishu Comment] Delivering reply: ${chunks.length} chunk(s), ${text.length} chars, isWhole=${isWhole}`);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (chunks.length > 1) {
        console.log(`[Feishu Comment] Sending chunk ${i + 1}/${chunks.length} (${chunk.length} chars)`);
      }

      let success: boolean;
      if (isWhole) {
        success = await this.addWholeComment(fileToken, fileType, chunk);
      } else {
        const result = await this.replyToComment(fileToken, fileType, commentId, chunk);
        success = result;
        // Fallback to whole comment on 1069302 (reply not allowed)
        if (!success && i === 0) {
          console.log('[Feishu Comment] Reply not allowed, falling back to add_whole_comment');
          success = await this.addWholeComment(fileToken, fileType, chunk);
          // Subsequent chunks also use whole comment
          if (success) {
            isWhole = true;
          }
        }
      }

      if (!success) {
        console.error('[Feishu Comment] Failed to deliver chunk', i + 1);
        return false;
      }
    }

    return true;
  }

  /** Sanitize text for comment content */
  private sanitizeCommentText(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /** Chunk text for delivery */
  private chunkText(text: string, limit: number): string[] {
    if (text.length <= limit) return [text];

    const chunks: string[] = [];
    while (text) {
      if (text.length <= limit) {
        chunks.push(text);
        break;
      }

      // Find last newline within limit
      let cut = text.lastIndexOf('\n', limit);
      if (cut <= 0) {
        cut = limit;
      }
      chunks.push(text.substring(0, cut));
      text = text.substring(cut).trimStart();
    }
    return chunks;
  }

  /** Delay helper */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ---------------------------------------------------------------------------
  // Session management
  // ---------------------------------------------------------------------------

  /** Get or create session for document */
  private getSession(fileKey: string): SessionEntry {
    const now = Date.now();
    const existing = this.sessionCache.get(fileKey);

    if (existing && now - existing.lastUpdate < SESSION_TTL_MS) {
      existing.lastUpdate = now;
      return existing;
    }

    const session: SessionEntry = { messages: [], lastUpdate: now };
    this.sessionCache.set(fileKey, session);
    this.cleanupSessions();
    return session;
  }

  /** Add message to session */
  private addToSession(fileKey: string, role: string, content: string): void {
    const session = this.getSession(fileKey);
    session.messages.push({ role, content, ts: Date.now() });
    while (session.messages.length > MAX_SESSION_MESSAGES) {
      session.messages.shift();
    }
  }

  /** Get session messages */
  getSessionHistory(fileKey: string): Array<{ role: string; content: string }> {
    const session = this.sessionCache.get(fileKey);
    if (!session) return [];
    return session.messages.map((m) => ({ role: m.role, content: m.content }));
  }

  /** Clean up expired sessions */
  private cleanupSessions(): void {
    const now = Date.now();
    for (const [key, session] of this.sessionCache.entries()) {
      if (now - session.lastUpdate > SESSION_TTL_MS) {
        this.sessionCache.delete(key);
      }
    }
  }
}

// Comment inbound message type
export interface CommentInboundMessage {
  platform: string;
  platformUserId: string;
  platformChatId: string;
  platformMsgId: string;
  text: string;
  ts: number;
  threadId?: string;
  commentContext?: {
    docTitle: string;
    docUrl: string;
    isWhole: boolean;
    commentId: string;
    fileToken: string;
    fileType: string;
  };
}