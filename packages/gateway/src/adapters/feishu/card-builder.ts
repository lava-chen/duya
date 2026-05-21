import type { FeishuCard, FeishuCardElement, FeishuCardText } from './types';

function text(content: string, tag: 'plain_text' | 'lark_md' = 'lark_md'): FeishuCardText {
  return { tag, content };
}

function button(textStr: string, actionTag: string, value: Record<string, unknown>, type: string = 'primary'): FeishuCardElement {
  return { tag: 'button', text: text(textStr), type, value, action_tag: actionTag } as FeishuCardElement;
}

function divider(): FeishuCardElement {
  return { tag: 'hr' };
}

function note(content: string): FeishuCardElement {
  return { tag: 'note', elements: [text(content, 'plain_text')] };
}

export function buildPermissionRequestCard(pairingCode: string, userId: string): FeishuCard {
  return {
    config: { wide_screen_mode: true, enable_forward: false },
    header: { title: text('New Connection Request', 'plain_text'), template: 'blue' },
    elements: [
      { tag: 'div', text: text(`A user wants to start a private conversation with the bot.\n\nPairing Code: **${pairingCode}**\nUser: ${userId}\n\nTo approve, click the button below or use the CLI command:\`hermes pairing approve ${pairingCode}\``) },
      divider(),
      { tag: 'action', actions: [
        button('Approve', 'approve_pairing', { code: pairingCode, user: userId }, 'primary'),
        button('Reject', 'reject_pairing', { code: pairingCode, user: userId }, 'danger'),
      ]},
      note('This code expires in 1 hour. Only 3 pending requests are allowed at a time.'),
    ],
  };
}

export function buildPairingApprovedCard(): FeishuCard {
  return {
    config: { wide_screen_mode: true, enable_forward: false },
    header: { title: text('Connection Approved', 'plain_text'), template: 'green' },
    elements: [{ tag: 'div', text: text('The pairing request has been approved. You can now send messages to the bot.') }],
  };
}

export function buildPairingRejectedCard(): FeishuCard {
  return {
    config: { wide_screen_mode: true, enable_forward: false },
    header: { title: text('Connection Rejected', 'plain_text'), template: 'red' },
    elements: [{ tag: 'div', text: text('The pairing request has been rejected.') }],
  };
}

export function buildErrorCard(message: string): FeishuCard {
  return {
    config: { wide_screen_mode: false, enable_forward: false },
    header: { title: text('Error', 'plain_text'), template: 'red' },
    elements: [{ tag: 'div', text: text(message) }],
  };
}

export function buildStatusCard(title: string, status: 'success' | 'error' | 'warning' | 'info', detail: string): FeishuCard {
  const templateMap: Record<string, string> = { success: 'green', error: 'red', warning: 'yellow', info: 'blue' };
  return {
    config: { wide_screen_mode: true, enable_forward: false },
    header: { title: text(title, 'plain_text'), template: templateMap[status] || 'blue' },
    elements: [{ tag: 'div', text: text(detail) }],
  };
}

export function buildConfirmationCard(
  title: string, message: string,
  confirmLabel: string = 'Confirm', cancelLabel: string = 'Cancel',
  actionTag: string = 'confirm', value: Record<string, unknown> = {},
): FeishuCard {
  return {
    config: { wide_screen_mode: true, enable_forward: false },
    header: { title: text(title, 'plain_text') },
    elements: [
      { tag: 'div', text: text(message) },
      divider(),
      { tag: 'action', actions: [
        button(confirmLabel, actionTag, value, 'primary'),
        button(cancelLabel, `${actionTag}_cancel`, value, 'default'),
      ]},
    ],
  };
}

export function buildSimpleMessageCard(title: string, sections: { heading?: string; body: string }[]): FeishuCard {
  const elements: FeishuCardElement[] = [];
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    if (section.heading) {
      elements.push({ tag: 'div', text: text(`**${section.heading}**`) });
    }
    elements.push({ tag: 'div', text: text(section.body) });
    if (i < sections.length - 1) elements.push(divider());
  }
  return {
    config: { wide_screen_mode: true },
    header: { title: text(title, 'plain_text') },
    elements,
  };
}