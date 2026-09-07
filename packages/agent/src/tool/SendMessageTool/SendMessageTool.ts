/**
 * SendMessage Tool Implementation (Plan 483 P2 + Plan 488 P2.1 + Plan 489 P0.2)
 *
 * Grok-bot semantics:
 * - SendMessage is the ONLY way for a bot to communicate with the user
 * - Plain assistant text is invisible to the user - only SendMessage calls reach them
 * - Messages are delivered to the current user in the current conversation
 * - No sessionId parameter needed - uses context.options.sessionId
 *
 * Plan 489 P0.2 (correct logic, Plan 489 revised):
 * - SendMessage writes to the messages table via the NORMAL session mechanism
 *   (messageDb.append) — same path as thinking / tool_use / assistant text.
 * - The message is tagged with `source: 'send_message'` so the bot-direct
 *   projection (BotDirectChatView) can show only SendMessage output.
 * - No separate `bot_transcript_entries` table; everything flows through the
 *   standard messages table → JSONL rollouts pipeline.
 *
 * Plan 488 P2.1 (channel field extension):
 * - input.channel: string (platform:chat token, e.g. "slack:C12345")
 * - When channel is set: route via channelDb.deliver (db-bridge IPC → ChannelBackgroundWakes)
 * - When channel is absent: append to the conversation transcript via messageDb.append
 * - channel only valid for type:text or type:attachment (validated above)
 */

import { randomUUID } from 'node:crypto';
import { messageDb, sendMessageStateDb } from '../../ipc/db-client.js';
import { getLogger } from '../../utils/logger.js';
import { SEND_MESSAGE_TOOL_NAME } from './constants.js';
import type { ToolUseContext } from '../../types.js';

const MAX_CONTENT_LENGTH = 8000;
const MAX_CHANNEL_CONTENT_LENGTH = 8000;

// ─── Input schema ────────────────────────────────────────────────────────
// Field descriptions ported from grok-bot 0.18 send-message-schema.ts so the
// model gets the same per-field usage semantics at the schema layer.
const SEND_MESSAGE_SCHEMA = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: ['text', 'attachment', 'widget', 'cursor-agent', 'secret-request'],
      description:
        'text for chat messages, attachment for actual files or standalone media, widget for an interactive question with selectable options, cursor-agent to reference a Cursor cloud agent by its bcId, secret-request to ask the user for a credential through a secure masked input (never a chat paste).',
    },
    content: {
      type: 'string',
      description: 'Required when type is text. The message to show to the user.',
    },
    url: {
      type: 'string',
      description:
        'Required when type is attachment. Use file:// for local files or https:// for remote files and standalone media.',
    },
    images: {
      type: 'array',
      description:
        "Optional, only for type:text. Image(s) that belong with this message; they render inside the same chat bubble, below your text — one image full width, several as a compact gallery. Use whenever you're showing something you're talking about; use type:attachment only for an image that IS the whole message.",
      items: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'file:// or https:// URL of the image.' },
          alt: {
            type: 'string',
            description:
              'Optional short description of this image, shown on hover and as its fullscreen caption.',
          },
        },
        required: ['url'],
      },
    },
    alt: {
      type: 'string',
      description:
        'Optional. A short description (alt text) of the image for type:attachment — what the image shows. Shown to the user on hover and in the fullscreen viewer.',
    },
    reply_to: {
      type: 'string',
      description: 'Optional. Id of the prior message this reply threads to. Omit when not threading.',
    },
    channel: {
      type: 'string',
      description:
        'Optional. A connected messaging channel address to deliver this to instead of the in-app chat, shaped platform:chat — the address shown to you in an [inbound] wake. Omit to send to the in-app chat (the default). Only valid with type:text or type:attachment.',
    },
    widget: {
      type: 'object',
      description:
        "Required when type is widget. A question with selectable options: { prompt, helpText?, options: [{ label, value?, description?, style? }], allowCustom?, dismissOnMoveOn? }. The user picks one option; its value comes back as their reply, and the chat shows the resolved card with their selection checked under your prompt — so phrase the prompt as a natural question, not a menu instruction. The user can also dismiss the question without answering; you'll be told on your next turn, so treat that as a decline and don't re-ask. Set allowCustom: true to also let the user type their own free-text answer instead of picking an option. Set dismissOnMoveOn: true only for low-stakes questions that become moot if the user moves on (it auto-dismisses once they send a newer message without answering); leave it off for real decisions you still need answered.",
      properties: {
        prompt: {
          type: 'string',
          description: 'The question, phrased as a natural conversational question (never a menu instruction).',
        },
        helpText: { type: 'string', description: 'Optional short help shown under the question.' },
        options: {
          type: 'array',
          description:
            '1-6 real, verified choices. Each value should read like a reply the user would actually send.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'The choice shown on the button.' },
              value: {
                type: 'string',
                description: 'The text sent back to you when confirmed; defaults to the label.',
              },
              description: { type: 'string', description: 'Optional short explanation of this option.' },
              style: { type: 'string', enum: ['default', 'primary', 'danger'] },
            },
            required: ['label'],
          },
        },
        allowCustom: {
          type: 'boolean',
          description: 'Also let the user type their own free-text answer instead of picking an option.',
        },
        dismissOnMoveOn: {
          type: 'boolean',
          description:
            'Auto-dismiss once the user sends a newer message without answering; only for low-stakes questions.',
        },
      },
      required: ['prompt', 'options'],
    },
    bcId: {
      type: 'string',
      description:
        'Required when type is cursor-agent. The bcId of the Cursor cloud agent to reference (e.g. bc-xxxxxxxx-...).',
    },
    secret: {
      type: 'object',
      description:
        'Required when type is secret-request. Asks the user for a credential through a masked secure input; the value goes straight to the secret store and never reaches you or the chat. You only learn that it was provided.',
      properties: {
        label: {
          type: 'string',
          description:
            'What credential to ask for, shown as the card title and echoed in the field placeholder ("Paste your …"), e.g. "Slack bot token".',
        },
        description: { type: 'string', description: 'Optional short help shown under the label.' },
        connector: {
          type: 'string',
          description: "The connector/platform the secret is for. The value is written to that connector's credential store.",
        },
        field: {
          type: 'string',
          description: 'The credential field name to store the value under, e.g. "token".',
        },
      },
      required: ['label', 'connector', 'field'],
    },
  },
  required: ['type'],
} as const;

