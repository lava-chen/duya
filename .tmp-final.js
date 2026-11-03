const fs = require('fs');
const Database = require('better-sqlite3');

const core = new Database('C:/Users/lavachen/.duya/duya-core.db', { readonly: true, fileMustExist: true });
const f = 'C:/Users/lavachen/.duya/sessions/2026/11/03/rollout-2026-11-03T00-46-33-848Z-38638d10-f10a-4e2e-8369-2ca0b83ee867.jsonl';
const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean);

const roll = JSON.parse(lines[61]);
const rollText = roll.message.content.find((c) => c.type === 'text').text;

const rows = core.prepare('select seq, envelope_json from run_events where run_id=? order by seq').all('6b5b1469-9c6b-4313-a948-2e549748e309');
let evText = null;
for (const r of rows) {
  const env = JSON.parse(r.envelope_json);
  if (env.type === 'assistant.text_block' && typeof env.text === 'string' && env.text.includes('minimax')) evText = env.text;
}
console.log('run_event text found:', evText !== null);
console.log('rollout text === run_event text :', evText === rollText);
console.log('lengths:', rollText.length, evText === null ? '-' : evText.length);

const kinds = rows.map((r) => JSON.parse(r.envelope_json).type);
console.log('tool.* events in run:', kinds.filter((k) => k.startsWith('tool.')).length);
for (const r of rows) {
  const env = JSON.parse(r.envelope_json);
  if (env.type === 'turn.completed') console.log('turn.completed stopReason:', env.stopReason, '| turn index', env.index);
}
