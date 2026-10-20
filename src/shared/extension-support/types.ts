import type { SupportLevel } from "../extensions.ts";

export type SupportEntry = SupportLevel | [SupportLevel, string];

/**
 * What one feature area changes in the support table (shared/extension-api.ts).
 * Each area owns its file in this folder, so areas never edit the same lines.
 */
export type AreaSupport = {
  /** Members (`"tasks.registerTaskProvider"`) over the base table. `null` removes an entry (e.g. the `"tasks.*"` wildcard). */
  api?: Record<string, SupportEntry | null>;
  /** Classes / enums the area now exports at the top level: added to API_TYPES, dropped from API_TYPES_COMPAT / API_TYPES_MISSING. */
  types?: string[];
  /** Contribution points (`contributes.*`) over CONTRIBUTION_SUPPORT. `null` removes an entry. */
  contributions?: Record<string, SupportEntry | null>;
};