// Grok-bot's SendMessage description (0.18) ported with duya adaptations.
// Dropped (no duya counterpart): sand-msg reference links (renderer has no
// jump-chip), request_box_help (no such tool), the Cursor-specific card
// wording for cursor-agent (kept minimal for schema compat). Adapted:
// "Grok Bot chat" → chat, [routine] runs → scheduled automation runs,
// OS permission dialogs → duya permission cards. Everything else verbatim.
const SEND_MESSAGE_DESCRIPTION = `Say something to the user in the chat. This is your only voice. The user only ever sees the content of SendMessage calls; your plain assistant text is invisible to them (it is just your private scratchpad), so a reply counts only once it is inside SendMessage, including short, casual, or social replies like "Hey" or "Doing good, you?". Finish a turn where someone is waiting on you without calling SendMessage and they see total silence and assume you ignored them; the lone exception is a scheduled automation run whose saved instruction says to stay quiet when there's nothing to report, where ending with no SendMessage is correct rather than filler like "(no change.)". Keep the user posted with meaningful beats, not just at the end: post an update for a real result, decision, blocker, or change of plan, and batch or omit routine mechanics, retries, and minor snags rather than narrating each one; prefer fewer, higher-signal updates over a play-by-play. Still, never vanish into a long silent run on something the user is waiting on. This also covers results: output the user is waiting on counts as delivered only inside a SendMessage, so an opening acknowledgement does not discharge it (ack ≠ delivery), and if you ran something for them you send the actual result before you yield. Use {"type":"text","content":"..."} for normal messages. Use {"type":"attachment","url":"file:///absolute/path/to/file.png"} for actual files or standalone media; https:// file/media URLs are also accepted. When delivering to an external channel, file:// attachment URLs are uploaded as real files (photo or document bubbles on the platform), while https:// URLs are sent as links. The rule for images: if image(s) belong WITH what you're saying, attach them to the text message itself — {"type":"text","content":"...","images":[{"url":"file:///absolute/path/to/shot.png","alt":"..."}]} renders them inside the same chat bubble, below your text (one image full width, several as a compact gallery). Use {"type":"attachment"} only when the image IS the whole message, with no accompanying text; videos and non-image files always go as attachments. Never embed images as markdown ![](...) in content. Use {"type":"widget","widget":{...}} to ask the user a question with selectable options instead of asking in plain text — but ask rarely: by default decide and proceed, reserving a widget for a consequential or destructive go/no-go, true ambiguity you cannot resolve by looking it up, or something only the user knows. Every option must be a real, verified choice, never invented, guessed, or a plausible-looking placeholder; if you do not know the real options, look them up first rather than presenting fakes. The widget has a prompt, optional helpText, and 1-6 options; each option has a label, an optional value (the text sent back to you when confirmed; defaults to the label), an optional description, and an optional style ("default"|"primary"|"danger"). Set the optional allowCustom: true to also let the user type their own free-text answer instead of picking an option. Set the optional dismissOnMoveOn: true only for low-stakes questions that become moot if the user moves on; the widget then auto-dismisses once they send a newer message without answering. Leave it off (default) for real decisions you still need answered. The user picks an option and its value comes back to you as their reply. In the chat, the resolved card keeps your question and shows their selection checked under it, so phrase the prompt as a natural conversational question (never a menu instruction like "Pick one of the following") and give every option a value that reads like a reply the user would actually send. The user can also dismiss the question without answering; you'll be told on your next turn — treat that as a decline and don't re-ask. Example: {"type":"widget","widget":{"prompt":"Deploy to production?","options":[{"label":"Deploy","value":"Yes, deploy now","style":"primary"},{"label":"Cancel","value":"No, hold off","style":"danger"}]}}. When you do genuinely need a decision or confirmation, this widget is how you ask, not plain text. Sending a widget ends your turn; make it your last action and stop, and the user's selection arrives as the next message. Use {"type":"cursor-agent","bcId":"bc-..."} to reference a Cursor cloud agent run by its bcId. Use {"type":"secret-request","secret":{"label":"...","connector":"...","field":"..."}} to ask for a credential (an API token, key, or secret): the user gets a masked secure input and the value goes straight to the secret store. NEVER ask the user to paste a token, key, or password into the chat; always request it this way so it stays out of the transcript and out of your context. You only learn that they provided it. Sending a secret-request ends your turn; you are resumed once they submit. When a tool needs user approval, just attempt the action — the app surfaces its approval card automatically when it is required. Do NOT announce the approval flow first, invent a permission card, or promise that "the app will ask" — attempt the action and let the real card appear.`;

