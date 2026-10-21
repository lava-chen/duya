/**
 * slice-classification.test.ts — the M5.1 inventory is checked against the repo,
 * not against itself.
 *
 * ## Why this file is the deliverable
 *
 * A classification kept in a table drifts: a directory is added, nobody
 * updates the map, and the map silently stops describing the tree. The map then
 * drives a cut list, and the cut list is wrong in a way nobody notices because
 * the map still parses.
 *
 * So the map is verified HERE, against the real filesystem, on every `npm test`
 * run. It fails when:
 *
 *   - a source file exists that no rule classifies   (a file was ADDED)
 *   - a rule classifies nothing                      (a directory was REMOVED)
 *   - a recorded file left the bucket it was recorded in
 *                                                      (RECATEGORISED, RENAMED
 *                                                       or DELETED)
 *   - RULES / FILE_OVERRIDES / UNCLASSIFIED_PREFIXES changed
 *                                                      (the MAP was edited)
 *   - a rule is shadowed by a broader rule above it  (the map has a dead rule)
 *   - a category in the closed vocabulary is unused   (the map lost a bucket)
 *
 * That is the E4.2 behaviour-matrix precedent applied to a classification: a
 * declared list, a closed vocabulary, and a verifier that reads the repo rather
 * than the declaration.
 *
 * ## Why this file no longer freezes a count, and what replaced it
 *
 * It used to. `EXPECTED` held a whole-tree `total`, a per-category `count` and a
 * per-category fingerprint, and it was correct that all of them had to be
 * re-recorded — the gate could not tell an honest addition from a silent
 * recategorisation, so it made every slice prove both.
 *
 * That produced a treadmill, and the treadmill was the bug:
 *
 *   1. Slice N adds a file. `total` no longer matches, so the gate is red.
 *   2. Slice N re-records. Re-recording is one paste, and it absorbs EVERY
 *      drift on the branch — including files slice N-1, N-2 and every slice
 *      merged alongside them, none of which slice N read.
 *   3. Slice N+1 lands and drifts the freshly-pasted numbers again.
 *
 * Two re-records of this file in a row (`a97353b3`, `83508431`) each had to
 * itemise in a comment that the moves were not their own — which is the
 * signature of a record that cannot be trusted to mean what it says. The
 * aggregate number was the mechanism: it made every slice responsible for
 * everyone else's drift, and the cheapest way to discharge that
 * responsibility was to paste the number.
 *
 * So the recorded state is no longer a count. It is `slice-census.txt`: the
 * per-file classification, frozen, with the property
 *
 *     every path in the census is STILL in the bucket it was recorded in
 *
 * a subset check rather than an equality check, and that one change separates
 * the two events the equality check could not:
 *
 *   - ADDING a file cannot make it red. `classify()` is a pure function of a
 *     path, so a new file changes no other file's category; it is only checked
 *     for being EXPLAINED, by the orphan assertion above, which is already
 *     treadmill-free. Nothing to re-record, so nothing to absorb.
 *   - REMOVING, RENAMING or MOVING a recorded file makes it red, and the
 *     failure prints the exact path. A recategorisation is a file leaving a
 *     bucket, which is precisely the subset property.
 *
 * The second half of the safety property is the map itself, which the census
 * cannot see: editing a rule reclassifies files without touching a single path.
 * That is `RULE_TABLE_FINGERPRINT` below.
 *
 * ## The residue, and why a recorded hash is irreducible here
 *
 * `RULE_TABLE_FINGERPRINT` is a recorded number, and it is the only one left.
 * It is irreducible because the map is a CLAIM, and a claim cannot be checked
 * against the repo — the repo is what the claim is about. A valid rule change
 * (a new directory that needs a category) must be allowed and must be
 * deliberate, and the only way to make "deliberate" mean something to a
 * reviewer is to make the reviewer's attention a build failure. A hash of the
 * classification-determining inputs is the smallest such tripwire: it changes
 * only when a prefix, a category, a rule's position, an override or an
 * exclusion changes — never when a file is added, and never when somebody
 * edits a rule's `why`, because prose is required to exist by its own
 * assertion and is not part of what `classify` reads.
 */

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  CATEGORIES,
  FILE_OVERRIDES,
  PURE_VIOLATIONS,
  PORTS,
  RULES,
  UNCLASSIFIED_PREFIXES,
  classify,
  isUnclassifiedPrefix,
  type Category,
} from './slice-classification';
import { REPO_ROOT } from './slice-classification';
import { ROOTS, walk, rel } from './import-graph.mjs';

const SOURCE_FILES = ROOTS.flatMap((r) => walk(path.join(REPO_ROOT, r)))
  .map((p) => rel(p))
  .sort();

/**
 * The buckets the census is held to: the closed vocabulary, plus the
 * deliberately-excluded one.
 *
 * `unclassified` is a first-class bucket here, NOT a gap. The old gate
 * recorded its size as a bare count, which is why a source file could be
 * moved under a `tests/` prefix and only the total noticed. Held as a set, a
 * file entering or leaving that bucket is a named path.
 */
const BUCKETS = [...CATEGORIES, 'unclassified'] as const;
type Bucket = (typeof BUCKETS)[number];

/** Every classified file, bucketed by category. Unclassified files are `null`. */
function bucket(): Map<Category, string[]> {
  const out = new Map<Category, string[]>();
  for (const category of CATEGORIES) out.set(category, []);
  for (const file of SOURCE_FILES) {
    const category = classify(file);
    if (category !== null) out.get(category)!.push(file);
  }
  return out;
}

/** The current census: the same buckets, read from the real tree. */
function currentCensus(): Map<Bucket, string[]> {
  const out = new Map<Bucket, string[]>();
  for (const b of BUCKETS) out.set(b, []);
  for (const file of SOURCE_FILES) {
    const category = classify(file);
    out.get(category === null ? 'unclassified' : category)!.push(file);
  }
  return out;
}

const CURRENT = currentCensus();

/**
 * The recorded census, parsed.
 *
 * `shape` holds everything the parser could not make sense of. It is asserted
 * on rather than thrown, because a parser that throws turns a malformed
 * baseline into an unrunnable suite, and an unrunnable suite is not a gate.
 */
interface ParsedCensus {
  readonly paths: Map<Bucket, string[]>;
  /** Bucket name -> the count written in its own `[bucket] (n)` header. */
  readonly declaredCounts: Map<string, number>;
  /** Every line that was neither blank, a comment, a header, nor a path. */
  readonly shapeErrors: string[];
  /** Every `[header]` name, in file order. */
  readonly headers: string[];
}

const CENSUS_PATH = path.join(REPO_ROOT, 'scripts/architecture/slice-census.txt');

function parseCensus(): ParsedCensus {
  const paths = new Map<Bucket, string[]>();
  for (const b of BUCKETS) paths.set(b, []);
  const declaredCounts = new Map<string, number>();
  const shapeErrors: string[] = [];
  const headers: string[] = [];

  // A MISSING census must not throw here. This module's top level runs at
  // collection time, so a throw would abort the file before a single test is
  // registered — and a suite that reports "no tests" is GREEN with the
  // protection deleted, which is the one outcome worse than a red run. It is
  // the same trap the encoding footgun records: a file that cannot load
  // reports success. So a missing or unreadable census is reported as a shape
  // error and asserted on, which is red.
  let raw: string;
  try {
    raw = fs.readFileSync(CENSUS_PATH, 'utf8');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      paths,
      declaredCounts,
      shapeErrors: [`cannot read ${CENSUS_PATH}: ${detail}`],
      headers,
    };
  }

  let current: string | null = null;
  const header = /^\[([^\]]+)\]\s*(?:\((\d+)\))?$/;

  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (text.length === 0 || text.startsWith('#')) continue;
    const asHeader = header.exec(text);
    if (asHeader) {
      current = asHeader[1];
      headers.push(current);
      declaredCounts.set(current, asHeader[2] === undefined ? -1 : Number(asHeader[2]));
      // A header for a bucket nothing checks would make its paths vacuous, so
      // the path is filed under the literal name and asserted to be illegal.
      paths.set(current as Bucket, paths.get(current as Bucket) ?? []);
      continue;
    }
    if (current === null) {
      shapeErrors.push(`path before any bucket header: ${text}`);
      continue;
    }
    paths.get(current as Bucket)!.push(text);
  }
  return { paths, declaredCounts, shapeErrors, headers };
}

const CENSUS = parseCensus();

/**
 * Paths retired from the census, one decision per path.
 *
 * This list, and not an edit to the census, is how a recorded file that was
 * genuinely deleted, renamed or moved is accounted for. The distinction
 * matters because the census is frozen: bulk-editing it is indistinguishable
 * from the treadmill this file used to run, whereas an entry here is a
 * reviewable claim about one specific path — and it goes stale on its own,
 * because an entry for a file that is still in its bucket fails the
 * "retires only paths that have actually left" assertion below. So the list
 * cannot accumulate into a blanket permission.
 *
 * NOT EMPTY ANY MORE, and that is the honest state: the monorepo extraction
 * (plan 611) moved the tree wholesale, so 1002 recorded paths left the bucket
 * they were recorded in. Every one of them is listed below, with the place it
 * went and the bucket it is in now. The REASONS repeat, because the
 * extraction moved whole packages, but the ENTRIES do not: the assertion
 * that keeps this list honest is per path, so a claim about a directory
 * would be a claim about nothing.
 */
interface RecordedLoss {
  /** The path exactly as the census listed it. */
  readonly path: string;
  /** The bucket it was recorded in. */
  readonly from: Bucket;
  /** Why it left: deleted, renamed, or moved to another bucket. */
  readonly why: string;
}

// ── the reasons, one per group ──────────────────────────────────────────
const MOVED_TO_UI =
  'moved to packages/ui/src when the desktop renderer was extracted into @duya/ui; now host-ui';
const MOVED_TO_HOST_TESTS =
  'moved to packages/host/tests when the host was extracted into @duya/host; that test directory is deliberately unclassified';
const MOVED_TO_CAPABILITIES_TESTS =
  'moved to packages/capabilities/tests when the tool barrel was extracted into @duya/capabilities; that test directory is deliberately unclassified';
const MOVED_TO_MEMORY =
  'moved to packages/memory/src when the memory state and rollout were extracted into @duya/memory; now capability-adapter';
const MOVED_TO_AGENT_RUNTIME_TEST =
  'moved to packages/agent-runtime/test when the run engine was extracted into @duya/agent-runtime; that test directory is deliberately unclassified';
const MOVED_TO_AGENT_CORE_TEST =
  'moved to packages/agent-core/test when the pure island was extracted into @duya/agent-core; that test directory is deliberately unclassified';
const MOVED_TO_UI_TYPES =
  'moved to packages/ui/src/types when the renderer DTO vocabulary followed the renderer into @duya/ui; now wire';
const MOVED_TO_SANDBOX =
  'moved to packages/sandbox/src when the sandbox was extracted into @duya/sandbox; now capability-adapter';
const MOVED_TO_HOST =
  'moved to packages/host/src when the host was extracted into @duya/host; now runtime-coordination';
