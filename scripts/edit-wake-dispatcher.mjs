// scripts/edit-wake-dispatcher.mjs - Add QUIET_REVIVAL to wake-dispatcher.ts
import { readFileSync, writeFileSync } from 'fs';

const file = 'electron/wake/wake-dispatcher.ts';
let content = readFileSync(file, 'utf8');

// The constant to inject before promptForItem
const QUIET_INSTRUCTION = `/** P4.1: instruction injected into the prompt when a wake has a quiet origin (automation). */
const QUIET_REVIVAL_INSTRUCTION =
  '\\n\\n[system] This wake originated from a quiet standing order (background automation). ' +
  'Do not send any visible notification to the user. Simply continue with the work silently.'
`;

// Find the comment before promptForItem and inject the constant before it
const marker = '/** Build the model-facing prompt for an item. Empty string = skip silently. */';
const idx = content.indexOf(marker);
if (idx === -1) { console.error('Marker not found'); process.exit(1); }

// Find the blank line before the marker
let insertAt = idx;
while (insertAt > 0 && content[insertAt - 1] === ' ') insertAt--;
if (insertAt > 0 && content[insertAt - 1] === '\n') insertAt--;
if (insertAt > 0 && content[insertAt - 1] === '\r') insertAt--;

content = content.slice(0, insertAt) + '\n' + QUIET_INSTRUCTION + '\n\n' + content.slice(insertAt);

// Now replace the promptForItem function body to use base variable and add quietOrigin injection
// Find the function start
const funcStart = content.indexOf('function promptForItem(item: WakeItem): string {');
if (funcStart === -1) { console.error('promptForItem function not found'); process.exit(1); }

// Find the opening brace and the matching closing brace
let braceCount = 0;
let funcBodyStart = content.indexOf('{', funcStart);
let funcBodyEnd = -1;
for (let i = funcBodyStart; i < content.length; i++) {
  if (content[i] === '{') braceCount++;
  else if (content[i] === '}') {
    braceCount--;
    if (braceCount === 0) { funcBodyEnd = i; break; }
  }
}
if (funcBodyEnd === -1) { console.error('Could not find function end'); process.exit(1); }

// The new function body
const newBody = `
  let base = ''
  switch (item.payload.kind) {
    case 'completion': {
      const summary = (item.payload.summary ?? '').trim()
      const label = item.payload.title ? \` (\${item.payload.title})\` : ''
      base = summary
        ? \`[system] A background task finished\${label}:
\${summary}

Review the result above and reply to the user if there is something worth reporting.\`
        : \`[system] A background task completed (\${item.payload.taskId}). Review its result and continue if useful.\`
      break
    }
    case 'broadcast': {
      const body = (item.payload.text ?? '').trim()
      base = body
        ? \`[system] Admin broadcast (\${item.payload.broadcastId}):
\${body}

Review it and act if it concerns you.\`
        : \`[system] An admin broadcast (\${item.payload.broadcastId}) was sent. Review and act if it concerns you.\`
      break
    }
    case 'inbound': {
      const body = (item.payload.text ?? '').trim()
      base = body
        ? \`[system] A message arrived from an external channel (envelope \${item.payload.envelopeId}):
\${body}

Respond to the sender if appropriate.\`
        : \`[system] A message arrived from an external channel (envelope \${item.payload.envelopeId}). Respond to the sender if appropriate.\`
      break
    }
    case 'user': {
      base = (item.payload.text ?? '').trim() || '[system] Continue with the user request.'
      break
    }
    default:
      return ''
  }

  // P4.1: append QUIET_REVIVAL instruction when this wake came from a quiet
  // automation. The agent must not send a visible notification to the user.
  if (item.quietOrigin) {
    base += QUIET_REVIVAL_INSTRUCTION
  }
  return base
}`;

// Find the end of the 'function promptForItem...' line and replace from there
const lineEnd = content.indexOf('\n', funcStart);
const before = content.slice(0, lineEnd + 1);
const after = content.slice(funcBodyEnd + 1);
content = before + newBody + after;

writeFileSync(file, content);
console.log('Done');
