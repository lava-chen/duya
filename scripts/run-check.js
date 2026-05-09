const { execFileSync } = require('child_process');
const electronPath = require('electron');
const scriptPath = require('path').resolve(__dirname, 'check-db.js');
const out = execFileSync(electronPath, [scriptPath], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  shell: true,
  cwd: __dirname
});
console.log(out.toString());
