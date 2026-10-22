/**
 * Pure logic of the "menus-walkthroughs" area, shared by the extension host and
 * the window: contributed menus with submenus (contributes.menus + submenus),
 * walkthroughs (contributes.walkthroughs) with their completion events, and
 * resource label formatters (contributes.resourceLabelFormatters). No DOM, no
 * Node: tests run it directly (test/features/menus-walkthroughs.test.ts).
 */

import { matchGlob } from "./glob.ts";

type Localized = string | { value?: string; original?: string } | undefined;

/** The slice of an extension these functions read. */
export type ContributionSource = {
  id: string;
  manifest: { contributes?: Record<string, unknown> };
  /** Data URLs of contributed commands' icon files by command (window only). */
  commandIcons?: Record<string, string>;
  /** Data URL of the extension's icon (window only; the default walkthrough icon). */
  iconUrl?: string;
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
export function resolveMenu(
  sources: ContributionSource[],
  menuId: string,
  when: (clause: string | undefined) => boolean,
  trail: string[] = [],
): ResolvedMenuItem[] {
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
  /** Relative path to the walkthrough's icon (defaults to the extension icon in the Welcome page). */
  icon?: string;
  /** Data URL of the extension's icon, when the walkthrough has no icon of its own. */
  iconUrl?: string;
  /** File extensions / glob patterns it is featured for ("featuredFor"), matched against workspace files. */
  featuredFor: string[];
  /** Set by the window when a `featuredFor` pattern matches a file of the workspace (VS Code ranks these first). */
  featured?: boolean;
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
    if (kind === "image" && value && typeof value === "object") {
      return { kind, path: value as { light?: string; dark?: string; hc?: string; hcLight?: string }, alt };
    }
  }
  return undefined;
}

/** A line holding nothing but a Markdown link: its label and href (VS Code renders it as a button). */
export function soleLink(line: string): { label: string; href: string } | null {
  const match = /^\s*\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)\s*$/.exec(line);
  return match ? { label: match[1] ?? "", href: match[2]! } : null;
}

/** The lines of a step description, with the ones that are a lone link shown as buttons. */
export function parseStepDescription(description: string): { text: string; button?: { label: string; href: string } }[] {
  return description
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => !!line.trim())
    .map((line) => {
      const link = soleLink(line);
      return link ? { text: line, button: link } : { text: line };
    });
}

/**
 * Completion events VS Code derives for a step without any: the command / link
 * of each button (a lone link of the description). Steps with no buttons then
 * complete when selected.
 */