interface ValidationIssue {
  path: string[];
  message: string;
}

/**
 * Types a field is valid on — grok's TYPE_FIELDS table. A field supplied on
 * any other type would be silently dropped, so validation teaches recovery.
 */
const TYPE_FIELDS: readonly { field: string; types: readonly string[] }[] = [
  { field: 'content', types: ['text'] },
  { field: 'url', types: ['attachment'] },
  { field: 'alt', types: ['attachment'] },
  { field: 'widget', types: ['widget'] },
  { field: 'bcId', types: ['cursor-agent'] },
  { field: 'secret', types: ['secret-request'] },
];

function isValidAttachmentUrl(value: string): boolean {
  try {
    return ['file:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function isFieldProvided(value: unknown): boolean {
  return (
    value != null &&
    (typeof value !== 'string' || value.length > 0) &&
    (!Array.isArray(value) || value.length > 0)
  );
}

/**
 * grok's refineSendMessage port: cross-type field misuse produces a
 * self-teaching error (what was dropped, that nothing was sent, and how to
 * re-send), not a bare "invalid field".
 */
function validateInput(input: Record<string, unknown>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const type = input.type as string;

  for (const { field, types } of TYPE_FIELDS) {
    if (!types.includes(type) && isFieldProvided(input[field])) {
      const allowed = types.map((t) => `type:${t}`).join(' or ');
      issues.push({
        path: [field],
        message:
          `${field} is only valid with ${allowed} and cannot ride a type:${type} message — ` +
          `it would be silently dropped. Nothing was sent. Re-send as separate SendMessage calls, ` +
          `one per type: this field on its own properly-typed message (${allowed}), and any text as its own type:text message.`,
      });
    }
  }

  const images = input.images;
  if (images && Array.isArray(images) && images.length > 0 && type !== 'text') {
    issues.push({
      path: ['images'],
      message:
        'images can only be set for type:text (they attach to a text message); for a standalone attachment use type:attachment with url',
    });
  }

  const channel = input.channel;
  if (channel && type !== 'text' && type !== 'attachment') {
    issues.push({
      path: ['channel'],
      message: 'channel can only be set for type:text or type:attachment, not widgets or cursor-agent cards',
    });
  }

  if (type === 'text') {
    if (!input.content) {
      issues.push({ path: ['content'], message: 'content is required when type is text' });
    }
    const imageList = Array.isArray(images) ? images : [];
    imageList.forEach((image, index) => {
      const url = (image as { url?: unknown })?.url;
      if (typeof url === 'string' && !isValidAttachmentUrl(url)) {
        issues.push({
          path: ['images', String(index), 'url'],
          message: 'each images url must include a file:// or https:// scheme',
        });
      }
    });
  } else if (type === 'attachment') {
    const url = input.url;
    if (!url) {
      issues.push({ path: ['url'], message: 'url is required when type is attachment' });
    } else if (typeof url === 'string' && !isValidAttachmentUrl(url)) {
      issues.push({
        path: ['url'],
        message: 'url must include a file:// or https:// scheme when type is attachment',
      });
    }
  } else if (type === 'widget') {
    if (!input.widget) {
      issues.push({ path: ['widget'], message: 'widget is required when type is widget' });
    } else {
      const w = input.widget as Record<string, unknown>;
      if (typeof w.prompt !== 'string' || w.prompt.length === 0) {
        issues.push({ path: ['widget', 'prompt'], message: 'widget.prompt is required when type is widget' });
      }
      if (!Array.isArray(w.options) || w.options.length === 0) {
        issues.push({
          path: ['widget', 'options'],
          message: 'widget.options requires 1-6 real, verified choices',
        });
      }
    }
  } else if (type === 'cursor-agent') {
    if (!input.bcId) {
      issues.push({ path: ['bcId'], message: 'bcId is required when type is cursor-agent' });
    }
  } else if (type === 'secret-request') {
    if (!input.secret) {
      issues.push({ path: ['secret'], message: 'secret is required when type is secret-request' });
    } else {
      const s = input.secret as Record<string, unknown>;
      if (typeof s.label !== 'string' || s.label.length === 0) {
        issues.push({ path: ['secret', 'label'], message: 'secret.label is required when type is secret-request' });
      }
      if (typeof s.connector !== 'string' || s.connector.length === 0) {
        issues.push({
          path: ['secret', 'connector'],
          message: 'secret.connector is required when type is secret-request',
        });
      }
      if (typeof s.field !== 'string' || s.field.length === 0) {
        issues.push({ path: ['secret', 'field'], message: 'secret.field is required when type is secret-request' });
      }
    }
  }

  return issues;
}

function truncate(input: string, limit: number): string {
  return input.length > limit ? input.slice(0, limit) + '...[truncated]' : input;
}

interface BuiltMessage {
  message: {
    id: string;
    session_id: string;
    role: string;
    content: string;
    status: string;
    msg_type: string;
    source: string;
    metadata: Record<string, unknown>;
    created_at: number;
  };
}

function buildTextMessage(input: Record<string, unknown>, sessionId: string): BuiltMessage {
  const content = truncate((input.content as string) ?? '', MAX_CONTENT_LENGTH);
  const images = input.images as Array<{ url: string; alt?: string }> | undefined;
  return {
    message: {
      id: randomUUID(),
      session_id: sessionId,
      role: 'assistant',
      content,
      status: 'complete',
      msg_type: 'text',
      // Plan 489 P0.2 — explicit source wins the IPC inference, and the
      // adapter also mirrors it into metadata.source.
      source: 'send_message',
      metadata: {
        source: 'send_message',
        reply_to: input.reply_to,
        // Plan 489 P2.2 — card payload rides under metadata.sendMessage so
        // the persistence whitelist can round-trip it as one key.
        ...(images && images.length > 0 ? { sendMessage: { images } } : {}),
      },
      created_at: Date.now(),
    },
  };
}

function buildAttachmentMessage(input: Record<string, unknown>, sessionId: string): BuiltMessage {
  const content = truncate((input.content as string) ?? '', MAX_CONTENT_LENGTH);
  return {
    message: {
      id: randomUUID(),
      session_id: sessionId,
      role: 'assistant',
      content,
      status: 'complete',
      msg_type: 'attachment',
      source: 'send_message',
      metadata: {
        source: 'send_message',
        reply_to: input.reply_to,
        sendMessage: { url: input.url, alt: input.alt },
      },
      created_at: Date.now(),
    },
  };
}

function buildWidgetMessage(input: Record<string, unknown>, sessionId: string): BuiltMessage {
  const content = truncate((input.content as string) ?? '', MAX_CONTENT_LENGTH);
  const widget = input.widget as Record<string, unknown>;
  return {
    message: {
      id: randomUUID(),
      session_id: sessionId,
      role: 'assistant',
      content,
      status: 'complete',
      msg_type: 'widget',
      source: 'send_message',
      metadata: {
        source: 'send_message',
        reply_to: input.reply_to,
        sendMessage: { widget },
      },
      created_at: Date.now(),
    },
  };
}

function buildCursorAgentMessage(input: Record<string, unknown>, sessionId: string): BuiltMessage {
  const content = truncate((input.content as string) ?? '', MAX_CONTENT_LENGTH);
  return {
    message: {
      id: randomUUID(),
      session_id: sessionId,
      role: 'assistant',
      content,
      status: 'complete',
      msg_type: 'cursor-agent',
      source: 'send_message',
      metadata: {
        source: 'send_message',
        reply_to: input.reply_to,
        sendMessage: { bcId: input.bcId },
      },
      created_at: Date.now(),
    },
  };
}

function buildSecretRequestMessage(input: Record<string, unknown>, sessionId: string): BuiltMessage {
  const content = truncate((input.content as string) ?? '', MAX_CONTENT_LENGTH);
  const secret = input.secret as Record<string, unknown>;
  return {
    message: {
      id: randomUUID(),
      session_id: sessionId,
      role: 'assistant',
      content,
      status: 'complete',
      msg_type: 'secret-request',
      source: 'send_message',
      metadata: {
        source: 'send_message',
        reply_to: input.reply_to,
        sendMessage: { secret },
      },
      created_at: Date.now(),
    },
  };
}

function buildMessageForType(
  type: string,
  input: Record<string, unknown>,
  sessionId: string
): BuiltMessage | null {
  switch (type) {
    case 'text':
      return buildTextMessage(input, sessionId);
    case 'attachment':
      return buildAttachmentMessage(input, sessionId);
    case 'widget':
      return buildWidgetMessage(input, sessionId);
    case 'cursor-agent':
      return buildCursorAgentMessage(input, sessionId);
    case 'secret-request':
      return buildSecretRequestMessage(input, sessionId);
    default:
      return null;
  }
}

// ─── Card side-state persistence (Plan 489 P0.2) ────────────────────────────
// After an interactive card message (widget / cursor-agent / secret-request) is
// appended to the transcript, mirror its interaction state into the corresponding
// side table. Best-effort: a state-write failure is logged and swallowed so it
// never blocks the (already-delivered) main send path.
async function persistCardState(
  type: string,
  built: BuiltMessage,
  sessionId: string,
  input: Record<string, unknown>,
  context: ToolUseContext | undefined,
): Promise<void> {
  const messageId = built.message.id;
  try {
    const now = Date.now();
    if (type === 'widget') {
      const widget = (input.widget as Record<string, unknown>) ?? {};
      await sendMessageStateDb.createWidgetPending({
        id: messageId,
        messageId,
        sessionId,
        botAgentId: context?.options?.agentProfileId ?? '',
        prompt: typeof widget.prompt === 'string' ? widget.prompt : '',
        widgetJson: JSON.stringify(widget),
        createdAt: now,
      });
    } else if (type === 'cursor-agent') {
      await sendMessageStateDb.upsertCursorAgentRun({
        id: messageId,
        messageId,
        sessionId,
        bcId: (input.bcId as string) ?? '',
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      });
    } else if (type === 'secret-request') {
      const secret = (input.secret as Record<string, unknown>) ?? {};
      await sendMessageStateDb.createSecretPending({
        id: messageId,
        messageId,
        sessionId,
        label: typeof secret.label === 'string' ? secret.label : '',
        connector: typeof secret.connector === 'string' ? secret.connector : '',
        field: typeof secret.field === 'string' ? secret.field : '',
        createdAt: now,
      });
    }
  } catch (err) {
    getLogger().error(
      `sendMessageState persist failed for type: ${type}`,
      err instanceof Error ? err : new Error(String(err)),
      { sessionId, messageId },
      'SendMessageTool',
    );
  }
}

// ─── Channel delivery (Plan 488 P2.1 — only text / attachment) ──────────
async function deliverToChannel(
  channel: string,
  sessionId: string,
  input: Record<string, unknown>
): Promise<{ id: string; name: string; result: string; error?: boolean }> {
  const messageId = randomUUID();
  const outboundContent = truncate((input.content as string) ?? '', MAX_CHANNEL_CONTENT_LENGTH);
  const mediaUrl = input.url as string | undefined;
  const mediaAlt = input.alt as string | undefined;
  try {
    // Lazy import to avoid bundling channelDb when not in use
    const { channelDb } = await import('../../ipc/db-client.js');
    const result = (await channelDb.deliver({
      sessionId,
      channelAddress: channel,
      outbound: {
        content: outboundContent,
        url: mediaUrl,
        caption: mediaAlt,
      },
    })) as { success?: boolean; reason?: string } | undefined;
    if (!result?.success) {
      return {
        id: messageId,
        name: SEND_MESSAGE_TOOL_NAME,
        result: `Channel delivery failed: ${result?.reason ?? 'unknown error'}`,
        error: true,
      };
    }
    return {
      id: messageId,
      name: SEND_MESSAGE_TOOL_NAME,
      result: `Message delivered to channel ${channel}. (id: ${messageId})`,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return {
      id: randomUUID(),
      name: SEND_MESSAGE_TOOL_NAME,
      result: `Channel delivery IPC failed: ${errorMessage}`,
      error: true,
    };
  }
}

// ─── Tool class ──────────────────────────────────────────────────────────
export class SendMessageTool {
  name = SEND_MESSAGE_TOOL_NAME;
  description = SEND_MESSAGE_DESCRIPTION;
  input_schema = SEND_MESSAGE_SCHEMA;

  toTool() {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.input_schema,
    };
  }

  async execute(
    input: Record<string, unknown>,
    _workingDirectory: string | undefined,
    context: ToolUseContext | undefined
  ): Promise<{ id: string; name: string; result: string; error?: boolean }> {
    if (!input || typeof input !== 'object') {
      return {
        id: randomUUID(),
        name: this.name,
        result: 'Invalid input: input must be an object.',
        error: true,
      };
    }
    const type = input.type as string | undefined;
    if (!type) {
      return {
        id: randomUUID(),
        name: this.name,
        result: 'Invalid input: type is required.',
        error: true,
      };
    }
    const validationIssues = validateInput(input);
    if (validationIssues.length > 0) {
      const messages = validationIssues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return {
        id: randomUUID(),
        name: this.name,
        result: `Validation failed: ${messages}`,
        error: true,
      };
    }
    const sessionId = context?.options?.sessionId;
    if (!sessionId) {
      return {
        id: randomUUID(),
        name: this.name,
        result: 'No active session. SendMessage requires an active conversation with the user.',
        error: true,
      };
    }

    // Channel delivery takes the text / attachment fast path.
    const channel = input.channel as string | undefined;
    if (channel) {
      return await deliverToChannel(channel, sessionId, input);
    }

    // Build the per-type message DTO.
    const built = buildMessageForType(type, input, sessionId);
    if (!built) {
      return {
        id: randomUUID(),
        name: this.name,
        result: `Unsupported type: ${type}`,
        error: true,
      };
    }

    try {
      // Plan 489 revised — correct logic: SendMessage writes through the
      // NORMAL session mechanism (messageDb.append → messages table → JSONL
      // rollouts), NOT a separate bot_transcript_entries table.
      // The message is tagged with source='send_message' so the bot-direct
      // view can filter for it.
      await messageDb.append(sessionId, [built.message], null);

      // Plan 489 P0.2 — mirror interaction state for interactive card types.
      // Best-effort: never blocks the message delivery above.
      await persistCardState(type, built, sessionId, input, context);

      return {
        id: built.message.id,
        name: this.name,
        result: `Message sent to user. (id: ${built.message.id})`,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        id: randomUUID(),
        name: this.name,
        result: `Failed to send message: ${errorMessage}`,
        error: true,
      };
    }
  }
}

export const sendMessageTool = new SendMessageTool();