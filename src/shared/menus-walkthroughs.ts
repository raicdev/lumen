/**
 * Pure logic of the "menus-walkthroughs" area, shared by the extension host and
 * the window: contributed menus with submenus (contributes.menus + submenus),
 * walkthroughs (contributes.walkthroughs) with their completion events, and
 * resource label formatters (contributes.resourceLabelFormatters). No DOM, no
 * Node: tests run it directly (test/features/menus-walkthroughs.test.ts).
 */

type Localized = string | { value?: string; original?: string } | undefined;

/** The slice of an extension these functions read. */
export type ContributionSource = {
  id: string;
  manifest: { contributes?: Record<string, unknown> };
  /** Data URLs of contributed commands' icon files by command (window only). */
  commandIcons?: Record<string, string>;
};

const text = (value: unknown): string => (typeof value === "string" ? value : ((value as { value?: string } | undefined)?.value ?? ""));
const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : value ? [value as T] : []);

/* ── menus ───────────────────────────────────────────────────────────── */

export type MenuEntry = { command?: string; submenu?: string; when?: string; group?: string; alt?: string };
export type SubmenuContribution = { id: string; label?: Localized; icon?: string | { light?: string; dark?: string } };

export type ResolvedMenuItem =
  | { type: "command"; command: string; title: string; icon?: string; group: string; order: number; extensionId: string; alt?: string }
  | { type: "submenu"; id: string; title: string; icon?: string; group: string; order: number; extensionId: string; items: ResolvedMenuItem[] };

const MAX_SUBMENU_DEPTH = 6;

function splitGroup(group: string | undefined): { group: string; order: number } {
  const [name = "", order = "0"] = (group ?? "").split("@");
  return { group: name, order: Number(order) || 0 };
}

/** "navigation" first, then the other groups by name (ungrouped last); by order inside a group. */
export function sortMenuItems<T extends { group: string; order: number }>(items: T[]): T[] {
  const rank = (group: string) => (group === "navigation" ? "" : group || "~");
  return [...items].sort((a, b) => rank(a.group).localeCompare(rank(b.group)) || a.order - b.order);
}

/** Submenu declarations of all extensions by id (a submenu's entries may come from any extension). */
export function submenusOf(sources: ContributionSource[]): Map<string, SubmenuContribution & { extensionId: string }> {
  const out = new Map<string, SubmenuContribution & { extensionId: string }>();
  for (const source of sources) {
    for (const submenu of list<SubmenuContribution>(source.manifest.contributes?.submenus)) {
      if (submenu && typeof submenu.id === "string" && !out.has(submenu.id)) out.set(submenu.id, { ...submenu, extensionId: source.id });
    }
  }
  return out;
}

/**
 * The entries of a menu (`view/title`, `editor/context`, a submenu id, …) whose
 * `when` clause holds. Entries with `submenu` become nested items (hidden when
 * nothing in the submenu is visible); entries with `command` become commands.
 */
export function resolveMenu(sources: ContributionSource[], menuId: string, when: (clause: string | undefined) => boolean, trail: string[] = []): ResolvedMenuItem[] {
  const submenus = submenusOf(sources);
  const out: ResolvedMenuItem[] = [];
  for (const source of sources) {
    const contributes = source.manifest.contributes ?? {};
    const commands = list<{ command: string; title?: Localized; icon?: unknown }>(contributes.commands);
    for (const entry of list<MenuEntry>((contributes.menus as Record<string, unknown> | undefined)?.[menuId])) {
      if (!entry || !when(entry.when)) continue;
      const { group, order } = splitGroup(entry.group);
      if (entry.submenu) {
        const submenu = submenus.get(entry.submenu);
        if (!submenu || submenu.id === menuId || trail.includes(submenu.id) || trail.length >= MAX_SUBMENU_DEPTH) continue;
        const items = resolveMenu(sources, submenu.id, when, [...trail, menuId]);
        if (!items.length) continue;
        const icon = typeof submenu.icon === "string" && submenu.icon.startsWith("$(") ? submenu.icon : undefined;
        out.push({ type: "submenu", id: submenu.id, title: text(submenu.label) || submenu.id, icon, group, order, extensionId: submenu.extensionId, items });
      } else if (entry.command) {
        const contribution = commands.find((command) => command.command === entry.command);
        const icon = contribution?.icon;
        out.push({
          type: "command",
          command: entry.command,
          title: text(contribution?.title) || entry.command,
          icon: typeof icon === "string" && icon.startsWith("$(") ? icon : source.commandIcons?.[entry.command],
          group,
          order,
          extensionId: source.id,
          alt: entry.alt,
        });
      }
    }
  }
  return sortMenuItems(out);
}

/** Flat list of the commands inside a resolved menu (submenus expanded depth-first). */
export function flattenMenu(items: ResolvedMenuItem[]): Extract<ResolvedMenuItem, { type: "command" }>[] {
  return items.flatMap((item) => (item.type === "command" ? [item] : flattenMenu(item.items)));
}

