/**
 * File icon themes (contributes.iconThemes) and product icon themes
 * (contributes.productIconThemes): the normalized form the extension host
 * sends to the window, and the lookup of the icon of a file or folder.
 */

/** An icon of a file icon theme: an image (`path`, absolute on the host) or a glyph of one of the theme's fonts. */
export type IconDefinition = {
  path?: string;
  fontCharacter?: string;
  fontColor?: string;
  fontSize?: string;
  fontId?: string;
};

export type IconFontSource = { path: string; format?: string };
export type IconFont = { id: string; src: IconFontSource[]; weight?: string; style?: string; size?: string };

/** The associations of a theme (the theme itself, and its `light` / `highContrast` overrides). */
export type IconAssociations = {
  file?: string;
  folder?: string;
  folderExpanded?: string;
  rootFolder?: string;
  rootFolderExpanded?: string;
  folderNames?: Record<string, string>;
  folderNamesExpanded?: Record<string, string>;
  rootFolderNames?: Record<string, string>;
  rootFolderNamesExpanded?: Record<string, string>;
  fileExtensions?: Record<string, string>;
  fileNames?: Record<string, string>;
  languageIds?: Record<string, string>;
};

export type FileIconTheme = IconAssociations & {
  iconDefinitions: Record<string, IconDefinition>;
  fonts: IconFont[];
  light?: IconAssociations;
  highContrast?: IconAssociations;
  hidesExplorerArrows?: boolean;
};

/** A product icon theme: glyphs of its fonts replacing the codicons by id. */
export type ProductIconTheme = {
  fonts: IconFont[];
  /** codicon id (`"chevron-down"`) → glyph. */
  icons: Record<string, { fontCharacter: string; fontId?: string }>;
};

export type ContributedIconTheme = {
  /** `id` of the contribution (falls back to the label). */
  id: string;
  label: string;
  extensionId: string;
  /** The extension's folder. */
  location: string;
  /** Absolute path of the theme file. */
  path: string;
  kind: "file" | "product";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringMap(value: unknown, lowercaseKeys: boolean): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, id] of Object.entries(value)) if (typeof id === "string") result[lowercaseKeys ? key.toLowerCase() : key] = id;
  return result;
}

function associationsOf(value: unknown): IconAssociations {
  if (!isRecord(value)) return {};
  const string = (key: string) => (typeof value[key] === "string" ? (value[key] as string) : undefined);
  return {
    file: string("file"),
    folder: string("folder"),
    folderExpanded: string("folderExpanded"),
    rootFolder: string("rootFolder"),
    rootFolderExpanded: string("rootFolderExpanded"),
    folderNames: stringMap(value.folderNames, true),
    folderNamesExpanded: stringMap(value.folderNamesExpanded, true),
    rootFolderNames: stringMap(value.rootFolderNames, true),
    rootFolderNamesExpanded: stringMap(value.rootFolderNamesExpanded, true),
    fileExtensions: stringMap(value.fileExtensions, true),
    fileNames: stringMap(value.fileNames, true),
    languageIds: stringMap(value.languageIds, false),
  };
}

function fontsOf(value: unknown, resolvePath: (relative: string) => string | undefined): IconFont[] {
  if (!Array.isArray(value)) return [];
  const fonts: IconFont[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.id !== "string" || !Array.isArray(raw.src)) continue;
    const src: IconFontSource[] = [];
    for (const source of raw.src) {
      if (!isRecord(source) || typeof source.path !== "string") continue;
      const path = resolvePath(source.path);
      if (path) src.push({ path, format: typeof source.format === "string" ? source.format : undefined });
    }
    if (!src.length) continue;
    fonts.push({
      id: raw.id,
      src,
      weight: typeof raw.weight === "string" ? raw.weight : undefined,
      style: typeof raw.style === "string" ? raw.style : undefined,
      size: typeof raw.size === "string" ? raw.size : undefined,
    });
  }
  return fonts;
}

/**
 * Normalize a parsed file icon theme JSON. `resolvePath` turns a path inside
 * the theme file into an absolute one (`undefined` rejects it, e.g. outside the extension).
 */
export function normalizeFileIconTheme(raw: unknown, resolvePath: (relative: string) => string | undefined): FileIconTheme {
  if (!isRecord(raw)) throw new Error("not an icon theme");
  const iconDefinitions: Record<string, IconDefinition> = {};
  if (isRecord(raw.iconDefinitions)) {
    for (const [id, value] of Object.entries(raw.iconDefinitions)) {
      if (!isRecord(value)) continue;
      const definition: IconDefinition = {};
      if (typeof value.iconPath === "string") definition.path = resolvePath(value.iconPath);
      if (typeof value.fontCharacter === "string") definition.fontCharacter = value.fontCharacter;
      if (typeof value.fontColor === "string") definition.fontColor = value.fontColor;
      if (typeof value.fontSize === "string") definition.fontSize = value.fontSize;
      if (typeof value.fontId === "string") definition.fontId = value.fontId;
      if (definition.path || definition.fontCharacter) iconDefinitions[id] = definition;
    }
  }
  return {
    ...associationsOf(raw),
    iconDefinitions,
    fonts: fontsOf(raw.fonts, resolvePath),
    light: isRecord(raw.light) ? associationsOf(raw.light) : undefined,
    highContrast: isRecord(raw.highContrast) ? associationsOf(raw.highContrast) : undefined,
    hidesExplorerArrows: raw.hidesExplorerArrows === true,
  };
}

