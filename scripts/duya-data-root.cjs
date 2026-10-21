const os = require('os');
const path = require('path');

const TEST_NAMESPACE_PATTERN = /^[a-zA-Z0-9_-]+$/;

function resolveTestNamespace(args, envNamespace) {
  for (const arg of args) {
    if (!arg.startsWith('--duya-namespace=')) continue;
    const namespace = arg.slice('--duya-namespace='.length);
    return namespace && TEST_NAMESPACE_PATTERN.test(namespace) ? namespace : null;
  }

  const namespaceFlagIndex = args.indexOf('--duya-namespace');
  if (namespaceFlagIndex >= 0) {
    const namespace = args[namespaceFlagIndex + 1];
    return namespace && TEST_NAMESPACE_PATTERN.test(namespace) ? namespace : null;
  }

  return envNamespace && TEST_NAMESPACE_PATTERN.test(envNamespace) ? envNamespace : null;
}

function resolveDataRoot(options = {}) {
  const env = options.env ?? process.env;
  const args = options.args ?? process.argv;
  const homeDirectory = options.homeDirectory ?? os.homedir();

  if (env.DUYA_TEST === '1') {
    const namespace = resolveTestNamespace(args, env.DUYA_TEST_NAMESPACE);
    if (namespace) return path.join(homeDirectory, '.duya', 'test-namespaces', namespace);
  }

  const explicitRoot = env.DUYA_DATA_ROOT?.trim();
  if (explicitRoot) return path.resolve(explicitRoot);
  return path.join(homeDirectory, '.duya');
}

module.exports = { resolveDataRoot };