/** Every `submenu` id a menu entry references without a matching contributes.submenus declaration. */
export function undeclaredSubmenus(sources: ContributionSource[]): string[] {
  const declared = submenusOf(sources);
  const out = new Set<string>();
  for (const source of sources) {
    for (const entries of Object.values((source.manifest.contributes?.menus ?? {}) as Record<string, unknown>)) {
      for (const entry of list<MenuEntry>(entries)) if (entry?.submenu && !declared.has(entry.submenu)) out.add(entry.submenu);
    }
  }
  return [...out];
}

/* ── walkthroughs ────────────────────────────────────────────────────── */

export type WalkthroughMedia = {
  kind: "image" | "svg" | "markdown";
  /** Paths relative to the extension folder: one, or per theme kind. */
  path: string | { light?: string; dark?: string; hc?: string; hcLight?: string };
  alt?: string;
};

export type WalkthroughStep = {
  id: string;
  title: string;
  description: string;
  media?: WalkthroughMedia;
  completionEvents: string[];
  when?: string;
};

export type Walkthrough = {
  /** `publisher.name#id`, as `workbench.action.openWalkthrough` and `onWalkthrough:` spell it. */
  key: string;
  extensionId: string;
  id: string;
  title: string;
  description: string;
  /** File extensions / language ids it is featured for ("featuredFor"). */
  featuredFor: string[];
  when?: string;
  steps: WalkthroughStep[];
};

function mediaOf(raw: unknown): WalkthroughMedia | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const media = raw as Record<string, unknown>;
  const alt = typeof media.altText === "string" ? media.altText : undefined;
  for (const kind of ["image", "svg", "markdown"] as const) {
    const value = media[kind];
    if (typeof value === "string" && value) return { kind, path: value, alt };
    if (kind === "image" && value && typeof value === "object") return { kind, path: value as { light?: string; dark?: string }, alt };
  }
  return undefined;
}

/** Walkthroughs of the extensions whose `when` holds, in manifest order (steps filtered by their own `when`). */
export function parseWalkthroughs(sources: ContributionSource[], when: (clause: string | undefined) => boolean = () => true): Walkthrough[] {
  const out: Walkthrough[] = [];
  for (const source of sources) {
    for (const raw of list<Record<string, unknown>>(source.manifest.contributes?.walkthroughs)) {
      if (!raw || typeof raw.id !== "string" || !when(raw.when as string | undefined)) continue;
      const steps: WalkthroughStep[] = [];
      for (const step of list<Record<string, unknown>>(raw.steps)) {
        if (!step || typeof step.id !== "string" || !when(step.when as string | undefined)) continue;
        const events = list<string>(step.completionEvents).filter((event) => typeof event === "string");
        // The legacy `doneOn: { command }` is `onCommand:<command>`.
        const doneOn = step.doneOn as { command?: string } | undefined;
        if (doneOn?.command) events.push(`onCommand:${doneOn.command}`);
        steps.push({ id: step.id, title: text(step.title) || step.id, description: text(step.description), media: mediaOf(step.media), completionEvents: events, when: step.when as string | undefined });
      }
      out.push({
        key: `${source.id}#${raw.id}`,
        extensionId: source.id,
        id: raw.id,
        title: text(raw.title) || raw.id,
        description: text(raw.description),
        featuredFor: list<string>(raw.featuredFor).filter((entry) => typeof entry === "string"),
        when: raw.when as string | undefined,
        steps,
      });
    }
  }
  return out;
}

/** Finds a walkthrough by `publisher.name#id` (case-insensitive extension id). */
export function findWalkthrough(walkthroughs: Walkthrough[], key: string): Walkthrough | undefined {
  const lower = key.toLowerCase();
  return walkthroughs.find((walkthrough) => walkthrough.key.toLowerCase() === lower);
}

export type CompletionEvent =
  | { kind: "command"; arg: string }
  | { kind: "settingChanged"; arg: string }
  | { kind: "context"; arg: string }
  | { kind: "view"; arg: string }
  | { kind: "extensionInstalled"; arg: string }
  | { kind: "link"; arg: string }
  | { kind: "stepSelected" };

/** `onCommand:x`, `onSettingChanged:key`, `onContext:expr`, `onView:id`, `extensionInstalled:id`, `onLink:url`, `onStepSelected`. */
export function parseCompletionEvent(event: string): CompletionEvent | null {
  if (event === "onStepSelected" || event === "stepSelected") return { kind: "stepSelected" };
  const colon = event.indexOf(":");
  if (colon < 0) return null;
  const name = event.slice(0, colon);
  const arg = event.slice(colon + 1);
  if (!arg) return null;
  switch (name) {
    case "onCommand":
      return { kind: "command", arg };
    case "onSettingChanged":
      return { kind: "settingChanged", arg };
    case "onContext":
      return { kind: "context", arg };
    case "onView":
      return { kind: "view", arg };
    case "extensionInstalled":
      return { kind: "extensionInstalled", arg };
    case "onLink":
      return { kind: "link", arg };
    default:
      return null;
  }
}

/** Steps without completion events complete when they are selected. */
export function completesOnSelect(step: WalkthroughStep): boolean {
  const events = step.completionEvents.map(parseCompletionEvent).filter((event): event is CompletionEvent => !!event);
  return !step.completionEvents.length || events.some((event) => event.kind === "stepSelected");
}

