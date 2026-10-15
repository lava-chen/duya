'use strict';

/**
 * A stand-in worker that does nothing but write to stderr, so the supervisor's
 * stderr accounting can be tested through the REAL pipe rather than by calling
 * a private method. Behaviour is driven by env vars so one fixture covers every
 * case:
 *
 *   DUYA_TEST_STDERR_REPEAT=n    write the same line n times
 *   DUYA_TEST_STDERR_DISTINCT=n  write n different lines
 *   DUYA_TEST_STDERR_MULTILINE=1 write three lines in ONE chunk
 *
 * It then idles briefly and exits, so the parent observes a clean exit.
 */

function write(line) {
  process.stderr.write(line + '\n');
}

const repeat = Number(process.env.DUYA_TEST_STDERR_REPEAT || '0');
for (let i = 0; i < repeat; i += 1) {
  write('npm error 404 GET https://registry.npmjs.org/@foo%2fbar');
}

const distinct = Number(process.env.DUYA_TEST_STDERR_DISTINCT || '0');
for (let i = 0; i < distinct; i += 1) {
  write('[INFO] distinct worker line ' + i);
}

if (process.env.DUYA_TEST_STDERR_MULTILINE === '1') {
  process.stderr.write('[WARN] first of three\n[ERROR] second of three\nthird, unprefixed\n');
}

if (process.env.DUYA_TEST_STDERR_HOLD === '1') {
  setInterval(() => {}, 1000);
} else {
  // Deliberately NOT process.exit(): writes to a pipe are asynchronous, and
  // process.exit drops whatever has not been flushed yet. A 260-line burst
  // would silently arrive truncated and the test would blame the supervisor.
  // An empty timer lets the loop drain and the process exit on its own.
  setTimeout(() => {}, 100);
}
