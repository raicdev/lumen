import { formatResourceLabel, parseResourceKey, type ResourceLabelFormatter } from "../../../shared/menus-walkthroughs.ts";

/**
 * The label surfaces without an editor (tabs, breadcrumbs) show for a
 * resource: what its resourceLabelFormatter says, else the name they have
 * (files and unknown schemes keep it). `undefined` when no formatter applies.
 */
export function formattedResourceLabel(formatters: ResourceLabelFormatter[], key: string): string | undefined {
  const resource = parseResourceKey(key);
  return resource ? formatResourceLabel(formatters, resource) : undefined;
}

/** As `formattedResourceLabel`, with `fallback` for files and schemes no formatter covers. */
export function labelOf(formatters: ResourceLabelFormatter[], key: string, fallback: string): string {
  return formattedResourceLabel(formatters, key) ?? fallback;
}