/** `[label](command:id?%5B…args%5D)`: the command and its JSON arguments. */
export function parseCommandLink(href: string): { command: string; args: unknown[] } | null {
  const match = /^command:([^?#]+)(?:\?(.*))?$/.exec(href.trim());
  if (!match) return null;
  const command = decodeURIComponent(match[1]!);
  if (!match[2]) return { command, args: [] };
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(match[2]));
    return { command, args: Array.isArray(parsed) ? parsed : [parsed] };
  } catch {
    return { command, args: [] };
  }
}

/** Whether a walkthrough is featured for a file (by extension or language id). */
export function featuredFor(walkthrough: Walkthrough, fileName: string, languageId?: string): boolean {
  return walkthrough.featuredFor.some((entry) => entry === languageId || (entry.startsWith(".") && fileName.toLowerCase().endsWith(entry.toLowerCase())));
}

/* ── resource label formatters ───────────────────────────────────────── */

export type ResourceLabelFormatter = {
  scheme: string;
  authority?: string;
  formatting: {
    label: string;
    separator?: "/" | "\\" | "";
    tildify?: boolean;
    normalizeDriveLetter?: boolean;
    workspaceSuffix?: string;
    workspaceSuffixLong?: string;
    stripPathStartingSeparator?: boolean;
  };
};

export type ResourceParts = { scheme: string; authority: string; path: string };

/** Splits a resource key of the window (`scheme://authority/path`) into its parts; null for plain file paths. */
export function parseResourceKey(key: string): ResourceParts | null {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]+):(?:\/\/([^/?#]*))?([^?#]*)/.exec(key);
  if (!match || match[1] === "untitled") return null;
  let path = match[3] ?? "";
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep the raw path
  }
  return { scheme: match[1]!.toLowerCase(), authority: match[2] ?? "", path };
}

function authorityMatches(pattern: string | undefined, authority: string): boolean {
  if (!pattern) return true;
  if (pattern === "*") return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(authority);
}

/** The formatters contributed by the manifests (contributes.resourceLabelFormatters). */
export function labelFormattersOf(sources: ContributionSource[]): ResourceLabelFormatter[] {
  const out: ResourceLabelFormatter[] = [];
  for (const source of sources) {
    for (const entry of list<ResourceLabelFormatter>(source.manifest.contributes?.resourceLabelFormatters)) {
      if (entry && typeof entry.scheme === "string" && typeof entry.formatting?.label === "string") out.push(entry);
    }
  }
  return out;
}

/**
 * A human label for a non-file resource: the formatter for its scheme (and
 * authority; the latest registered, most specific one wins) fills `${path}`,
 * `${authority}` and `${authoritySuffix}`. `undefined` when no formatter applies.
 */
export function formatResourceLabel(formatters: ResourceLabelFormatter[], resource: ResourceParts, home?: string): string | undefined {
  let best: ResourceLabelFormatter | undefined;
  for (const formatter of formatters) {
    if (formatter.scheme.toLowerCase() !== resource.scheme || !authorityMatches(formatter.authority, resource.authority)) continue;
    // A formatter naming an authority beats a scheme-wide one; later registrations beat earlier ones.
    if (!best || !!formatter.authority || !best.authority) best = formatter;
  }
  if (!best) return undefined;
  const { formatting } = best;
  let path = resource.path;
  if (formatting.normalizeDriveLetter && /^\/[a-zA-Z]:/.test(path)) path = path.slice(1, 2).toUpperCase() + path.slice(2);
  if (formatting.stripPathStartingSeparator) path = path.replace(/^[/\\]+/, "");
  if (formatting.tildify && home && path.startsWith(home)) path = `~${path.slice(home.length)}`;
  if (formatting.separator && formatting.separator !== "/") path = path.replace(/\//g, formatting.separator);
  const authoritySuffix = resource.authority ? `@${resource.authority}` : "";
  return formatting.label
    .replace(/\$\{path\}/g, () => path)
    .replace(/\$\{authoritySuffix\}/g, () => authoritySuffix)
    .replace(/\$\{authority\}/g, () => resource.authority);
}

/** Host name of the placeholder links `replaceCommandLinks` leaves in the Markdown (the sanitizer keeps https links only). */
export const COMMAND_LINK_HOST = "https://lumen.invalid/command/";

/**
 * Replaces `[label](command:id?args)` links of a step description by placeholder
 * https links (`COMMAND_LINK_HOST + index`) and returns the command hrefs by index,
 * so the description can go through the Markdown sanitizer and still run commands.
 */
export function replaceCommandLinks(markdown: string): { markdown: string; links: string[] } {
  const links: string[] = [];
  const replaced = markdown.replace(/\[([^\]]*)\]\((command:[^)\s]*)(?:\s+"[^"]*")?\)/g, (_match, label: string, href: string) => {
    links.push(href);
    return `[${label}](${COMMAND_LINK_HOST}${links.length - 1})`;
  });
  return { markdown: replaced, links };
}