export function defaultCompletionEvents(description: string): string[] {
  const out: string[] = [];
  for (const line of parseStepDescription(description)) {
    if (!line.button) continue;
    const link = parseCommandLink(line.button.href);
    if (link) out.push(`onCommand:${link.command}`);
    else if (/^https?:\/\//i.test(line.button.href)) out.push(`onLink:${line.button.href}`);
  }
  return out;
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
        // No events: the step's buttons, else its selection (VS Code's registerDoneListeners).
        const completionEvents = events.length ? events : defaultCompletionEvents(text(step.description));
        if (!completionEvents.length) completionEvents.push("onStepSelected");
        steps.push({
          id: step.id,
          title: text(step.title) || step.id,
          description: text(step.description),
          media: mediaOf(step.media),
          completionEvents,
          when: step.when as string | undefined,
        });
      }
      // A walkthrough without visible steps is not listed in VS Code either.
      if (!steps.length) continue;
      out.push({
        key: `${source.id}#${raw.id}`,
        extensionId: source.id,
        id: raw.id,
        title: text(raw.title) || raw.id,
        description: text(raw.description),
        icon: typeof raw.icon === "string" ? raw.icon : undefined,
        iconUrl: source.iconUrl,
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

/** `workbench.welcomePage.hiddenCategories` after hiding (`hidden: true`) or showing a walkthrough again. */
export function setWalkthroughHidden(categories: readonly string[] | undefined, key: string, hidden: boolean): string[] {
  const lower = key.toLowerCase();
  const current = categories ?? [];
  const already = current.some((category) => category.toLowerCase() === lower);
  if (already === hidden) return [...current];
  const out = current.filter((category) => category.toLowerCase() !== lower);
  if (hidden) out.push(key);
  return out;
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
      // `command:toSide:` links are `onCommand:` events in VS Code.
      return { kind: "command", arg: arg.replace(/^toSide:/, "") };
    case "onSettingChanged":
      return { kind: "settingChanged", arg };
    case "onContext":
      return { kind: "context", arg };
    case "onView":
      return { kind: "view", arg };
    case "extensionInstalled":
    case "onExtensionInstalled":
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

/** `[label](command:id?%5B…args%5D)`, also `command:toSide:`: the command, its JSON arguments and whether it opens besides. */
export function parseCommandLink(href: string): { command: string; args: unknown[]; toSide: boolean } | null {
  let rest = href.trim();
  if (!rest.startsWith("command:")) return null;
  rest = rest.slice("command:".length);
  const toSide = rest.startsWith("toSide:");
  if (toSide) rest = rest.slice("toSide:".length);
  const hash = rest.indexOf("#");
  if (hash >= 0) rest = rest.slice(0, hash);
  const question = rest.indexOf("?");
  const path = question < 0 ? rest : rest.slice(0, question);
  if (!path) return null;
  const command = decodeURIComponent(path);
  if (question < 0) return { command, args: [], toSide };
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(rest.slice(question + 1)));
    return { command, args: Array.isArray(parsed) ? parsed : [parsed], toSide };
  } catch {
    return { command, args: [], toSide };
  }
}

/** Whether a walkthrough is featured for a file of the workspace (its `featuredFor` glob patterns). */
export function featuredFor(walkthrough: Walkthrough, relativePath: string): boolean {
  const path = relativePath.replace(/\\/g, "/");
  return walkthrough.featuredFor.some((pattern) => matchGlob(pattern, path));
}

/** Marks the walkthroughs matching a workspace file and puts them first, as VS Code ranks featured categories. */
export function orderWalkthroughs(walkthroughs: Walkthrough[], isFeatured: (walkthrough: Walkthrough) => boolean): Walkthrough[] {
  return walkthroughs.map((walkthrough) => ({ ...walkthrough, featured: isFeatured(walkthrough) })).sort((a, b) => Number(!!b.featured) - Number(!!a.featured));
}

export type MediaThemeKind = "dark" | "light" | "hcDark" | "hcLight";

/**
 * The path of a media image for a theme kind: VS Code's `hc`, `hcLight`, `light`
 * and `dark` variants (a missing variant falls back to the other kind).
 */
export function mediaPathFor(media: WalkthroughMedia, kind: MediaThemeKind): string | undefined {
  if (typeof media.path === "string") return media.path;
  const { dark, light, hc, hcLight } = media.path;
  if (kind === "hcDark") return hc ?? dark ?? light ?? hcLight;
  if (kind === "hcLight") return hcLight ?? light ?? hc ?? dark;
  if (kind === "light") return light ?? hcLight ?? dark ?? hc;
  return dark ?? hc ?? light ?? hcLight;
}

/** The relative sources of the images in a Markdown document (`![alt](src)` and `<img src>`), in document order. */
export function markdownImageSources(markdown: string): string[] {
  const found: { index: number; source: string }[] = [];
  const markdownImages = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
  for (let match = markdownImages.exec(markdown); match; match = markdownImages.exec(markdown)) found.push({ index: match.index, source: match[1]! });
  const htmlImages = /<img\b[^>]*\bsrc="([^"]+)"/gi;
  for (let match = htmlImages.exec(markdown); match; match = htmlImages.exec(markdown)) found.push({ index: match.index, source: match[1]! });
  return [...new Set(found.sort((a, b) => a.index - b.index).map((entry) => entry.source))];
}

/** Rewrites the image sources of a Markdown document with `resolve` (relative extension media becomes data URLs). */
export function replaceMarkdownImages(markdown: string, resolve: (source: string) => string | undefined): string {
  return markdown
    .replace(/(!\[[^\]]*\]\(\s*<?)([^)\s>]+)(>?(?:\s+"[^"]*")?\s*\))/g, (match, before: string, source: string, after: string) => {
      const replacement = resolve(source);
      return replacement ? `${before}${replacement}${after}` : match;
    })
    .replace(/(<img\b[^>]*\bsrc=")([^"]+)(")/gi, (match, before: string, source: string, after: string) => {
      const replacement = resolve(source);
      return replacement ? `${before}${replacement}${after}` : match;
    });
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
  const match = /^(\w[\w+.-]+):(?:\/\/([^/?#]*))?([^?#]*)/.exec(key);
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
