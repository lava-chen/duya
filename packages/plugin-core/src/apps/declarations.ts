import { z } from 'zod';

const APP_ID_PATTERN = /^[a-z][a-z0-9_-]*$/;
const CAPABILITY_ID_PATTERN = /^[a-z][a-z0-9_.:-]*$/;

function isPackageRelativePosixPath(value: string): boolean {
  if (value.length > 512 || value.includes('\0') || value.includes('\\')) return false;
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value) || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)) {
    return false;
  }

  const segments = value.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

/** A package-local App declaration; it describes metadata, not a grant. */
export const PluginAppDefinitionSchema = z
  .object({
    appId: z.string().min(1).max(64).regex(APP_ID_PATTERN),
    entry: z.string().min(1).refine(isPackageRelativePosixPath),
    requiredCapabilities: z
      .array(z.string().min(1).max(128).regex(CAPABILITY_ID_PATTERN))
      .max(64),
    stateSchemaVersion: z.number().int().positive(),
  })
  .strict();

export type PluginAppDefinition = z.infer<typeof PluginAppDefinitionSchema>;

export const PluginAppDefinitionsSchema = z
  .array(PluginAppDefinitionSchema)
  .max(64)
  .superRefine((apps, ctx) => {
    const seen = new Set<string>();
    apps.forEach((app, index) => {
      if (seen.has(app.appId)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate appId: ${app.appId}`,
          path: [index, 'appId'],
        });
      }
      seen.add(app.appId);
    });
  });
