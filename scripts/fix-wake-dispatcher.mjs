// scripts/fix-wake-dispatcher.mjs - Fix malformed duplicate QUIET_REVIVAL_INSTRUCTION
import { readFileSync, writeFileSync } from 'fs';

const file = 'electron/wake/wake-dispatcher.ts';
let content = readFileSync(file, 'utf8');

// The file has TWO declarations of QUIET_REVIVAL_INSTRUCTION:
// 1. A malformed one where the string has actual newlines inside it (bad)
// 2. A correct one with escaped \n\n (good)

// We need to remove the malformed one (the first occurrence).

// Find the first occurrence of the malformed pattern
// It's: "const QUIET_REVIVAL_INSTRUCTION =\n  '\n\n[system]"
// The second (correct) one is: "const QUIET_REVIVAL_INSTRUCTION =\n  '\n\n[system]"

// Actually, looking at the output, the first one has literal newlines in the string:
// '\n\n[system]...  (with actual newlines between the quotes)
// The second one has: '\n\n[system]...  (with escaped \n\n)

// Let me find both occurrences and remove the first one
const marker = "const QUIET_REVIVAL_INSTRUCTION =\n  '\n\n[system]";

// Find all occurrences
let idx = 0;
const positions = [];
while ((idx = content.indexOf(marker, idx)) !== -1) {
  positions.push(idx);
  idx++;
}
console.log('Found', positions.length, 'occurrences at:', positions);

if (positions.length !== 2) {
  console.error('Expected 2 occurrences, found', positions.length);
  process.exit(1);
}

// Remove the first occurrence (from the newline before it to the start of the second)
const firstStart = positions[0];
const secondStart = positions[1];

// Go back to find the start of the line (or blank line before the comment)
let removeStart = firstStart;
while (removeStart > 0 && content[removeStart - 1] !== '\n') removeStart--;
// Go back one more line (the blank line separator)
while (removeStart > 0 && content[removeStart - 1] === '\n') removeStart--;

console.log('Removing from', removeStart, 'to', secondStart);
const removed = content.slice(removeStart, secondStart);
console.log('Removed:', JSON.stringify(removed.slice(0, 100)));

// Also remove the blank lines before the second occurrence
let afterSecond = secondStart;
while (content[afterSecond - 1] === '\n' || content[afterSecond - 1] === ' ') afterSecond--;

content = content.slice(0, removeStart) + '\n\n' + content.slice(secondStart);

writeFileSync(file, content);
console.log('Done');
