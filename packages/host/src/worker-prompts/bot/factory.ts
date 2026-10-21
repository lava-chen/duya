/**
 * Factory: a ready-to-use bot prompt assembly.
 *
 * Registers the placeholder catalog so the emitted prompt is stable
 * (basic only) today, and real section renderers can be registered on the
 * returned instance as their systems land.
 */

import { BotPromptAssembly } from './framework.js'
import { registerBotSectionCatalog } from './catalog.js'

export function createBotPromptAssembly(): BotPromptAssembly {
  const assembly = new BotPromptAssembly()
  registerBotSectionCatalog(assembly)
  return assembly
}
