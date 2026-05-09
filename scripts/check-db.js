const Database = require('better-sqlite3');
const db = new Database('C:/Users/lavachen/AppData/Roaming/DUYA/databases/duya-main.db');
const rows = db.prepare(`
  SELECT id, role, msg_type, substr(content,1,120) as content_preview, 
         tool_name, thinking IS NOT NULL as has_thinking, token_usage, duration_ms, status
  FROM messages ORDER BY created_at DESC LIMIT 20
`).all();
console.log(JSON.stringify(rows, null, 2));
db.close();
