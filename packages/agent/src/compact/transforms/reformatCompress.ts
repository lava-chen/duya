import type { Message } from '../../types.js'

export const reformatTransform = {
  name: 'reformat',
  apply(messages: Message[]): Message[] {
    return messages
  },
}