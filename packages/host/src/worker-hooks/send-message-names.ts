/**
 * Constants for the bot voice tool.
 *
 * The tool registers as `send_message` (capabilities
 * SendMessageTool/constants.ts). `SendMessage` is the retired spelling
 * (plan 483 P2 era): journal replay and old transcripts still carry
 * tool_use parts under it, so matching helpers must accept BOTH —
 * see the tool-surface plan's F24.
 */
export const SEND_MESSAGE_TOOL_NAME = 'send_message';
export const LEGACY_SEND_MESSAGE_TOOL_NAME = 'SendMessage';
