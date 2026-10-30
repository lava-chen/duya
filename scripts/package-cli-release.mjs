import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.env.DUYA_CLI_VERSION;
const outputArg = process.argv.find((arg) => arg.startsWith('--output='));
const outputFlagIndex = process.argv.indexOf('--output');
const outputValue = outputArg?.slice('--output='.length)
  ?? (outputFlagIndex >= 0 ? process.argv[outputFlagIndex + 1] : undefined);

if (version === undefined || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error('Set DUYA_CLI_VERSION to the version encoded by the cli/v* release tag');
}
if (outputValue === undefined || outputValue.length === 0) {
  throw new Error('Usage: DUYA_CLI_VERSION=x.y.z node scripts/package-cli-release.mjs --output <directory>');
}

const output = path.resolve(outputValue);
if (output === root || output === path.dirname(root)) {
  throw new Error(`Refusing to use a repository directory as the output package: ${output}`);
}
const cliBundle = path.join(root, 'packages/cli/bundle/cli.cjs');
const workerBundle = path.join(root, 'packages/host/bundle');
if (!fs.existsSync(cliBundle) || !fs.existsSync(path.join(workerBundle, 'worker-entry.js'))) {
  throw new Error('Build the CLI and Host worker bundles before packaging the CLI release');
}

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(path.join(output, 'app'), { recursive: true });
fs.mkdirSync(path.join(output, 'runtime'), { recursive: true });
fs.mkdirSync(path.join(output, 'bin'), { recursive: true });
fs.mkdirSync(path.join(output, 'node_modules'), { recursive: true });
fs.copyFileSync(cliBundle, path.join(output, 'app/cli.cjs'));
fs.copyFileSync(path.join(root, 'install.sh'), path.join(output, 'install.sh'));
fs.chmodSync(path.join(output, 'install.sh'), 0o755);
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(output, 'LICENSE'));
fs.copyFileSync(path.join(root, 'LICENSE-COMMERCIAL'), path.join(output, 'LICENSE-COMMERCIAL'));
fs.cpSync(workerBundle, path.join(output, 'harness-bundle'), {
  recursive: true,
  filter: (source) => !source.endsWith('worker-metafile.json'),
});
const runtimeExecutable = fs.realpathSync(process.execPath);
const runtimeRoot = path.dirname(path.dirname(runtimeExecutable));
const runtimeLicense = path.join(runtimeRoot, 'LICENSE');
if (!fs.existsSync(runtimeLicense)) {
  throw new Error(`Node.js runtime license was not found beside ${runtimeExecutable}`);
}
fs.copyFileSync(runtimeExecutable, path.join(output, 'runtime/node'));
fs.copyFileSync(runtimeLicense, path.join(output, 'runtime/LICENSE'));
fs.chmodSync(path.join(output, 'runtime/node'), 0o755);
fs.writeFileSync(path.join(output, 'VERSION'), `${version}\n`);

const dependencyRoots = ['better-sqlite3', 'blessed', 'esbuild', 'playwright', 'fsevents'];
const copied = new Set();

function packagePath(name, fromDirectory) {
  const segments = name.split('/');
  let directory = fromDirectory;
  while (true) {
    const candidate = path.join(directory, 'node_modules', ...segments);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function copyPackage(name, fromDirectory, required) {
  const source = packagePath(name, fromDirectory);
  if (source === undefined) {
    if (required) throw new Error(`Required CLI runtime dependency is not installed: ${name}`);
    return;
  }

  const target = path.join(output, 'node_modules', ...name.split('/'));
  const realSource = fs.realpathSync(source);
  const key = `${name}:${realSource}`;
  if (copied.has(key)) return;
  copied.add(key);

  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  fs.cpSync(source, target, { recursive: true, dereference: true });
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    copyPackage(dependency, source, true);
  }
  for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
    copyPackage(dependency, source, false);
  }
}

for (const dependency of dependencyRoots) {
  copyPackage(dependency, root, dependency !== 'fsevents');
}

const launcher = `#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export DUYA_CLI_VERSION=$(cat "$ROOT/VERSION")
exec "$ROOT/runtime/node" "$ROOT/app/cli.cjs" "$@"
`;
fs.writeFileSync(path.join(output, 'bin/duya'), launcher, { mode: 0o755 });
fs.chmodSync(path.join(output, 'bin/duya'), 0o755);

process.stdout.write(`Packaged Duya CLI ${version} for ${process.platform}-${process.arch} at ${output}\n`);
