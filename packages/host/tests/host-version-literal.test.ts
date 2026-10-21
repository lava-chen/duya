/**
 * `HOST_VERSION` must not drift from `packages/host/package.json`.
 *
 * ## Why this is a literal and why it still needs a guard
 *
 * `http-server.ts` is esbuild-bundled into the packaged Host, where a
 * `package.json` lookup is not guaranteed to resolve. So the version is a
 * literal — that part is the right call and this test does not argue with it.
 *
 * What the literal cannot do is notice that it stopped being true. The Host
 * answers a handshake with this string, and the CLI's capability refusal text
 * quotes it (`duya-host 0.1.0 does not provide …`), so a stale literal does not
 * read as "old version" anywhere a user or a test can see: it reads as the
 * Host's name, and both sides agree on a false statement.
 *
 * So: the literal stays, and a test fails the day it disagrees with the
 * manifest. A build-time import would fix the drift and break the packaged
 * Host; this fixes the drift without moving the read.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SOURCE = path.resolve(HERE, '..', 'src', 'http-server.ts');
const MANIFEST = path.resolve(HERE, '..', 'package.json');

describe('Host version', () => {
  it('answers a handshake with the version its own manifest declares', () => {
    const source = fs.readFileSync(SERVER_SOURCE, 'utf8');
    const literal = /^const HOST_VERSION = '([^']+)';$/m.exec(source);
    expect(literal, 'http-server.ts must keep a HOST_VERSION literal for the packaged Host').not.toBeNull();

    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as { version?: string };
    expect(typeof manifest.version).toBe('string');

    // The whole point: one of these two is a lie the moment they disagree, and
    // nothing else in the system would notice.
    expect(literal![1]).toBe(manifest.version);
  });
});
