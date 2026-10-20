// The Host's dist chain reaches @duya/plugin-core, whose `moduleResolution:
// bundler` emit carries extensionless relative specifiers and directory
// imports (AGENTS.md). Plain Node has no such fallback, so the acceptance
// fixture and the BFF it spawns load this hook before anything else.
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        if (error?.code === 'ERR_MODULE_NOT_FOUND') {
          try { return nextResolve(`${specifier}.js`, context); } catch {}
        }
        if (error?.code === 'ERR_UNSUPPORTED_DIR_IMPORT' || error?.code === 'ERR_MODULE_NOT_FOUND') {
          return nextResolve(`${specifier}/index.js`, context);
        }
      }
      throw error;
    }
  },
});
