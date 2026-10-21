import type {
  ChannelBindingInput,
  ChannelBindingRow,
  ChannelOffsetInput,
  ChannelOffsetRow,
  WeixinContextTokenInput,
} from '@duya/agent-protocol/channel-persistence';
import type { SqliteDatabase } from './sqlite-connection.js';

/** Data-owned SQLite persistence for channel session bindings and offsets. */
export class ChannelPersistenceStore {
  constructor(private readonly db: SqliteDatabase) {}

  listBindings(channelType?: string): ChannelBindingRow[] {
    return (channelType
      ? this.db.prepare(
          'SELECT * FROM channel_bindings WHERE channel_type = ? ORDER BY updated_at DESC',
        ).all(channelType)
      : this.db.prepare('SELECT * FROM channel_bindings ORDER BY updated_at DESC').all()) as ChannelBindingRow[];
  }

  getBinding(channelType: string, chatId: string): ChannelBindingRow | null {
    return (this.db.prepare(
      'SELECT * FROM channel_bindings WHERE channel_type = ? AND chat_id = ?',
    ).get(channelType, chatId) as ChannelBindingRow | undefined) ?? null;
  }

  upsertBinding(input: ChannelBindingInput, now = Date.now()): ChannelBindingRow | null {
    this.db.prepare(`
      INSERT INTO channel_bindings (id, channel_type, chat_id, duya_session_id, sdk_session_id, working_directory, model, mode, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        duya_session_id = excluded.duya_session_id,
        sdk_session_id = COALESCE(excluded.sdk_session_id, sdk_session_id),
        working_directory = COALESCE(excluded.working_directory, working_directory),
        model = COALESCE(excluded.model, model),
        mode = COALESCE(excluded.mode, mode),
        updated_at = excluded.updated_at
    `).run(
      input.id,
      input.channel_type,
      input.chat_id,
      input.duya_session_id,
      input.sdk_session_id || '',
      input.working_directory || '',
      input.model || '',
      input.mode || 'code',
      now,
      now,
    );
    return (this.db.prepare('SELECT * FROM channel_bindings WHERE id = ?').get(input.id) as ChannelBindingRow | undefined) ?? null;
  }

  getOffset(channelType: string, offsetKey: string): ChannelOffsetRow | null {
    return (this.db.prepare(
      'SELECT * FROM channel_offsets WHERE channel_type = ? AND offset_key = ?',
    ).get(channelType, offsetKey) as ChannelOffsetRow | undefined) ?? null;
  }

  setOffset(input: ChannelOffsetInput, now = Date.now()): void {
    this.db.prepare(`
      INSERT INTO channel_offsets (channel_type, offset_key, offset_value, offset_type, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(channel_type, offset_key) DO UPDATE SET
        offset_value = excluded.offset_value,
        offset_type = COALESCE(excluded.offset_type, offset_type),
        updated_at = excluded.updated_at
    `).run(
      input.channelType,
      input.offsetKey,
      input.offsetValue,
      input.offsetType || 'long_polling',
      now,
    );
  }

  getWeixinContextToken(accountId: string, peerUserId: string): string | null {
    const row = this.db.prepare(
      'SELECT context_token FROM weixin_context_tokens WHERE account_id = ? AND peer_user_id = ?',
    ).get(accountId, peerUserId) as { context_token: string } | undefined;
    return row?.context_token || null;
  }

  setWeixinContextToken(input: WeixinContextTokenInput, now = Date.now()): void {
    this.db.prepare(`
      INSERT INTO weixin_context_tokens (account_id, peer_user_id, context_token, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id, peer_user_id) DO UPDATE SET
        context_token = excluded.context_token,
        updated_at = excluded.updated_at
    `).run(input.accountId, input.peerUserId, input.contextToken, now);
  }

  deleteWeixinContextTokens(accountId: string): void {
    this.db.prepare('DELETE FROM weixin_context_tokens WHERE account_id = ?').run(accountId);
  }
}