const RETIRED_WITH_THE_AGENT_TEST_SUITE =
  'deleted with the agent package\'s test suite, which was retired; no successor file carries this path';
const DELETED_IN_EXTRACTION =
  'deleted in the monorepo extraction; no successor file carries this path';
const MOVED_TO_DATA =
  'moved to packages/data/src when the SQLite stores were extracted into @duya/data; now cp-durable';
const MOVED_TO_SANDBOX_TESTS =
  'moved to packages/sandbox/tests when the sandbox was extracted into @duya/sandbox; that test directory is deliberately unclassified';
const MOVED_TO_CONNECTORS =
  'moved to packages/connectors/src when the connector vocabulary was extracted into @duya/connectors; now wire';
const MOVED_TO_CONNECTORS_TESTS =
  'moved to packages/connectors/tests when the connector vocabulary was extracted into @duya/connectors; that test directory is deliberately unclassified';
const MOVED_TO_UI_DATA =
  'moved to packages/ui/src/data when the renderer transport shapes followed the renderer into @duya/ui; now wire';
const MOVED_TO_CAPABILITIES =
  'moved to packages/capabilities/src when the tool barrel was extracted into @duya/capabilities; now capability-adapter';
const MOVED_TO_DESKTOP_MAIN_TESTS =
  'moved to apps/desktop/src/main/__tests__, the one live host exclusion; that directory is deliberately unclassified';
const MOVED_TO_CLI =
  'moved to packages/cli/src when the CLI surface was reorganised; now host-ui';
const MOVED_TO_AGENT_PROTOCOL_TEST =
  'moved to packages/agent-protocol/test when the protocol package was extracted into @duya/agent-protocol; that test directory is deliberately unclassified';

