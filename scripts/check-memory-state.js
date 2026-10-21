import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('C:/Users/lavachen/AppData/Roaming/duya/duya-dev/databases/memory-state.db');

console.log('=== Before reset ===');
console.log(db.prepare("SELECT rollout_id, job_status, attempt_count, last_error FROM rollout_leases").all());

// Reset failed leases so they get a fresh attempt after the bug fix
const result = db.prepare("DELETE FROM rollout_leases WHERE job_status = 'failed'").run();
console.log(`\nDeleted ${result.changes} failed leases`);

console.log('\n=== After reset ===');
console.log(db.prepare("SELECT COUNT(*) as c FROM rollout_leases").get());
