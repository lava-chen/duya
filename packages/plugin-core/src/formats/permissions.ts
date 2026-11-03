import { z } from 'zod';

/** A manifest permission declaration; runtime approval remains a separate decision. */
export const PluginPermissionSchema = z.object({
  name: z.string().min(1),
  scope: z.string().optional(),
  domains: z.array(z.string()).optional(),
});

export type PluginManifestPermission = z.infer<typeof PluginPermissionSchema>;
