import type { PluginSource, PluginSourceType } from './types';

const BUILTIN_MARKETPLACE = 'builtin';

const KNOWN_MARKETPLACES: Record<string, PluginSourceType> = {
  [BUILTIN_MARKETPLACE]: 'builtin-directory',
  github: 'github',
  npm: 'npm',
  local: 'local-path',
};

const GITHUB_DOMAIN_PREFIX = 'github.com/';
const GIT_SUFFIX = '.git';
const GIT_PROTOCOL_PREFIX = 'git+';

interface ParsedIdentifier {
  name: string;
  marketplace?: string;
  version?: string;
}

function parseIdentifierPart(raw: string): ParsedIdentifier {
  const withoutVersion = raw.split('#')[0];

  const atIndex = withoutVersion.lastIndexOf('@');
  if (atIndex <= 0) {
    return { name: withoutVersion };
  }

  const name = withoutVersion.substring(0, atIndex);
  const marketplace = withoutVersion.substring(atIndex + 1);

  if (!name || !marketplace) {
    return { name: withoutVersion };
  }

  return { name, marketplace };
}

function parseVersion(raw: string): string | undefined {
  const hashIndex = raw.indexOf('#');
  if (hashIndex < 0) return undefined;
  return raw.substring(hashIndex + 1) || undefined;
}

function detectUrlType(identifier: string): PluginSourceType | null {
  if (/^https?:\/\//.test(identifier)) {
    if (identifier.includes(GITHUB_DOMAIN_PREFIX)) {
      return 'github';
    }
    if (identifier.endsWith(GIT_SUFFIX)) {
      return 'https-git';
    }
    return 'url-zip';
  }

  if (identifier.startsWith(GIT_PROTOCOL_PREFIX)) {
    return 'https-git';
  }

  const cleanIdent = identifier.startsWith('git@') ? identifier : `https://${identifier}`;
  try {
    const url = new URL(cleanIdent);
    if (url.hostname === 'github.com') {
      return 'github';
    }
    if (url.hostname === 'npmjs.com' || url.hostname === 'www.npmjs.com') {
      return 'npm';
    }
  } catch {
    // not a URL
  }

  return null;
}

function isAbsolutePath(identifier: string): boolean {
  if (process.platform === 'win32') {
    return /^[A-Za-z]:[\\/]/.test(identifier);
  }
  return identifier.startsWith('/');
}

function isRelativePath(identifier: string): boolean {
  return identifier.startsWith('./') || identifier.startsWith('../') || identifier.startsWith('.\\') || identifier.startsWith('..\\');
}

export function parsePluginIdentifier(raw: string): PluginSource {
  const version = parseVersion(raw);
  const stripped = version ? raw.substring(0, raw.indexOf('#')) : raw;

  const urlType = detectUrlType(raw);
  if (urlType) {
    return {
      type: urlType,
      identifier: raw,
      marketplace: urlType === 'github' ? 'github' : urlType === 'npm' ? 'npm' : undefined,
    };
  }

  if (isAbsolutePath(raw) || isRelativePath(raw)) {
    return {
      type: 'local-path',
      identifier: raw,
      marketplace: 'local',
    };
  }

  const { name, marketplace } = parseIdentifierPart(stripped);

  if (marketplace) {
    const known = KNOWN_MARKETPLACES[marketplace.toLowerCase()];
    if (known) {
      return {
        type: known,
        identifier: raw,
        marketplace: marketplace.toLowerCase(),
      };
    }

    return {
      type: detectNonStandardMarketplace(marketplace, name),
      identifier: raw,
      marketplace,
    };
  }

  return {
    type: 'builtin-directory',
    identifier: name,
    marketplace: BUILTIN_MARKETPLACE,
  };
}

function detectNonStandardMarketplace(marketplace: string, _name: string): PluginSourceType {
  if (marketplace.includes('github.com')) {
    return 'github';
  }
  if (marketplace.includes('npmjs.com')) {
    return 'npm';
  }
  if (marketplace.startsWith('http')) {
    return 'url-zip';
  }
  if (marketplace.endsWith(GIT_SUFFIX)) {
    return 'https-git';
  }
  return 'github';
}

export const RESOLVERS_DIR = __dirname;