const RECORDED_LOSSES: readonly RecordedLoss[] = [
  // packages/ui/src :: host-ui (765)
  { path: 'apps/desktop/src/main/ipc/__tests__/stream-session-manager-queue.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/App.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/ErrorBoundary.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/ExtensionConfirmDialog.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/SearchCommandPalette.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/StartupLanding.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/__tests__/icons.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/agent-face/AgentFace.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/agent-face/clock.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/agent-face/decor.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/agent-face/engine.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/agent-face/expressions.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/agent-face/eyefit.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/agent-face/face.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/agent-face/math.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/agent-face/profiles.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/agent-face/shape.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/agent-face/skins.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/agent-face/states.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/agent-face/status.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/agent-face/tile.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/automation/AutomationEmptyState.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/automation/AutomationView.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/automation/CronEditorModal.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/automation/CronHistoryPanel.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/automation/CronScheduleCard.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/automation/MacPermissionsCard.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/automation/MacPermissionsCard.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/automation/QuickCronChatModal.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/automation/TemplateMarketModal.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/automation/cron-schedule.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/automation/cron-schedule.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/browser/BrowserMenu.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/browser/ExtensionInstallPrompt.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/browser/NewTabPage.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/browser/index.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/AgentModeSelector.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/AssistantPreviewCards.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/AttachmentBar.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/AttachmentPreviewModal.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/BackgroundTasksIndicator.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/BotActivityIndicator.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/BotBubbleRow.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/BotBubbleRow.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/BotCodeBlock.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/BotComposerExtras.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/BotDirectChatView.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/BotDirectChatView.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/BotMessageHoverBar.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/BotSendCard.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/BotThinkingRow.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/BotToolCallRow.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/BotTypingIndicator.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/BtwChatPanel.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/ChatErrorBanner.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/ChatHeader.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/ChatNotice.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/ChatView.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/CodeBlock.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/CodeCommentStrip.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/CompactBoundary.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/CompactSummary.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/CompactSummary.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/Composer.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/Composer.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/ConnectorAuthRequiredCard.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/ConnectorAuthRequiredCard.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/ContextUsageRing.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/FileAttachmentCard.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/GoalStatusChip.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/GoalStatusPanel.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/GoalStatusPanel.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/GroupCompositeAvatar.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/GroupRoomChatView.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/ImagePreviewModal.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/InlineTaskRow.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/InlineTaskRow.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/MailboxBubble.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/MailboxPanel.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/MarkdownRenderer.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/MarkdownTableFrame.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/MessageInput.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/MessageItem.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/MessageItem.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/MessageList.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/MessageList.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/ModelProviderSelector.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/ModelProviderSelector.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/ModelSelector.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/NewChatView.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/NextStepSuggestions.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/NextStepSuggestions.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/PermissionPrompt.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/PermissionPrompt.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/PluginMentionChip.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/PluginMentionText.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/ProviderModelEditor.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/ReadOnlySessionChat.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/ResearchReportCard.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/ResearchStageSections.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/RichTextInput.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/RichTextInput.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/Shimmer.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/SlashCommandPopover.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/SlashCommandPopover.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/StreamingInputBar.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/StreamingMessage.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/ToolActionsGroup.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/ToolActionsGroup.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/ToolResultRenderer.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/TurnChangesCard.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/VoiceButton.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/WidgetErrorBoundary.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/WidgetRenderer.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/__tests__/AttachmentBar.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/__tests__/BackgroundTasksIndicator.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/__tests__/BotActivityIndicator.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/__tests__/BotSendCard.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/__tests__/BotToolApprovalCard.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/__tests__/ContextUsageRing.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/__tests__/FileEditToolRow.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/__tests__/MessageInput.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/__tests__/MessageInputPaste.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/__tests__/ResearchStageSections.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/__tests__/TurnChangesCard.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/__tests__/new-chat-view-model-memory.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/bot/AgentDmGroupChip.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/bot/AgentDmPairView.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/bot/AgentDmPairView.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/bot/BotAskCard.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/bot/BotPermissionCard.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/bot/BotToolApprovalCard.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/bot/ChannelActivityChip.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/bot/RoutineActivityChip.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/bot/__tests__/BotAskCard.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/bot/__tests__/use-bot-direct-transcript.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/bot/agent-dm-contacts.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/bot/agent-dm-pair.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/bot/agent-dm-pair.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/bot/channel-activity.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/bot/channel-activity.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/bot/chat-mode.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/bot/chat-mode.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/bot/draft/draft-state.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/bot/draft/index.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/bot/draft/use-bot-draft.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/bot/mention-text.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/bot/mention-text.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/bot/notice/BotNoticeCard.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/bot/notice/index.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/bot/reply.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/bot/reply.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/bot/routine-activity.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/bot/routine-activity.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/bot/send/bot-direct-send.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/bot/send/index.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/bot/send/nonce.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/bot/send/preemption.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/bot/send/scheduled-turns.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/bot/send/use-bot-send-phase.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/bot/use-agent-dm-pair.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/bot/use-bot-direct-transcript.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/bot/use-bot-session-phase.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/bot/use-room-transcript.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/index.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/markdown-bold-math.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/markdown-heading.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/markdown-local-image.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/markdownComponents.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/markdownComponents.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/newchat-mode-passthrough.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/plugin-mention-markdown.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/preview/ImagePreview.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/preview/ImagePreview.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/preview/ImagePreviewPanel.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/researchStageLogic.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/researchStageLogic.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/ToolImagePreviewModal.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/__tests__/BrowserToolRow.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/__tests__/buildGroupDisplayTitle.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/__tests__/buildGroupSummary.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/__tests__/segments.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/chrome/ActionRowChrome.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/classify.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/flatRenderer.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/group/Group.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/group/buildGroupDisplayTitle.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/group/buildGroupSummary.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/hooks/useTopLevelChrome.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/invoke-identity.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/invoke-identity.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/normalize.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/parseDuyaCliResult.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/registry.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/rows/AskUserQuestionResultRow.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/rows/BashToolRow.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/rows/BrowserToolRow.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/rows/CanvasConductorToolRow.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/rows/CuaToolRow.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/rows/DuyaCliToolRow.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/rows/FileEditToolRow.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/rows/HookActionRow.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/rows/HookActionRow.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/rows/InvokeToolRow.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/rows/McpToolRow.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/rows/MessageSessionToolRow.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/rows/ModuleToolRow.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/rows/ReadToolRow.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/rows/ResearchReportStatusRow.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/rows/ResearchStateToolRow.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/rows/ScreenshotToolRow.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/rows/SessionToolRow.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/rows/SkillToolRow.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/rows/SubAgentToolRow.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/rows/SubAgentToolRow.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/rows/TaskToolRow.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/rows/TextRow.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/rows/ThinkingRow.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/rows/TodoToolRow.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/rows/ToolActionRow.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/rows/VisionToolRow.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/segments.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/statusBadge.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/tools/types.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/chat/unclosed-constructs.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/diff/CodeViewer.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/diff/DiffViewer.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/diff/SimpleDiffViewer.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/diff/index.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/extensions/ExtensionCard.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/extensions/ExtensionsPage.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/extensions/InstalledPage.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/extensions/MCPSettingsDialog.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/extensions/ManagedOAuthConnectDialog.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/extensions/MarketplacePage.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/extensions/OAuthClientSetupDialog.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/extensions/PluginInstallDialog.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/extensions/SkillUploadDialog.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/extensions/__tests__/ExtensionsPage.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/extensions/__tests__/PluginInstallDialog.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/extensions/connector-icons.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/file-tree/FileTree.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/file-tree/file-type-icon.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/file-tree/index.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/home/SessionSelector.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/home/WelcomeView.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/icons.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/ide/ide-brand-icons.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/import/ImportFlow.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/import/steps/CompleteStep.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/import/steps/ConflictStep.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/import/steps/PreviewStep.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/import/steps/ScanResultStep.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/import/steps/SelectSourceStep.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/AgentListSection.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/ArtifactsSection.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/BashTaskSection.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/BotAvatarEditor.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/BotModelSelectorField.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/DrawerSection.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/EditBotDialog.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/EnvironmentInfoSection.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/I18nProvider.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/PanelHeader.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/PanelHeader.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/PanelZone.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/PanelZone.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/ResizeHandle.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/SourcesSection.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/TaskDrawer.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/TaskDrawer.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/TaskDrawerToggle.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/TitleBar.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/__tests__/BotDialogModel.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/__tests__/SessionMessagesPanel.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/__tests__/panel-zone-workflow-view.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/app-shell.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/app-sidebar.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/panels/AgentBrowserTab.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/panels/BashTaskOutputView.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/panels/BotRoutinesSection.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/panels/BotSettingsPanel.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/panels/BrowserPanel.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/panels/CodeReviewPanel.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/panels/CodeReviewPanel.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/panels/FilePreviewPanel.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/panels/FileTreePanel.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/panels/PanelFileTreeSplit.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/panels/RoomSettingsPanel.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/panels/SessionMessagesPanel.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/panels/SidebarConductorView.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/panels/TerminalPanel.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/panels/TerminalPanel.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/panels/WorkflowPanel.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/panels/WorkflowPanel.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/panels/__tests__/BotSettingsPanel.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/panels/__tests__/CodeReviewPanel.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/panels/code-review-code-viewer.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/panels/code-review-code-viewer.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/panels/code-review-diff.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/panels/code-review-diff.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/panels/code-review-status-colors.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/panels/registry.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/sidebar/BotCharacterAvatar.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/sidebar/BotContactListItem.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/sidebar/BotContactListItem.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/sidebar/ProjectGroupItem.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/sidebar/RailBotAvatar.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/sidebar/RoomContactListItem.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/sidebar/SidebarSectionItem.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/sidebar/SortableProjectGroupItem.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/sidebar/__tests__/SortableProjectGroupItem.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/sidebar/bot-contacts.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/sidebar/bot-contacts.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/sidebar/section-system.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/sidebar/section-system.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/sidebar/use-bot-contacts.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/layout/task-drawer-store.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/onboarding/OnboardingFlow.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/onboarding/steps/CompleteStep.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/onboarding/steps/ConfigStep.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/onboarding/steps/WelcomeStep.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/projects/ProjectsView.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/projects/RemoveProjectConfirm.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/projects/__tests__/RemoveProjectConfirm.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/providers/ModelCapabilityBadges.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/providers/ProviderActions.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/providers/ProviderAddButton.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/providers/ProviderEditView.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/providers/ProviderEmptyState.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/providers/ProviderList.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/providers/ProviderPickerView.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/providers/ProviderQuickConnect.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/providers/__tests__/ModelCapabilityBadges.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/providers/__tests__/ProviderAddButton.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/providers/__tests__/ProviderEditView.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/providers/__tests__/ProviderList.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/providers/__tests__/ProviderQuickConnect.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/providers/__tests__/getMainButtonState.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/providers/__tests__/useProviderCardState.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/providers/__tests__/useQuotaNavigation.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/providers/hooks/__tests__/useProviderModels.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/providers/hooks/useDefaultProviderId.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/providers/hooks/useProviderCardState.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/providers/hooks/useProviderModels.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/providers/hooks/useQuotaNavigation.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/recorder/RecorderView.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/recorder/RecorderView.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/AgentsSection.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/AppearanceSection.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/BridgeSection.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/BrowserAdvancedSection.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/BrowserExtensionSection.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/CapabilitiesSection.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/ChannelIcon.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/GeneralSection.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/HooksSection.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/HostToolPermissionCard.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/ImportCookiesDialog.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/MCPSection.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/MemoryRagCard.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/MemorySection.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/ModelSelectionSection.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/PerformanceSection.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/PresetIcon.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/ProviderConnectDialog.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/ProviderManagement.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/ProvidersSection.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/SecuritySection.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/SettingsView.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/SkillsSection.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/SupportSection.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/VisionModelSelector.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/VoiceSection.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/WakeAgentSection.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/__tests__/AgentsSection.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/__tests__/MemoryRagCard.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/__tests__/ProviderManagement.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/capabilities/CapabilityBadge.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/capabilities/CapabilityBanner.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/capabilities/CapabilityByPluginView.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/capabilities/CapabilityHealthBadge.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/capabilities/CapabilitySecurityBadge.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/capabilities/CrossSourceInventory.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/capabilities/PluginCard.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/capabilities/PluginDetailView.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/capabilities/PluginManagementView.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/capabilities/PluginPermissionReview.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/capabilities/RuntimeStatusBadge.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/capabilities/__tests__/PluginDetailView.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/capabilities/capability-adapter.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/capabilities/index.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/forms/hooks/__tests__/useApiKeyLink.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/forms/hooks/__tests__/useApiKeyState.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/forms/hooks/__tests__/useBaseUrlState.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/forms/hooks/__tests__/useModelSelection.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/forms/hooks/__tests__/usePresetDraft.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/forms/hooks/useApiKeyLink.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/forms/hooks/useApiKeyState.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/forms/hooks/useBaseUrlState.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/forms/hooks/useModelSelection.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/forms/hooks/usePresetDraft.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/forms/shared/ModelInputWithFetch.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/forms/shared/__tests__/ModelInputWithFetch.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/index.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/ui/SettingsCard.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/ui/SettingsInput.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/ui/SettingsRow.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/ui/SettingsSection.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/ui/SettingsSegmented.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/ui/SettingsSelect.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/ui/SettingsToggle.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/settings/ui/index.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/shared/ArchiveConfirm.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/shared/ArchiveConfirm.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/shared/ThreadListItem.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/shared/ThreadListItem.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/skills/SkillsView.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/ui/AutoResizeTextarea.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/ui/Button.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/ui/CreateProjectDialog.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/ui/DropdownMenu.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/ui/HoverPopover.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/ui/HoverPopover.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/ui/IconButton.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/ui/Input.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/ui/InputDialog.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/ui/OptionPanel.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/ui/Switch.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/ui/page/EmptyState.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/ui/page/Modal.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/ui/page/PageCard.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/ui/page/PageFrame.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/ui/page/PageHeader.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/ui/page/PageTabs.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/ui/page/index.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/ui/toast.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/ui/toast.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/ui/usePopoverPlacement.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/ui/usePopoverPlacement.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/update/UpdateBadge.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/usage/CostBreakdownBar.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/usage/DailyTokenChart.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/usage/ModelUsageDonut.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/usage/ProviderIcon.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/usage/ProviderQuotaCard.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/usage/ProviderQuotaView.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/usage/SessionList.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/usage/UsageDashboard.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/usage/UsageHeatmap.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/usage/UsageStatCard.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/usage/UsageSummaryGrid.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/usage/index.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/workflow/WorkflowDetailView.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/workflow/WorkflowGraph.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/workflow/WorkflowLaunchDialog.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/workflow/WorkflowLibraryView.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/workflow/WorkflowPage.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/workflow/WorkflowRunCard.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/workflow/WorkflowRunDetailView.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/workflow/WorkflowRunHistory.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/workflow/run-display/dwf-preview.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/workflow/run-display/dwf-preview.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/workflow/run-display/journal-steps.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/workflow/run-display/journal-steps.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/workflow/run-display/node-detail.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/workflow/run-display/node-detail.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/workflow/run-display/node-rows.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/workflow/run-display/node-rows.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/workflow/run-display/primitives.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/workflow/run-display/run-status.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/workflow/run-display/run-status.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/workflow/run-display/stage-columns.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/workflow/run-display/stage-columns.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/workflow/run-display/workflow-preview-card.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/components/workflow/workflow-run-card.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/conductor-host-provider.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/contexts/FontContext.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/__tests__/panel-toggle-repro.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/__tests__/useAttachments.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/__tests__/useBashTaskOutput.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/__tests__/useContextUsage.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/__tests__/useGitStatus.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/__tests__/useNextStepSuggestions.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/__tests__/usePanel.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/__tests__/usePermissions.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/__tests__/usePolling.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/__tests__/useProject.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/__tests__/useStreamingActions.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/__tests__/useSubagentRuntimeStream.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/__tests__/useTheme.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/use-bot-contact-form.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/use-code-comments.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/useAdaptiveTypewriter.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/useAdaptiveTypewriter.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/useAttachments.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/useBashTaskOutput.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/useBashTasks.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/useBrowserExtension.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/useContextUsage.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/useFileParsing.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/useGitStatus.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/useHookTasks.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/useIPC.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/useImageCompression.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/useLinkOpener.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/useNextStepSuggestions.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/usePanel.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/usePermissions.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/usePolling.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/useProject.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/useSessionArtifacts.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/useSessionSources.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/useSettings.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/useShortcutBinding.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/useShowHookInvocations.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/useSlashCommands.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/useStreamPhase.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/useStreamStartedAt.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/useStreamingActions.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/useStreamingAgentProgress.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/useStreamingError.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/useStreamingRetry.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/useStreamingStatusText.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/useStreamingText.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/useStreamingThinking.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/useStreamingToolOutput.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/useStreamingTools.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/useSubAgentProgress.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/useSubAgentProgress.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/useSubagentRuntimeStream.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/useTaskList.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/useTheme.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/useTranslation.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/hooks/useUsageData.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/i18n/en.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/i18n/index.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/i18n/zh.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/__tests__/agent-profile-ipc.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/__tests__/bot-model-options.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/__tests__/browser-newtab.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/__tests__/constants.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/__tests__/decode-message-attachments.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/__tests__/diff/diff-utils.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/__tests__/message-content-parser.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/__tests__/permission-mode.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/__tests__/plugin-mentions.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/__tests__/project-actions.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/__tests__/projectPaths.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/__tests__/sidebarDrag.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/__tests__/streaming-tool-input.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/__tests__/subagent-live-transcript.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/__tests__/subagent-progress-buffer.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/__tests__/subagent-result.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/__tests__/subagent-status.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/add-attachment-event.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/agent-color.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/agent-http-client.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/agent-profile-ipc.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/agent-sse-client.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/app-connection-ipc.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/app-connection-ipc.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/asset-url.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/automation-ipc.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/backdrop-repair.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/bot-avatar.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/bot-channels-ipc.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/bot-model-options.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/bot-thread-jump.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/browser-newtab.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/browser-reference-display.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/capability-management-ipc.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/capability-management-types.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/chat-edit-draft.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/chat-edit-draft.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/chat-file-links.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/chat-file-links.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/code-comment-store.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/code-comment-store.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/commands/help.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/commands/index.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/commands/parser.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/commands/registry.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/commands/types.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/config-port-bus.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/constants.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/context-usage-utils.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/context-usage-utils.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/decode-message-attachments.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/diff/diff-utils.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/durable-stream-subtraction.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/durable-stream-subtraction.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/errors/__tests__/extractErrorMessage.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/format-elapsed.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/git-ipc.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/hooks-ipc.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/html-to-plain-text.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/import-ipc.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/ipc-client.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/keyboard.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/keyboard.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/link-favicon.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/logger.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/markdown-table-export.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/markdown-table-export.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/markdown-text-merge.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/markdown-text-merge.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/mcp-inventory-ipc.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/mcp-inventory-ipc.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/mcp-inventory-types.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/mcp-parser.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/message-content-parser.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/message-input-logic.spec.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/message-input-logic.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/notification.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/open-session-panel-event.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/open-workflow-node-panel-event.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/permission-mode.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/permission-profile.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/plugin-ipc.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/plugin-mention-display.spec.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/plugin-mention-display.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/plugin-mentions.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/plugin-types.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/prefill-chat-input-event.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/prism-languages.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/project-actions.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/project-message-transcript.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/projectPaths.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/provider-presets.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/providers/__tests__/canCheckQuota.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/providers/__tests__/capability-sync.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/providers/__tests__/ipc-types.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/providers/__tests__/legacy.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/providers/__tests__/presets.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/providers/__tests__/renderer-dto.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/providers/__tests__/runtime-adapter.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/providers/__tests__/secret.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/providers/__tests__/service.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/providers/__tests__/validation.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/providers/canCheckQuota.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/providers/domain/LlmProviderService.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/providers/hooks/__tests__/useConfigUpdateSubscription.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/providers/hooks/__tests__/useOpenExternal.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/providers/hooks/__tests__/useProviderEditSave.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/providers/hooks/__tests__/useProvidersQuery.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/providers/hooks/queryKeys.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/providers/hooks/useConfigUpdateSubscription.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/providers/hooks/useDeleteProviderMutation.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/providers/hooks/useOpenExternal.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/providers/hooks/useProviderEditSave.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/providers/hooks/useProviderTestMutation.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/providers/hooks/useProvidersQuery.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/providers/hooks/useSetDefaultProviderMutation.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/providers/hooks/useUpsertProviderMutation.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/providers/ipc-types.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/providers/models/ModelCapabilityService.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/providers/models/__tests__/ModelSyncService.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/recorder-ipc.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/recorder-types.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/research-event-restore.smoke.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/review-panel.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/review-panel.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/rich-text-canonical.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/room-session.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/safe-storage.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/safe-storage.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/search-ipc.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/sidebar-sections-ipc.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/sidebarDrag.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/skill-mentions.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/skill-mentions.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/stream-session-manager.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/stream-session-manager.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/streaming-tool-input.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/subagent-live-transcript.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/subagent-result.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/subagent-status.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/terminal-ipc.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/terminal-themes.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/terminal-themes.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/tool-file-changes.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/tool-file-changes.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/unclosed-constructs.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/useCapabilityManagementSnapshot.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/utils.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/voice/dictation.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/voice/dictation.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/voice/errors.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/voice/errors.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/voice/types.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/voice/useVoiceInput.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/voice/useVoiceInput.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/voice/voice-capture.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/voice/voice-capture.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/voice/voice-devices.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/widget-parser.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/workflow-ipc.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/workflow-run-stream.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/workflow-run-stream.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/lib/workflow-types.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/orb/DuyaMascot.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/orb/OrbApp.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/orb/__tests__/OrbApp.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/orb/__tests__/OrbSessionCard.test.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/orb/bot/BloubOrb.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/orb/bot/__tests__/pointer-mood.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/orb/bot/decor.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/orb/bot/engine.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/orb/bot/expressions.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/orb/bot/eyefit.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/orb/bot/face.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/orb/bot/math.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/orb/bot/pointer-mood.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/orb/bot/profiles.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/orb/bot/repere.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/orb/bot/shape.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/orb/bot/skins.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/orb/bot/states.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/orb/components/OrbBall.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/orb/components/OrbBallLoading.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/orb/components/OrbSessionCard.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/orb/expressions/duya-expressions.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/orb/expressions/pathTween.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/orb/expressions/types.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/orb/hooks/useAutoCollapse.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/orb/hooks/useExpressionTransition.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/orb/hooks/useOrbDraggable.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/orb/hooks/useOrbGaze.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/orb/hooks/useOrbMood.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/orb/hooks/useOrbPointer.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/orb/hooks/useOrbState.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/orb/main.tsx', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/orb/types.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/stores/__tests__/compaction-store.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/stores/__tests__/conversation-archived-roster.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/stores/__tests__/conversation-create-thread-model-memory.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/stores/__tests__/conversation-store.eviction.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/stores/__tests__/conversation-store.mergeInFlight.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/stores/__tests__/conversation-store.placeholder.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/stores/__tests__/projects-store.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/stores/__tests__/turn-changes-card-store.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/stores/__tests__/workflow-store.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/stores/bot-activity-store.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/stores/btw-store.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/stores/busy-message-mode-store.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/stores/compaction-store.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/stores/context-usage-store.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/stores/conversation-store.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/stores/focus-mode-store.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/stores/link-opener-store.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/stores/low-power-store.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/stores/mailbox-store.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/stores/mailbox-store.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/stores/nav-history-store.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/stores/nav-history-store.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/stores/plugin-mention-store.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/stores/projects-store.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/stores/search-palette-store.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/stores/sidebar-sections-store.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/stores/terminal-appearance-store.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/stores/terminal-appearance-store.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/stores/turn-changes-card-store.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/stores/workflow-store.test.ts', from: 'host-ui', why: MOVED_TO_UI },
  { path: 'apps/desktop/src/renderer/stores/workflow-store.ts', from: 'host-ui', why: MOVED_TO_UI },
  // packages/host/tests :: unclassified (73)
  { path: 'packages/agent/src/agent-profile/__tests__/AgentProfileService.test.ts', from: 'runtime-coordination', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/agent-profile/__tests__/types.test.ts', from: 'runtime-coordination', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/config/__tests__/tool-exposure.test.ts', from: 'runtime-coordination', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/context/os-context/__tests__/bridge.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/context/os-context/__tests__/fragment.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/context/os-context/__tests__/injectOSContextFragment.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/context/os-context/__tests__/payload.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/context/os-context/__tests__/watcher.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/context/os-context/payload.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/decisions/__tests__/decisions.test.ts', from: 'runtime-coordination', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/hooks/__tests__/builtin-loop-hooks.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/hooks/__tests__/circuit-breaker.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/hooks/__tests__/config.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/hooks/__tests__/events.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/hooks/__tests__/executor.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/hooks/__tests__/hooks-json.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/hooks/__tests__/injection.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/hooks/__tests__/loop-bus.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/hooks/__tests__/send-message-delivery.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/hooks/__tests__/send-message-reminder.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/hooks/__tests__/task-registry.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/mentions/__tests__/explicit-mentions.test.ts', from: 'runtime-coordination', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/mentions/__tests__/mentions.test.ts', from: 'runtime-coordination', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/mentions/__tests__/skill-injections.test.ts', from: 'runtime-coordination', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/modes/__tests__/computer-use-mode.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/modes/__tests__/orthogonality.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/modes/__tests__/registry.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/modes/engine/__tests__/coordinator.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/modes/engine/__tests__/engine.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/modes/engine/__tests__/persistence.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/modes/goal/__tests__/goal-tracker.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/modes/plan/__tests__/plan-tracker.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/modes/research-mode/__tests__/research-tracker.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/modes/workflow/__tests__/browser-runner.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/modes/workflow/__tests__/converter.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/modes/workflow/__tests__/dwf-def-to-dwf.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/modes/workflow/__tests__/dwf-runtime.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/modes/workflow/__tests__/dwf-store.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/modes/workflow/__tests__/element-matcher.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/modes/workflow/__tests__/engine.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/modes/workflow/__tests__/expr.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/modes/workflow/__tests__/gui-runner.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/modes/workflow/__tests__/manager.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/modes/workflow/__tests__/planner-verify.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/modes/workflow/__tests__/run-log.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/modes/workflow/__tests__/schema-validate.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/modes/workflow/__tests__/workflow-run-tracker.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/process/__tests__/gui-backend.test.ts', from: 'runtime-coordination', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/process/__tests__/worker-protocol-write-queue.test.ts', from: 'runtime-coordination', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/process/__tests__/workflow-runner.test.ts', from: 'runtime-coordination', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/process/__tests__/workflow-runtime-child.test.ts', from: 'runtime-coordination', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/process/tool-approval-card.test.ts', from: 'runtime-coordination', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/session/__tests__/title-generator.test.ts', from: 'runtime-coordination', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/session/__tests__/transcript.test.ts', from: 'runtime-coordination', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/skills/__tests__/loaderDiagnostics.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/skills/__tests__/skillMatch.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/tool/BashTool/__tests__/managed-bash.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/tool/ImageGenerateTool/__tests__/ImageGenerateTool.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/tool/ImageGenerateTool/__tests__/image-generation-config.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/tool/ImageGenerateTool/__tests__/provider.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/tool/SubagentTool/__tests__/subagentParams.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/tool/WidgetRenderer/__tests__/runVisualSelfReview.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/utils/attachment-images.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/src/utils/image-attachment-context.test.ts', from: 'capability-adapter', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/tests/bash-task-registry.test.ts', from: 'unclassified', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/tests/bash-task-store.test.ts', from: 'unclassified', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/tests/mcp/config.test.ts', from: 'unclassified', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/tests/mcp/loader.test.ts', from: 'unclassified', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/tests/skills/skillService.test.ts', from: 'unclassified', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/tests/skills/sync-protection.test.ts', from: 'unclassified', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/tests/tool/approvals.test.ts', from: 'unclassified', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/tests/unit/session/recentSessionDirectory.test.ts', from: 'unclassified', why: MOVED_TO_HOST_TESTS },
  { path: 'packages/agent/tests/unit/session/turn-review.test.ts', from: 'unclassified', why: MOVED_TO_HOST_TESTS },
  // packages/capabilities/tests :: unclassified (54)
  { path: 'packages/agent/src/mcp/__tests__/breaker-decoupling.test.ts', from: 'capability-adapter', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/src/mcp/__tests__/lifecycle-inmemory.test.ts', from: 'capability-adapter', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/src/mcp/__tests__/result-blocks.test.ts', from: 'capability-adapter', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/src/permissions/__tests__/policy-read-permission.test.ts', from: 'cp-durable', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/src/tool/AppConnectionTool/__tests__/executor-deadline-result.test.ts', from: 'capability-adapter', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/src/tool/AppConnectionTool/__tests__/index.test.ts', from: 'capability-adapter', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/src/tool/AppConnectionTool/__tests__/replace-set.test.ts', from: 'capability-adapter', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/src/tool/AppConnectorManageTool/__tests__/app-connector-manage-tool.test.ts', from: 'capability-adapter', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/src/tool/BackgroundTaskTool/__tests__/GetTaskOutputTool.test.ts', from: 'capability-adapter', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/src/tool/BrowserTool/__tests__/ResultFormatter.test.ts', from: 'capability-adapter', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/src/tool/BrowserTool/__tests__/evaluate-caps.test.ts', from: 'capability-adapter', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/src/tool/BrowserTool/__tests__/parallel-fetcher-text.test.ts', from: 'capability-adapter', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/src/tool/BrowserTool/__tests__/platform-hook-extractor.test.ts', from: 'capability-adapter', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/src/tool/BrowserTool/__tests__/playwright-shared-browser.test.ts', from: 'capability-adapter', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/src/tool/BrowserTool/__tests__/post.test.ts', from: 'capability-adapter', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/src/tool/BrowserTool/__tests__/reply.test.ts', from: 'capability-adapter', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/src/tool/BrowserTool/__tests__/search.test.ts', from: 'capability-adapter', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/src/tool/BrowserTool/__tests__/snapshot-defaults.test.ts', from: 'capability-adapter', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/src/tool/BrowserTool/__tests__/twitterPost.test.ts', from: 'capability-adapter', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/src/tool/CanvasConductor/CanvasManageTool.test.ts', from: 'capability-adapter', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/src/tool/CanvasConductor/prompt.test.ts', from: 'capability-adapter', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/src/tool/ManageRoutineTool/__tests__/manage-routine-tool.test.ts', from: 'capability-adapter', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/src/tool/OSTool/__tests__/ComputerCuaTool.test.ts', from: 'capability-adapter', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/src/tool/OSTool/__tests__/ComputerUseTool.test.ts', from: 'capability-adapter', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/src/tool/OSTool/__tests__/context-tool.test.ts', from: 'capability-adapter', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/src/tool/PlanTool/__tests__/PlanTool.fallback.test.ts', from: 'capability-adapter', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/src/tool/SendMessageTool/__tests__/send-message-tool.test.ts', from: 'capability-adapter', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/src/tool/UpdateStateTool/__tests__/update-state-identity.test.ts', from: 'capability-adapter', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/src/tool/__tests__/DuyaCliTool.test.ts', from: 'capability-adapter', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/src/utils/__tests__/multimodal-detection.test.ts', from: 'capability-adapter', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/tests/BrowserTool/BrowserPool.test.ts', from: 'unclassified', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/tests/BrowserTool/BrowserTool.test.ts', from: 'unclassified', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/tests/BrowserTool/FallbackBrowser.test.ts', from: 'unclassified', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/tests/BrowserTool/SchemaGenerator.test.ts', from: 'unclassified', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/tests/BrowserTool/SnapshotEngine.test.ts', from: 'unclassified', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/tests/BrowserTool/WebviewCDPClient.test.ts', from: 'unclassified', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/tests/BrowserTool/actions/cdp-screenshot.test.ts', from: 'unclassified', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/tests/BrowserTool/actions/navigation.test.ts', from: 'unclassified', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/tests/BrowserTool/actions/network.test.ts', from: 'unclassified', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/tests/BrowserTool/actions/parallel.test.ts', from: 'unclassified', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/tests/BrowserTool/actions/screenshot.test.ts', from: 'unclassified', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/tests/BrowserTool/backend-resolver.test.ts', from: 'unclassified', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/tests/BrowserTool/selfHealing.test.ts', from: 'unclassified', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/tests/mcp/capability-catalog.test.ts', from: 'unclassified', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/tests/tool/approval-message-overrides.test.ts', from: 'unclassified', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/tests/tool/approval-message.test.ts', from: 'unclassified', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/tests/tool/canvas-conductor-prompt.test.ts', from: 'unclassified', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/tests/unit/SkillTool.test.ts', from: 'unclassified', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/tests/unit/canvasDesignGuidance.test.ts', from: 'unclassified', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/tests/unit/tools/CanvasManageTool.test.ts', from: 'unclassified', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/tests/unit/tools/DatabaseTool.test.ts', from: 'unclassified', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/tests/unit/tools/DomainBlocker.test.ts', from: 'unclassified', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/tests/unit/tools/SwitchModeTool.test.ts', from: 'unclassified', why: MOVED_TO_CAPABILITIES_TESTS },
  { path: 'packages/agent/tests/unit/update-state-tool.test.ts', from: 'unclassified', why: MOVED_TO_CAPABILITIES_TESTS },
  // packages/memory/src :: capability-adapter (42)
  { path: 'packages/agent/src/memory-rollout/__tests__/extractor.file-keys.test.ts', from: 'capability-adapter', why: MOVED_TO_MEMORY },
  { path: 'packages/agent/src/memory-rollout/__tests__/extractor.logging.test.ts', from: 'capability-adapter', why: MOVED_TO_MEMORY },
  { path: 'packages/agent/src/memory-rollout/__tests__/extractor.retry.test.ts', from: 'capability-adapter', why: MOVED_TO_MEMORY },
  { path: 'packages/agent/src/memory-rollout/__tests__/stage1_policy_editor.test.ts', from: 'capability-adapter', why: MOVED_TO_MEMORY },
  { path: 'packages/agent/src/memory-rollout/__tests__/stage1_prompt_loader.test.ts', from: 'capability-adapter', why: MOVED_TO_MEMORY },
  { path: 'packages/agent/src/memory-rollout/compactMessages.ts', from: 'capability-adapter', why: MOVED_TO_MEMORY },
  { path: 'packages/agent/src/memory-rollout/extractor.ts', from: 'capability-adapter', why: MOVED_TO_MEMORY },
  { path: 'packages/agent/src/memory-rollout/prompt.ts', from: 'capability-adapter', why: MOVED_TO_MEMORY },
  { path: 'packages/agent/src/memory-rollout/stage1_policy_editor.ts', from: 'capability-adapter', why: MOVED_TO_MEMORY },
  { path: 'packages/agent/src/memory-rollout/stage1_prompt_loader.ts', from: 'capability-adapter', why: MOVED_TO_MEMORY },
  { path: 'packages/agent/src/memory-rollout/types.ts', from: 'capability-adapter', why: MOVED_TO_MEMORY },
  { path: 'packages/agent/src/memory-rollout/wakeup.test.ts', from: 'capability-adapter', why: MOVED_TO_MEMORY },
  { path: 'packages/agent/src/memory-rollout/wakeup.ts', from: 'capability-adapter', why: MOVED_TO_MEMORY },
  { path: 'packages/agent/src/memory-rollout/writer.ts', from: 'capability-adapter', why: MOVED_TO_MEMORY },
  { path: 'packages/agent/src/memory-state/__tests__/backoff.test.ts', from: 'capability-adapter', why: MOVED_TO_MEMORY },
  { path: 'packages/agent/src/memory-state/__tests__/canonical_file.test.ts', from: 'capability-adapter', why: MOVED_TO_MEMORY },
  { path: 'packages/agent/src/memory-state/__tests__/curation_projection_live.test.ts', from: 'capability-adapter', why: MOVED_TO_MEMORY },
  { path: 'packages/agent/src/memory-state/__tests__/curation_validator.test.ts', from: 'capability-adapter', why: MOVED_TO_MEMORY },
  { path: 'packages/agent/src/memory-state/__tests__/eligibility.test.ts', from: 'capability-adapter', why: MOVED_TO_MEMORY },
  { path: 'packages/agent/src/memory-state/__tests__/entity_dirs.test.ts', from: 'capability-adapter', why: MOVED_TO_MEMORY },
  { path: 'packages/agent/src/memory-state/__tests__/fixture.ts', from: 'capability-adapter', why: MOVED_TO_MEMORY },
  { path: 'packages/agent/src/memory-state/__tests__/lease.test.ts', from: 'capability-adapter', why: MOVED_TO_MEMORY },
  { path: 'packages/agent/src/memory-state/__tests__/memory_layout.test.ts', from: 'capability-adapter', why: MOVED_TO_MEMORY },
  { path: 'packages/agent/src/memory-state/__tests__/outbox.test.ts', from: 'capability-adapter', why: MOVED_TO_MEMORY },
  { path: 'packages/agent/src/memory-state/__tests__/projectionContent.test.ts', from: 'capability-adapter', why: MOVED_TO_MEMORY },
  { path: 'packages/agent/src/memory-state/__tests__/reconcile.test.ts', from: 'capability-adapter', why: MOVED_TO_MEMORY },
  { path: 'packages/agent/src/memory-state/__tests__/schema-ddl.ts', from: 'capability-adapter', why: MOVED_TO_MEMORY },
  { path: 'packages/agent/src/memory-state/canonical_file.ts', from: 'capability-adapter', why: MOVED_TO_MEMORY },
  { path: 'packages/agent/src/memory-state/curation_ledger.ts', from: 'capability-adapter', why: MOVED_TO_MEMORY },
  { path: 'packages/agent/src/memory-state/curation_projection.ts', from: 'capability-adapter', why: MOVED_TO_MEMORY },
  { path: 'packages/agent/src/memory-state/curation_projection_live.ts', from: 'capability-adapter', why: MOVED_TO_MEMORY },
  { path: 'packages/agent/src/memory-state/curation_validator.ts', from: 'capability-adapter', why: MOVED_TO_MEMORY },
  { path: 'packages/agent/src/memory-state/eligibility.ts', from: 'capability-adapter', why: MOVED_TO_MEMORY },
  { path: 'packages/agent/src/memory-state/entity_dirs.ts', from: 'capability-adapter', why: MOVED_TO_MEMORY },
  { path: 'packages/agent/src/memory-state/lease.ts', from: 'capability-adapter', why: MOVED_TO_MEMORY },
  { path: 'packages/agent/src/memory-state/memory_layout.ts', from: 'capability-adapter', why: MOVED_TO_MEMORY },
  { path: 'packages/agent/src/memory-state/memory_paths.ts', from: 'capability-adapter', why: MOVED_TO_MEMORY },
  { path: 'packages/agent/src/memory-state/outbox.ts', from: 'capability-adapter', why: MOVED_TO_MEMORY },
  { path: 'packages/agent/src/memory-state/projectionContent.ts', from: 'capability-adapter', why: MOVED_TO_MEMORY },
  { path: 'packages/agent/src/memory-state/reconcile.ts', from: 'capability-adapter', why: MOVED_TO_MEMORY },
  { path: 'packages/agent/src/memory-state/system_log.ts', from: 'capability-adapter', why: MOVED_TO_MEMORY },
  { path: 'packages/agent/src/memory-state/tierConflicts.ts', from: 'capability-adapter', why: MOVED_TO_MEMORY },
  // packages/agent-runtime/test :: unclassified (18)
  { path: 'packages/agent/src/agent-profile/__tests__/tool-filter.test.ts', from: 'runtime-coordination', why: MOVED_TO_AGENT_RUNTIME_TEST },
  { path: 'packages/agent/src/context/__tests__/contextual-user-fragment.test.ts', from: 'capability-adapter', why: MOVED_TO_AGENT_RUNTIME_TEST },
  { path: 'packages/agent/src/permissions/__tests__/ask-without-user.test.ts', from: 'cp-durable', why: MOVED_TO_AGENT_RUNTIME_TEST },
  { path: 'packages/agent/src/permissions/__tests__/host-tool-permission.test.ts', from: 'cp-durable', why: MOVED_TO_AGENT_RUNTIME_TEST },
  { path: 'packages/agent/src/permissions/__tests__/tool-name-case.test.ts', from: 'cp-durable', why: MOVED_TO_AGENT_RUNTIME_TEST },
  { path: 'packages/agent/src/tool/ToolInvokeTool/dispatcherFromRegistry.test.ts', from: 'capability-adapter', why: MOVED_TO_AGENT_RUNTIME_TEST },
  { path: 'packages/agent/src/tool/__tests__/catalog-identity.test.ts', from: 'capability-adapter', why: MOVED_TO_AGENT_RUNTIME_TEST },
  { path: 'packages/agent/src/tool/__tests__/spec-budget.test.ts', from: 'capability-adapter', why: MOVED_TO_AGENT_RUNTIME_TEST },
  { path: 'packages/agent/tests/tool/registry-unregister.test.ts', from: 'unclassified', why: MOVED_TO_AGENT_RUNTIME_TEST },
  { path: 'packages/agent/tests/unit/agent/pending-hook-messages.test.ts', from: 'unclassified', why: MOVED_TO_AGENT_RUNTIME_TEST },
  { path: 'packages/agent/tests/unit/agent/run-identity.test.ts', from: 'unclassified', why: MOVED_TO_AGENT_RUNTIME_TEST },
  { path: 'packages/agent/tests/unit/agent/turn-assembler.test.ts', from: 'unclassified', why: MOVED_TO_AGENT_RUNTIME_TEST },
  { path: 'packages/agent/tests/unit/agent/turn-context.test.ts', from: 'unclassified', why: MOVED_TO_AGENT_RUNTIME_TEST },
  { path: 'packages/agent/tests/unit/agent/turn-loop-tracker.test.ts', from: 'unclassified', why: MOVED_TO_AGENT_RUNTIME_TEST },
  { path: 'packages/agent/tests/unit/agent/turn-shape.test.ts', from: 'unclassified', why: MOVED_TO_AGENT_RUNTIME_TEST },
  { path: 'packages/agent/tests/unit/message-factories.test.ts', from: 'unclassified', why: MOVED_TO_AGENT_RUNTIME_TEST },
  { path: 'packages/agent/tests/unit/tool-catalog.test.ts', from: 'unclassified', why: MOVED_TO_AGENT_RUNTIME_TEST },
  { path: 'packages/agent/tests/unit/visibility-guard.test.ts', from: 'unclassified', why: MOVED_TO_AGENT_RUNTIME_TEST },
  // packages/agent-core/test :: unclassified (9)
  { path: 'packages/agent/src/agent-profile/__tests__/bot-toolset.test.ts', from: 'runtime-coordination', why: MOVED_TO_AGENT_CORE_TEST },
  { path: 'packages/agent/src/agent/__tests__/turn-time-reminder.test.ts', from: 'runtime-coordination', why: MOVED_TO_AGENT_CORE_TEST },
  { path: 'packages/agent/src/agent/dm/mentions.test.ts', from: 'runtime-coordination', why: MOVED_TO_AGENT_CORE_TEST },
  { path: 'packages/agent/src/modes/engine/__tests__/run-lifecycle-tracker.test.ts', from: 'capability-adapter', why: MOVED_TO_AGENT_CORE_TEST },
  { path: 'packages/agent/tests/process/call-usage.test.ts', from: 'unclassified', why: MOVED_TO_AGENT_CORE_TEST },
  { path: 'packages/agent/tests/security/skillScanner.test.ts', from: 'unclassified', why: MOVED_TO_AGENT_CORE_TEST },
  { path: 'packages/agent/tests/unit/message-framework.test.ts', from: 'unclassified', why: MOVED_TO_AGENT_CORE_TEST },
  { path: 'packages/agent/tests/unit/message-projectors.test.ts', from: 'unclassified', why: MOVED_TO_AGENT_CORE_TEST },
  { path: 'packages/agent/tests/unit/threads.test.ts', from: 'unclassified', why: MOVED_TO_AGENT_CORE_TEST },
  // packages/ui/src/types :: wire (8)
  { path: 'apps/desktop/src/renderer/types/automation.ts', from: 'wire', why: MOVED_TO_UI_TYPES },
  { path: 'apps/desktop/src/renderer/types/hooks.ts', from: 'wire', why: MOVED_TO_UI_TYPES },
  { path: 'apps/desktop/src/renderer/types/message.ts', from: 'wire', why: MOVED_TO_UI_TYPES },
  { path: 'apps/desktop/src/renderer/types/mode-id.test.ts', from: 'wire', why: MOVED_TO_UI_TYPES },
  { path: 'apps/desktop/src/renderer/types/mode-id.ts', from: 'wire', why: MOVED_TO_UI_TYPES },
  { path: 'apps/desktop/src/renderer/types/research.ts', from: 'wire', why: MOVED_TO_UI_TYPES },
  { path: 'apps/desktop/src/renderer/types/slash-command.ts', from: 'wire', why: MOVED_TO_UI_TYPES },
  { path: 'apps/desktop/src/renderer/types/stream.ts', from: 'wire', why: MOVED_TO_UI_TYPES },
  // packages/sandbox/src :: capability-adapter (8)
  { path: 'packages/agent/src/sandbox/bubblewrap-sandbox.ts', from: 'capability-adapter', why: MOVED_TO_SANDBOX },
  { path: 'packages/agent/src/sandbox/docker-sandbox.ts', from: 'capability-adapter', why: MOVED_TO_SANDBOX },
  { path: 'packages/agent/src/sandbox/index.ts', from: 'capability-adapter', why: MOVED_TO_SANDBOX },
  { path: 'packages/agent/src/sandbox/path-mapper.ts', from: 'capability-adapter', why: MOVED_TO_SANDBOX },
  { path: 'packages/agent/src/sandbox/sandbox-adapter-legacy-types.ts', from: 'capability-adapter', why: MOVED_TO_SANDBOX },
  { path: 'packages/agent/src/sandbox/sandbox-adapter.ts', from: 'capability-adapter', why: MOVED_TO_SANDBOX },
  { path: 'packages/agent/src/sandbox/types.ts', from: 'capability-adapter', why: MOVED_TO_SANDBOX },
  { path: 'packages/agent/src/tool/allowedRoots.ts', from: 'capability-adapter', why: MOVED_TO_SANDBOX },
  // packages/host/src :: runtime-coordination (6)
  { path: 'packages/agent/src/context/os-context/bridge.ts', from: 'capability-adapter', why: MOVED_TO_HOST },
  { path: 'packages/agent/src/context/os-context/daemon-schema.ts', from: 'capability-adapter', why: MOVED_TO_HOST },
  { path: 'packages/agent/src/context/os-context/fragment.ts', from: 'capability-adapter', why: MOVED_TO_HOST },
  { path: 'packages/agent/src/context/os-context/payload.ts', from: 'capability-adapter', why: MOVED_TO_HOST },
  { path: 'packages/agent/src/context/os-context/types.ts', from: 'capability-adapter', why: MOVED_TO_HOST },
  { path: 'packages/agent/src/context/os-context/watcher.ts', from: 'capability-adapter', why: MOVED_TO_HOST },
  // (gone) :: gone (4)
  { path: 'packages/agent/tests/integration/AgentLoop.test.ts', from: 'unclassified', why: DELETED_IN_EXTRACTION },
  { path: 'packages/agent/tests/mcp/collect-worker.test.ts', from: 'unclassified', why: DELETED_IN_EXTRACTION },
  { path: 'packages/agent/tests/regression/streaming-lifecycle.test.ts', from: 'unclassified', why: DELETED_IN_EXTRACTION },
  { path: 'packages/agent/tests/tool/BashTool/bash-task-tools.test.ts', from: 'unclassified', why: DELETED_IN_EXTRACTION },
  // packages/data/src :: cp-durable (3)
  { path: 'apps/desktop/src/main/import/batch-store.ts', from: 'capability-adapter', why: MOVED_TO_DATA },
  { path: 'apps/desktop/src/main/plugins/PluginSetupStore.ts', from: 'capability-adapter', why: MOVED_TO_DATA },
  { path: 'apps/desktop/src/main/services/providers/capability-dao.ts', from: 'capability-adapter', why: MOVED_TO_DATA },
  // packages/sandbox/tests :: unclassified (3)
  { path: 'packages/agent/src/tool/__tests__/allowedRoots.test.ts', from: 'capability-adapter', why: MOVED_TO_SANDBOX_TESTS },
  { path: 'packages/agent/tests/sandbox.test.ts', from: 'unclassified', why: MOVED_TO_SANDBOX_TESTS },
  { path: 'packages/agent/tests/sandbox/path-mapper.test.ts', from: 'unclassified', why: MOVED_TO_SANDBOX_TESTS },
  // packages/connectors/src :: wire (2)
  { path: 'packages/plugin-core/src/connectors/app-connector-id.ts', from: 'capability-adapter', why: MOVED_TO_CONNECTORS },
  { path: 'packages/plugin-core/src/connectors/app-schema.ts', from: 'capability-adapter', why: MOVED_TO_CONNECTORS },
  // packages/connectors/tests :: unclassified (2)
  { path: 'packages/plugin-core/tests/app-schema-marketplace-compat.test.ts', from: 'unclassified', why: MOVED_TO_CONNECTORS_TESTS },
  { path: 'packages/plugin-core/tests/app-schema.test.ts', from: 'unclassified', why: MOVED_TO_CONNECTORS_TESTS },
  // packages/ui/src/data :: wire (1)
  { path: 'apps/desktop/src/renderer/data/preset-mcp-servers.ts', from: 'wire', why: MOVED_TO_UI_DATA },
  // packages/capabilities/src :: capability-adapter (1)
  { path: 'packages/agent/src/tool/ModuleTool/inline-content.ts', from: 'capability-adapter', why: MOVED_TO_CAPABILITIES },
  // apps/desktop/src/main/__tests__ :: unclassified (1)
  { path: 'apps/desktop/src/renderer/lib/__tests__/permission-profile.contract.test.ts', from: 'host-ui', why: MOVED_TO_DESKTOP_MAIN_TESTS },
  // packages/cli/src :: host-ui (1)
  { path: 'packages/agent/src/cli/ui/TUIApp.ts', from: 'host-ui', why: MOVED_TO_CLI },
  // packages/agent-protocol/test :: unclassified (1)
  { path: 'packages/agent/tests/worker-event-completeness.test.ts', from: 'unclassified', why: MOVED_TO_AGENT_PROTOCOL_TEST },
  // wire (2)
  { path: 'packages/agent/src/channels/__tests__/prompts.test.ts', from: 'wire', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/channels/types.test.ts', from: 'wire', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  // runtime-coordination (29)
  { path: 'packages/agent/src/agent-profile/__tests__/config-groups.test.ts', from: 'runtime-coordination', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/agent/__tests__/permissions-gate.test.ts', from: 'runtime-coordination', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/agent/__tests__/stream-retry.test.ts', from: 'runtime-coordination', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/agent/__tests__/tool-group-progress.test.ts', from: 'runtime-coordination', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/agent/__tests__/toolInvokePermission.test.ts', from: 'runtime-coordination', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/agent/dm/wake-prompt.test.ts', from: 'runtime-coordination', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/compact/__tests__/BackgroundPrefire.test.ts', from: 'runtime-coordination', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/compact/__tests__/CompactionManager.accounting.test.ts', from: 'runtime-coordination', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/compact/__tests__/CompactionManager.loop-guards.test.ts', from: 'runtime-coordination', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/compact/__tests__/PostCompactReinjector.test.ts', from: 'runtime-coordination', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/compact/__tests__/compactErrors.test.ts', from: 'runtime-coordination', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/compact/__tests__/contextWindow.test.ts', from: 'runtime-coordination', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/compact/__tests__/historySanitize.test.ts', from: 'runtime-coordination', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/compact/__tests__/imageParts.test.ts', from: 'runtime-coordination', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/compact/__tests__/imageTruncationTransform.test.ts', from: 'runtime-coordination', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/compact/__tests__/offloadCompress.test.ts', from: 'runtime-coordination', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/compact/__tests__/projectionCompress.test.ts', from: 'runtime-coordination', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/compact/__tests__/reformatCompress.test.ts', from: 'runtime-coordination', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/compact/__tests__/shared.test.ts', from: 'runtime-coordination', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/compact/__tests__/summaryGuard.test.ts', from: 'runtime-coordination', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/compact/__tests__/summaryRetry.degenerate.test.ts', from: 'runtime-coordination', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/compact/__tests__/summaryRetry.test.ts', from: 'runtime-coordination', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/compact/__tests__/tokenBudgetCut.test.ts', from: 'runtime-coordination', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/compact/strategies/__tests__/SessionMemoryCompactStrategy.test.ts', from: 'runtime-coordination', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/message/mailbox-attachment-context.test.ts', from: 'runtime-coordination', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/process/__tests__/permission-profile-bridge.test.ts', from: 'runtime-coordination', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/process/__tests__/seed-token-usage-plan546.test.ts', from: 'runtime-coordination', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/session/__tests__/db-signature.test.ts', from: 'runtime-coordination', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/wake/__tests__/groupTurn.test.ts', from: 'runtime-coordination', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  // capability-adapter (65)
  { path: 'packages/agent/src/context/__tests__/ContextLedger.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/journal/__tests__/journal-plan445.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/journal/__tests__/journal.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/modes/goal/__tests__/coordinator-goal.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/modes/goal/__tests__/goal-changes.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/modes/goal/__tests__/goal-commands.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/modes/goal/__tests__/goal-config.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/modes/goal/__tests__/goal-evaluator.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/modes/goal/__tests__/goal-plan.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/modes/goal/__tests__/goal-plan553.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/modes/goal/__tests__/goal-reminders.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/modes/goal/__tests__/goal-stop-detector.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/modes/goal/__tests__/goal-summarizer.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/modes/goal/__tests__/goal-tools.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/modes/plan/__tests__/reminders.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/modes/research-mode/__tests__/research-fanout.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/modes/research-mode/__tests__/research-reminders.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/modes/research-mode/__tests__/research-tools.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/prompts/bot/__tests__/commsAndProfile.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/prompts/bot/__tests__/delegation.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/prompts/bot/__tests__/epoch.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/prompts/bot/__tests__/framework.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/prompts/bot/__tests__/memory.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/prompts/bot/__tests__/promptConfig.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/prompts/bot/__tests__/sections.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/prompts/configs/__tests__/botConfig.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/prompts/dynamic/__tests__/skillsMetadata.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/tool/AgentManagementTool/__tests__/agent-management-tool.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/tool/AgentManagementTool/__tests__/discoverability.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/tool/ApplyPatchTool/__tests__/ApplyPatchTool.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/tool/BashTool/__tests__/safe-rm.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/tool/BrowserTool/platform-extractors/__tests__/domestic-extractors.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/tool/BrowserTool/platform-extractors/__tests__/new-extractors.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/tool/EditTool/__tests__/EditTool.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/tool/GlobTool/__tests__/GlobTool.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/tool/GrepTool/__tests__/GrepTool.sensitive.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/tool/GrepTool/__tests__/GrepTool.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/tool/GrepTool/__tests__/debug.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/tool/MemoryWriteTool/__tests__/memory-write-tool.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/tool/MessageSessionTool/__tests__/MessageSessionTool.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/tool/ReactToMessageTool/__tests__/react-to-message.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/tool/ReadTool/__tests__/ReadTool.concurrency.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/tool/ReadTool/__tests__/ReadTool.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/tool/ReadTool/__tests__/path-suggest.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/tool/ReadTool/__tests__/security.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/tool/SendToAgentTool/__tests__/send-to-agent-tool.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/tool/SessionSearchTool/__tests__/SessionSearchTool.format.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/tool/SubagentTool/__tests__/autoWakeAndKill.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/tool/SubagentTool/__tests__/constants.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/tool/SubagentTool/__tests__/continueParentWork.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/tool/SubagentTool/__tests__/subagentResult.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/tool/SubagentTool/__tests__/worktree.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/tool/TodoTool/__tests__/TodoTool.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/tool/ToolCatalogTool/__tests__/list-mode.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/tool/VisionTool/__tests__/VisionTool.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/tool/WriteStage1PolicyTool/__tests__/write-stage1-policy-tool.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/tool/WriteTool/__tests__/WriteTool.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/tool/__tests__/file-mutation-queue.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/tool/__tests__/file-read-state-448.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/tool/__tests__/file-snapshot.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/tool/__tests__/read-tool-truncation-448.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/tool/__tests__/task-verification.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/utils/__tests__/notebook.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/utils/__tests__/path.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/src/utils/__tests__/processTreeKill.test.ts', from: 'capability-adapter', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  // host-ui (1)
  { path: 'packages/agent/src/cli/__tests__/imageCmds.test.ts', from: 'host-ui', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  // unclassified (141)
  { path: 'packages/agent/tests/BashTool.contract.spec.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/PowerShellSecurity.spec.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/ShellIntelligence.spec.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/ShellProviders.spec.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/agentsmd/loader.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/agentsmd/stripSystemReminder.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/app-connection-tool.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/bash-admission.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/cli-control-plane/doctor.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/cli-control-plane/harness.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/cli-control-plane/headless-server.cjs', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/cli-control-plane/installCli.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/cli-control-plane/mcp.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/cli-control-plane/provider.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/cli-control-plane/seed-db.cjs', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/cli-control-plane/session-control-plane.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/cli-control-plane/skill.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/cli-control-plane/skillWrite.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/config.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/debug/ConversationTrace.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/helpers/setup.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/helpers/streamTestHelper.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/integration/DuyaAgent.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/integration/RealTasks.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/mcp/runtime-closure.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/mocks/fs/mockFs.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/mocks/llm/MockLLMClient.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/mocks/sqlite/inMemoryDb.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/permissions/PermissionResult.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/permissions/connectorApproval.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/permissions/permissions.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/permissions/securityPolicy.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/permissions/sessionGrantScope.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/process/agent-entry.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/runtime-config-bridge.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/setup.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/skills/agent-scoped.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/skills/bundled-user-collision.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/skills/conditionalSkills.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/skills/continuous-upgrade.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/skills/envVarCollector.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/skills/fingerprint.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/skills/loader-scan.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/skills/rootSnapshotCache.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/skills/snapshotIntegration.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/skills/system-skills.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/skills/user-dir-system-skip.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/timeouts.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/tool/BashTool/soft-yield.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/tool/BashTool/timeout-contract.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/tool/BashTool/truncateOutput.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/tool/byte-budget.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/tool/conditional-activation.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/tool/tool-type-fields.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/AgentTool/AgentTool.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/AgentTool/agentLifecycleBridge.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/AgentTool/builtInAgents.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/AgentTool/forkSubagent.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/AgentTool/prompt.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/Compact/CompactionManager.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/Compact/compaction-fidelity.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/SessionSearchTool.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/StreamingToolExecutor.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/ToolRegistry.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/agent-helpers.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/agent-profile/AgentProfileService.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/agent-profile/ToolFilter.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/agent-profile/config-agents.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/agent-profile/identity.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/agent-profile/subagentProfilePrompt.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/agent/DuyaAgent.allowed-tools.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/agent/DuyaAgent.omitAgentsMd.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/agent/DuyaAgent.plan315.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/agent/DuyaAgent.plan475-compact-rebase.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/agent/DuyaAgent.plan486.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/agent/DuyaAgent.thinking-replay.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/agent/TurnEventDispatcher.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/agent/compaction-coordinator.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/agent/duya-agent-assemble.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/agent/nestedInjection.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/agent/permissions-gate.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/agent/reminder-sources.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/agent/run-manifest-verification.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/agent/session-finalizer.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/agent/turn-stream-runner.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/agentsmd/loader.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/agentsmd/nested-loader.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/agentsmd/release-reinject.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/db-persistence-round-trip.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/fts-identifier-split.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/hooks/builtin-loop-hooks.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/hooks/loop-bus.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/lifecycle/BackgroundAgentLifecycle.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/lifecycle/CleanupRegistry.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/lifecycle/OutputFileWriter.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/lifecycle/ProgressTracker.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/lifecycle/buildTaskNotification.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/live-context-usage-tracker.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/llm/attachment-context.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/llm/inferProvider.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/memory-state/system_log.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/message-compaction-controller.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/permissions/autoModeReadOnlyShell.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/prompts/code/conditionalSections.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/prompts/code/rules.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/prompts/code/workingWithTheUser.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/prompts/fileLinkSection.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/prompts/hbs-renderer.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/prompts/hbs/hbs-prompt-system.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/prompts/hbs/memory-1d-rest.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/prompts/hbs/session-guidance-1d-rest.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/prompts/modules/module-registry.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/prompts/modules/project-modules.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/prompts/modules/research-modules.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/prompts/omitAgentsMdPreBuildHook.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/prompts/projectContinuity.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/prompts/prompt-ledger.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/prompts/promptProfileSelection.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/prompts/promptStructure.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/prompts/visualVerification.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/runtime-context-adapters.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/security/bashToolSecurity.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/security/skillScanner.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/tool-harness.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/tool/builtin-surface.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/tool/orchestration/dependency-graph-orchestrator.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/tool/orchestration/dependency-graph-serialisation.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/tool/tool-dependencies.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/tool/tool-execution-pipeline.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/tools/ReadTool.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/tools/SendArtifactTool.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/tools/fileReadState.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/tools/writeEditFlow.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/wake-epoch.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/wake-preemption.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/unit/wake-queue.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/utils/bash/commands.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/utils/bash/shellQuote.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/utils/path.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/utils/shell/intelligence.test.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
  { path: 'packages/agent/tests/vitest.config.ts', from: 'unclassified', why: RETIRED_WITH_THE_AGENT_TEST_SUITE },
];

/**
 * A fingerprint of everything `classify()` reads, and nothing else.
 *
 * RULE ORDER IS PART OF THE HASH, deliberately: first match wins, so moving a
 * rule reclassifies files without changing any prefix or category, and a
 * fingerprint that ignored position would not notice.
 *
 * `why` is NOT part of the hash. Prose is required to be non-empty by its own
 * assertion; folding it in would turn every rewording of a comment into a red
 * run, which is the same treadmill in a new place.
 */
function ruleTableFingerprint(): string {
  const parts: string[] = [`categories:${CATEGORIES.join(',')}`];
  for (const r of RULES) parts.push(`rule:${r.prefix}=${r.category}`);
  for (const key of Object.keys(FILE_OVERRIDES).sort()) {
    parts.push(`override:${key}=${FILE_OVERRIDES[key]}`);
  }
  for (const u of UNCLASSIFIED_PREFIXES) parts.push(`exclude:${u.prefix}`);
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

const RULE_TABLE_FINGERPRINT = 'f692e1999357454e';

describe('the classification is a partition of the source tree', () => {
  it('classifies every source file except the deliberately unclassified ones', () => {
    const orphans = SOURCE_FILES.filter((f) => classify(f) === null);
    const explained = orphans.filter(isUnclassifiedPrefix);
    const unexplained = orphans.filter((f) => !isUnclassifiedPrefix(f));
    // A file no rule claims and no exclusion explains is a file the map does not
    // describe. Reported by path so the fix is obvious, not a count. This is
    // the assertion that has to carry the "a file was ADDED" event now that
    // the census no longer trips on additions — and it is the right shape for
    // it, because a new file inside a classified directory is green here with
    // no re-record, while a new directory that nobody classified is red by
    // path.
    expect(unexplained).toEqual([]);
    expect(explained.length).toBeGreaterThan(0);
  });

  it('excludes only through prefixes that are stated and reachable', () => {
    // Replaces the recorded exclusion COUNT. A count could not say WHICH file
    // stopped being excluded, so a source file quietly relocated under a
    // `tests/` prefix only moved a total; the census holds the same bucket as
    // a set, so that file is now a named path. What is left to assert here is
    // the part a count never checked: that no exclusion is dead. An exclusion
    // nested inside a classified directory is unreachable, because the broader
    // rule claims the file first and the exclusion quietly describes nothing.
    const coveredByRule = UNCLASSIFIED_PREFIXES.filter((u) =>
      RULES.some((r) => u.prefix === r.prefix || u.prefix.startsWith(`${r.prefix}/`)),
    );
    expect(coveredByRule.map((u) => u.prefix)).toEqual([]);
  });

  it('states a reason for every unclassified prefix, so a gap is a decision', () => {
    const bare = UNCLASSIFIED_PREFIXES.filter((u) => u.why.trim().length === 0);
    expect(bare).toEqual([]);
  });

  it('holds each file in exactly one category', () => {
    // `classify` returns a single value by construction, so the real risk is
    // OVERLAP: two rules matching the same file where the second is dead. That
    // is asserted in the dead-rule test below; here the invariant is that the
    // union of the buckets is exactly the classified set, with no double count.
    const b = bucket();
    const total = [...b.values()].reduce((n, files) => n + files.length, 0);
    const classified = SOURCE_FILES.filter((f) => classify(f) !== null);
    expect(total).toBe(classified.length);
  });

  it('uses every category in the closed vocabulary', () => {
    // A category that quietly empties is how a map grows a hole nobody notices.
    const b = bucket();
    const empty = CATEGORIES.filter((c) => b.get(c)!.length === 0);
    expect(empty).toEqual([]);
  });
});

describe('the map is the one a human agreed to', () => {
  it('still holds the reviewed rule table', () => {
    // The census cannot see this event: editing a rule reclassifies files
    // without changing a path, so the subset property stays green while the
    // map's meaning moves underneath it. This is the tripwire, and it is the
    // one recorded number left in this file. See the header for why it cannot
    // be derived from the repo.
    //
    // A valid map change is ALLOWED — re-record this hash, and say in the
    // commit which prefix moved and why, because the diff of the map is the
    // review and this assertion is only the thing that forces it to be read.
    expect({ fingerprint: ruleTableFingerprint() }).toEqual({
      fingerprint: RULE_TABLE_FINGERPRINT,
    });
  });
});

describe('the recorded census still describes the tree', () => {
  for (const name of BUCKETS) {
    it(`still holds every recorded ${name} file in ${name}`, () => {
      // THE SAFETY PROPERTY, and the reason this file is not a treadmill.
      //
      // Asserted as a subset, not an equality, and that is the whole design:
      //
      //   recorded MINUS current = empty   -> nothing ever left this bucket
      //   current MINUS recorded = ignored  -> new files are free
      //
      // So RECATEGORISE (a file leaves for another bucket), RENAME (the old
      // path leaves) and DELETE (the path leaves) all fail here, naming the
      // exact path, while ADD costs nothing. The previous equality check could
      // not tell those apart, so it made every addition pay for them.
      const retired = new Set(
        RECORDED_LOSSES.filter((l) => l.from === name).map((l) => l.path),
      );
      const nowInBucket = new Set(CURRENT.get(name)!);
      const departed = CENSUS.paths
        .get(name)!
        .filter((p) => !nowInBucket.has(p) && !retired.has(p));
      expect(departed, `${name}: these recorded paths are no longer ${name}`).toEqual([]);
    });
  }
});

describe('the census is a well-formed baseline, not a stale copy', () => {
  it('uses exactly the closed vocabulary plus the excluded bucket', () => {
    // A misspelled `[bucket]` header would file its paths under a name no
    // subset assertion loops over, and the whole section would pass
    // vacuously. A baseline that cannot fail is worse than no baseline.
    expect(CENSUS.headers).toEqual([...BUCKETS]);
  });

  it('lists only paths, never a malformed line', () => {
    expect(CENSUS.shapeErrors).toEqual([]);
  });

  it('records each bucket size in its own header', () => {
    // Catches a truncated or duplicated line, which would otherwise silently
    // shorten the subset check for that bucket.
    const wrong: string[] = [];
    for (const name of BUCKETS) {
      const declared = CENSUS.declaredCounts.get(name);
      const listed = CENSUS.paths.get(name)!.length;
      if (declared !== listed) wrong.push(`${name}: header says ${declared}, lists ${listed}`);
    }
    expect(wrong).toEqual([]);
  });

  it('never lists the same path in two buckets', () => {
    // A path in two buckets is in neither, for the subset check: it would be
    // excused from one by the other. The map is a partition and the baseline
    // has to be one too.
    const seen = new Map<string, Bucket>();
    const dupes: string[] = [];
    for (const name of BUCKETS) {
      for (const p of CENSUS.paths.get(name)!) {
        const first = seen.get(p);
        if (first === undefined) seen.set(p, name);
        else if (first !== name) dupes.push(`${p} is in both ${first} and ${name}`);
      }
    }
    expect(dupes).toEqual([]);
  });
});

describe('retiring a recorded path is a per-path decision with a reason', () => {
  it('gives every retired path a bucket and a reason', () => {
    const bare = RECORDED_LOSSES.filter(
      (l) => l.why.trim().length === 0 || !BUCKETS.includes(l.from),
    );
    expect(bare.map((l) => l.path)).toEqual([]);
  });

  it('never retires the same path twice', () => {
    const counts = new Map<string, number>();
    for (const l of RECORDED_LOSSES) counts.set(l.path, (counts.get(l.path) ?? 0) + 1);
    expect([...counts.entries()].filter(([, n]) => n > 1).map(([p]) => p)).toEqual([]);
  });

  it('retires only paths that have actually left their bucket', () => {
    // What stops RECORDED_LOSSES from decaying into a blanket permission. An
    // entry is only a claim about a file that is GONE from its bucket, so an
    // entry for a file that is still sitting there is a live permission for
    // nothing and fails here. The list therefore has to be pruned as the tree
    // comes back, and cannot be used to excuse a file wholesale.
    const stale = RECORDED_LOSSES.filter((l) =>
      CURRENT.get(l.from)!.includes(l.path),
    ).map((l) => `${l.path} never left ${l.from}`);
    expect(stale).toEqual([]);
  });
});

describe('the rules are ordered and none of them is dead', () => {
  it('never lets a broader rule shadow a narrower one', () => {
    // Most-specific-first is what makes "first match wins" correct. A broader
    // rule above a narrower one makes the narrower one unreachable, and an
    // unreachable rule is a claim about code that nothing reads.
    //
    // ADJACENCY IS NOT THE TEST, and treating it as one is how this gate came to
    // pass vacuously. It once reported a dead rule only when the broader rule
    // sat DIRECTLY above the narrower one — which held for none of the six rules
    // this map actually shadowed, because the exceptions to
    // `packages/agent-protocol/src` are 14 slots below it and carry their own
    // category. The gate meant to catch dead rules caught none.
    //
    // So the question asked per rule is the real one: is the NEAREST rule above
    // it that covers its whole prefix also the first rule able to claim it? If
    // nothing between them covers it, the rule is dead no matter how far above
    // the shadower sits — which is why the loop walks upward from `j` rather
    // than testing neighbours.
    const covers = (upper: string, lower: string): boolean =>
      lower === upper || lower.startsWith(`${upper}/`);
    const shadowed: string[] = [];
    for (let j = 0; j < RULES.length; j++) {
      const lower = RULES[j].prefix;
      for (let i = j - 1; i >= 0; i--) {
        if (!covers(RULES[i].prefix, lower)) continue;
        // Nearest covering rule found, so stop: anything further up is shadowed
        // BY this one and could not claim the prefix before it either.
        const intercepted = RULES.slice(i + 1, j).some((k) => covers(k.prefix, lower));
        if (!intercepted) {
          shadowed.push(
            `${lower} [rule ${j}, ${RULES[j].category}] is shadowed by ${RULES[i].prefix} [rule ${i}, ${RULES[i].category}]`,
          );
        }
        break;
      }
    }
    expect(shadowed).toEqual([]);
  });

  it('gives every rule a reason and a real category', () => {
    const bad = RULES.filter(
      (r) => r.why.trim().length === 0 || !CATEGORIES.includes(r.category),
    );
    expect(bad.map((r) => r.prefix)).toEqual([]);
  });

  it('matches at least one file, so no rule is a claim about nothing', () => {
    const dead = RULES.filter(
      (r) => !SOURCE_FILES.some((f) => f === r.prefix || f.startsWith(`${r.prefix}/`)),
    );
    expect(dead.map((r) => r.prefix)).toEqual([]);
  });

  it('never has two rules for the same prefix', () => {
    const seen = new Map<string, number>();
    for (const r of RULES) seen.set(r.prefix, (seen.get(r.prefix) ?? 0) + 1);
    expect([...seen.entries()].filter(([, n]) => n > 1)).toEqual([]);
  });

  it('gives every file override a reason, via a rule that already names the directory', () => {
    // An override with no covering rule is a file that exists only in the
    // override list, which is the shape that rots first.
    const orphans = Object.keys(FILE_OVERRIDES).filter(
      (f) => !RULES.some((r) => f.startsWith(`${r.prefix}/`) || f === r.prefix),
    );
    expect(orphans).toEqual([]);
  });
});

describe('the purity findings are real and still present', () => {
  it('cites a line that exists and still carries the evidence', () => {
    // A finding that names a stale line is worse than no finding: it reads as
    // verified. This re-reads each cited line and matches the recorded evidence
    // against it, so a fix that moves the line fails here and the finding is
    // retired deliberately.
    const broken: string[] = [];
    for (const v of PURE_VIOLATIONS) {
      const abs = path.join(REPO_ROOT, v.file);
      if (!fs.existsSync(abs)) {
        broken.push(`${v.file}: cited file does not exist`);
        continue;
      }
      const lines = fs.readFileSync(abs, 'utf8').split('\n');
      const actual = (lines[v.line - 1] ?? '').trim();
      if (!actual.includes(v.evidence.trim())) {
        broken.push(`${v.file}:${v.line} expected ${JSON.stringify(v.evidence)}, found ${JSON.stringify(actual)}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('names the declared layer and a reason for every violation', () => {
    const bare = PURE_VIOLATIONS.filter(
      (v) => v.declaredLayer.trim().length === 0 || v.why.trim().length === 0,
    );
    expect(bare.map((v) => v.file)).toEqual([]);
  });
});

describe('the declared ports are a placement decision, not a wish', () => {
  it('names a method, a target and the current shape for every port', () => {
    const bare = PORTS.filter(
      (p) =>
        p.name.trim().length === 0 ||
        p.method.trim().length === 0 ||
        p.target.trim().length === 0 ||
        p.now.trim().length === 0,
    );
    expect(bare.map((p) => p.name)).toEqual([]);
  });

  it('covers every port M5.1 names', () => {
    // The plan's list, verbatim. A port that quietly disappears from the map is
    // a slice that quietly did not get planned.
    const required = [
      'ModelClient',
      'ToolExecutor',
      'ContextLoader',
      'TranscriptRepository',
      'PermissionBroker',
      'Clock',
      'Telemetry',
      'ProcessScope',
      'SecretResolver',
    ];
    const declared = PORTS.map((p) => p.name);
    expect(required.filter((r) => !declared.includes(r))).toEqual([]);
  });

  it('gives every port a unique name', () => {
    const names = PORTS.map((p) => p.name);
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
  });
});