/** Normalize a parsed product icon theme JSON (`iconDefinitions` keyed by codicon id). */
export function normalizeProductIconTheme(raw: unknown, resolvePath: (relative: string) => string | undefined): ProductIconTheme {
  if (!isRecord(raw)) throw new Error("not an icon theme");
  const icons: ProductIconTheme["icons"] = {};
  if (isRecord(raw.iconDefinitions)) {
    for (const [id, value] of Object.entries(raw.iconDefinitions)) {
      if (!isRecord(value) || typeof value.fontCharacter !== "string") continue;
      icons[id] = { fontCharacter: value.fontCharacter, fontId: typeof value.fontId === "string" ? value.fontId : undefined };
    }
  }
  return { fonts: fontsOf(raw.fonts, resolvePath), icons };
}

/** A theme's `fontCharacter` (`"\\E001"` written in JSON, or the character itself) as the string to render. */
export function fontCharacterOf(value: string): string {
  const match = /^\\([0-9a-f]{1,6})$/i.exec(value);
  return match ? String.fromCodePoint(parseInt(match[1]!, 16)) : value;
}

/* ── contributes.icons ──────────────────────────────────────────────────── */

/** An icon an extension defines (contributes.icons): a glyph of one of its fonts, or another icon id. */
export type ContributedIcon = { extensionId: string; fontPath: string; fontCharacter: string } | { extensionId: string; alias: string };

/**
 * The `contributes.icons` of the extensions by icon id. `fontPath` is resolved
 * against the extension folder (the host checks it stays inside); the first
 * extension that defines an id keeps it, as in VS Code.
 */
export function contributedIcons(extensions: readonly { id: string; location: string; manifest: { contributes?: unknown } }[]): Map<string, ContributedIcon> {
  const icons = new Map<string, ContributedIcon>();
  for (const extension of extensions) {
    const declared = isRecord(extension.manifest.contributes) ? extension.manifest.contributes.icons : undefined;
    if (!isRecord(declared)) continue;
    const separator = extension.location.includes("\\") ? "\\" : "/";
    for (const [id, value] of Object.entries(declared)) {
      if (icons.has(id) || !/^[\w-]+$/.test(id) || !isRecord(value)) continue;
      const fallback = value.default;
      if (typeof fallback === "string") {
        icons.set(id, { extensionId: extension.id, alias: fallback });
      } else if (isRecord(fallback) && typeof fallback.fontPath === "string" && typeof fallback.fontCharacter === "string") {
        const fontPath = `${extension.location.replace(/[\\/]+$/, "")}${separator}${fallback.fontPath.replace(/^\.?[\\/]+/, "").replace(/[\\/]/g, separator)}`;
        icons.set(id, { extensionId: extension.id, fontPath, fontCharacter: fallback.fontCharacter });
      }
    }
  }
  return icons;
}

/**
 * Follow a contributed icon's aliases to a font glyph, or to the id of an icon that is
 * not contributed (a built-in codicon). `undefined` when `id` is not contributed.
 */
export function resolveContributedIcon(
  id: string,
  icons: Map<string, ContributedIcon>,
): { extensionId: string; fontPath: string; fontCharacter: string } | { codicon: string } | undefined {
  let current = id;
  for (let depth = 0; depth < 10; depth++) {
    const icon = icons.get(current);
    if (!icon) return current === id ? undefined : { codicon: current };
    if (!("alias" in icon)) return icon;
    current = icon.alias;
  }
  return undefined;
}

export type IconTarget = { kind: "file"; name: string; languageId?: string } | { kind: "folder"; name: string; expanded: boolean; root?: boolean };

function lookup(associations: IconAssociations | undefined, target: IconTarget): string | undefined {
  if (!associations) return undefined;
  const lower = target.name.toLowerCase();
  if (target.kind === "folder") {
    const names = target.root
      ? target.expanded
        ? associations.rootFolderNamesExpanded
        : associations.rootFolderNames
      : target.expanded
        ? associations.folderNamesExpanded
        : associations.folderNames;
    const byName = names?.[lower];
    if (byName) return byName;
    return undefined;
  }
  const byName = associations.fileNames?.[lower];
  if (byName) return byName;
  // "a.b.c": the extension "b.c" wins over "c".
  for (let dot = lower.indexOf("."); dot >= 0; dot = lower.indexOf(".", dot + 1)) {
    const byExtension = associations.fileExtensions?.[lower.slice(dot + 1)];
    if (byExtension) return byExtension;
  }
  if (target.languageId) {
    const byLanguage = associations.languageIds?.[target.languageId];
    if (byLanguage) return byLanguage;
  }
  return undefined;
}

function defaultIcon(associations: IconAssociations | undefined, target: IconTarget): string | undefined {
  if (!associations) return undefined;
  if (target.kind === "file") return associations.file;
  if (target.root)
    return (
      (target.expanded ? associations.rootFolderExpanded : associations.rootFolder) ?? (target.expanded ? associations.folderExpanded : associations.folder)
    );
  return target.expanded ? associations.folderExpanded : associations.folder;
}

/**
 * The icon definition id of a file or folder, like VS Code: the theme's
 * `light` (light color themes) / `highContrast` section is looked at first,
 * for the specific associations as well as for the defaults.
 */
export function iconIdFor(theme: FileIconTheme, target: IconTarget, scheme: "dark" | "light" | "highContrast" = "dark"): string | undefined {
  const override = scheme === "light" ? theme.light : scheme === "highContrast" ? theme.highContrast : undefined;
  return lookup(override, target) ?? lookup(theme, target) ?? defaultIcon(override, target) ?? defaultIcon(theme, target);
}

export const ICON_MIME_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};
