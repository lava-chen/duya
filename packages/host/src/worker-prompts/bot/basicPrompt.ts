/**
 * Bot Basic Prompt loader — plan 557 phase 4 (text lives in assets).
 *
 * The bot's *stable* behavioral baseline used to live as an 11 KB template
 * literal in this file; it now lives in
 * `assets/bot/basic-prompt.md.hbs` so every prompt text — host and bot —
 * is authored under `prompts/assets/` and hot-editable without touching
 * engine code. This module is a thin loader that keeps the
 * `BOT_BASIC_SYSTEM_PROMPT` export surface stable for the bot assembly
 * (`framework.ts`), the bot config (`configs/bot.ts`), and tests.
 *
 * Authoring rules for the asset (unchanged):
 * - One heading per concern, direct imperative language, no filler.
 * - Keep it runtime-data-free: values that change per turn (working dir,
 *   platform, date, model, connected channels, MCP state, memory content)
 *   belong to injected sections registered through the bot framework, NOT
 *   here — so the rendered string stays byte-stable and KV-cache friendly.
 * - Surface-specific capabilities (desktop widgets, IM reply semantics)
 *   are injected later by the corresponding section when the surface is
 *   known; this asset holds the shared core only.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Mirrors HbsPromptSystem's resolveAssetsRoot() candidate order:
//   src layout    → prompts/bot → prompts/assets
//   bundle layout → bundle/assets (copied by build-agent-bundle)
const candidates = [resolve(here, '../assets'), resolve(here, 'assets')];
const assetRelative = join('bot', 'basic-prompt.md.hbs');
const assetPath = candidates
  .map((candidate) => join(candidate, assetRelative))
  .find((candidatePath) => existsSync(candidatePath));

if (!assetPath) {
  // Fail loud: a missing prompt asset must never degrade into an empty bot
  // persona (the lesson of the plan 535 A-6 silent-drop regression).
  throw new Error(
    `[prompts] bot basic prompt asset not found. Looked in: ${candidates.join(', ')}`,
  );
}

const raw = readFileSync(assetPath, 'utf-8');

// Normalize CRLF → LF so the exported prompt stays byte-identical to the
// pre-extraction template literal regardless of git autocrlf on the
// checkout that produced the bundle.
export const BOT_BASIC_SYSTEM_PROMPT = raw.replace(/\r\n/g, '\n');
