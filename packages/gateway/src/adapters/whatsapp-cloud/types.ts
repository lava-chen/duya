/**
 * WhatsApp Cloud API (Meta Graph) wire types.
 *
 * Only the subset the adapter reads or writes is modelled; unknown fields are
 * ignored on purpose so a Meta payload addition cannot crash inbound handling.
 */

export interface WhatsAppCloudCredentials {
  phone_number_id: string;
  access_token: string;
  app_secret: string;
  verify_token: string;
  api_version?: string;
}

export interface WhatsAppCloudOptions {
  port?: number;
  host?: string;
  webhook_path?: string;
  dm_policy?: 'open' | 'allowlist' | 'pairing' | 'disabled';
  allow_from?: string[];
  /** Reject inbound payloads whose signature does not verify. Default true. */
  verify_signature?: boolean;
  /** Max inbound media size in MB. Default 25. */
  media_max_mb?: number;
}

export interface WAMediaRef {
  id: string;
  mime_type?: string;
  caption?: string;
  filename?: string;
  sha256?: string;
  voice?: boolean;
}

export interface WAMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: WAMediaRef;
  video?: WAMediaRef;
  audio?: WAMediaRef;
  document?: WAMediaRef;
  sticker?: WAMediaRef;
  button?: { payload: string; text: string };
  interactive?: {
    type: 'button_reply' | 'list_reply';
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string };
  };
  reaction?: { emoji: string; message_id: string };
  context?: { id?: string; from?: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
}

export interface WAChangeValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
  messages?: WAMessage[];
  statuses?: Array<{ id: string; status: string; recipient_id?: string }>;
}

export interface WAWebhookPayload {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{ field?: string; value?: WAChangeValue }>;
  }>;
}

/** Reply payload shapes accepted by `/{phone-number-id}/messages`. */
export interface WASendPayload {
  messaging_product: 'whatsapp';
  recipient_type?: 'individual';
  to: string;
  type: string;
  // One of the following is present, chosen by `type`.
  text?: { body: string; preview_url?: boolean };
  image?: { id?: string; link?: string; caption?: string };
  video?: { id?: string; link?: string; caption?: string };
  audio?: { id?: string; link?: string };
  document?: { id?: string; link?: string; caption?: string; filename?: string };
  interactive?: unknown;
  context?: { message_id: string };
  status?: 'read';
  message_id?: string;
  typing_indicator?: { type: 'text' };
}
