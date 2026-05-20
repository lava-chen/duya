/**
 * Feishu Interactive Card Builder
 *
 * Builds Feishu Interactive Card payloads for:
 * - Permission approval requests (Allow Once / Session / Always / Deny)
 * - General interactive cards with buttons
 */

export interface CardElement {
  tag: string;
  [key: string]: unknown;
}

export interface CardAction {
  tag: 'action';
  actions: CardElement[];
}

export interface CardText {
  tag: 'div';
  text: {
    tag: 'lark_md';
    content: string;
  };
}

export interface CardButton {
  tag: 'button';
  text: {
    tag: 'lark_md';
    content: string;
  };
  value?: Record<string, unknown>;
}

/** Build a permission approval card */
export function buildApprovalCard(options: {
  toolName: string;
  toolInput: Record<string, unknown>;
  permissionId: string;
  title?: string;
  description?: string;
}): CardElement {
  const {
    toolName,
    toolInput,
    permissionId,
    title = 'Permission Required',
    description = `The AI agent wants to run this tool:`,
  } = options;

  // Sanitize input for display
  const inputStr = JSON.stringify(toolInput, null, 2);
  const truncatedInput = inputStr.length > 500 ? inputStr.substring(0, 500) + '...' : inputStr;

  const elements: CardElement[] = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**${title}**\n\n${description}`,
      },
    },
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**Tool:** \`${toolName}\``,
      },
    },
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `\`\`\`\n${truncatedInput}\n\`\`\``,
      },
    },
    {
      tag: 'hr',
    },
  ];

  // Action buttons
  const actions: CardElement[] = [
    {
      tag: 'button',
      text: {
        tag: 'lark_md',
        content: '✅ Allow Once',
      },
      value: JSON.stringify({ permissionId, decision: 'once' }),
    },
    {
      tag: 'button',
      text: {
        tag: 'lark_md',
        content: '🔓 Allow Session',
      },
      value: JSON.stringify({ permissionId, decision: 'session' }),
    },
    {
      tag: 'button',
      text: {
        tag: 'lark_md',
        content: '🔒 Always Allow',
      },
      value: JSON.stringify({ permissionId, decision: 'always' }),
    },
    {
      tag: 'button',
      text: {
        tag: 'lark_md',
        content: '❌ Deny',
      },
      value: JSON.stringify({ permissionId, decision: 'deny' }),
    },
  ];

  elements.push({
    tag: 'action',
    actions,
  });

  return {
    tag: 'card',
    header: {
      title: {
        tag: 'plain_text',
        content: '🔐 Permission Request',
      },
      template: 'warning',
    },
    elements,
  };
}

/** Build a simple text card */
export function buildTextCard(content: string): CardElement {
  return {
    tag: 'card',
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content,
        },
      },
    ],
  };
}

/** Build a card with multiple actions */
export function buildActionCard(options: {
  title: string;
  content: string;
  buttons: Array<{ label: string; value: string; variant?: 'primary' | 'danger' }>;
}): CardElement {
  const { title, content, buttons } = options;

  const actions: CardElement[] = buttons.map((btn) => ({
    tag: 'button',
    text: {
      tag: 'lark_md',
      content: btn.label,
    },
    value: btn.value,
  }));

  return {
    tag: 'card',
    header: {
      title: {
        tag: 'plain_text',
        content: title,
      },
      template: 'info',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content,
        },
      },
      {
        tag: 'action',
        actions,
      },
    ],
  };
}

/** Parse card action callback data */
export function parseCardActionCallback(value: string): { permissionId: string; decision: string } | null {
  try {
    const data = JSON.parse(value);
    if (data.permissionId && data.decision) {
      return data as { permissionId: string; decision: string };
    }
    return null;
  } catch {
    return null;
  }
}

/** Convert card element to API payload */
export function cardToPayload(card: CardElement): object {
  return {
    msg_type: 'interactive',
    content: JSON.stringify(card),
  };
}