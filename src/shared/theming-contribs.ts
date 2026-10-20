/**
 * contributes.colors, semanticTokenTypes, semanticTokenModifiers and
 * semanticTokenScopes: parsing of the manifest entries and the CSS they produce.
 * Pure functions, used by the window (mainview/features/theming-contribs.tsx,
 * mainview/lib/ext-semantic-tokens.ts) and by the tests.
 */

export type ThemeKind = "dark" | "light" | "hcDark" | "hcLight";

export type ColorContribution = {
  id: string;
  description: string;
  /** Per theme kind: a color value or the id of another color. */
  defaults: { dark?: string; light?: string; highContrast?: string; highContrastLight?: string };
};

export type SemanticTypeContribution = { id: string; superType?: string; description: string };
export type SemanticModifierContribution = { id: string; description: string };
export type SemanticScopeContribution = {
  /** Selector `type`, `type.modifier`, `*.modifier`, optionally `:language`. */
  selector: string;
  language?: string;
  scopes: string[];
};

export type SemanticContributions = {
  types: SemanticTypeContribution[];
  modifiers: SemanticModifierContribution[];
  scopes: SemanticScopeContribution[];
};

type ManifestLike = { manifest?: { contributes?: Record<string, unknown> } };

const COLOR_ID = /^[A-Za-z]\w*(\.[\w-]+)*$/;
const TOKEN_ID = /^[A-Za-z][\w-]*$/;
/** Plain color values only: nothing that could close a CSS declaration. */
const COLOR_VALUE = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,30}|(?:rgb|hsl)a?\([\d\s.,%/-]+\)|var\(--[\w-]+\))$/;

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value : "");

export const cssVariableOf = (id: string) => `--vscode-${id.replace(/\./g, "-")}`;

export function isColorValue(value: unknown): value is string {
  return typeof value === "string" && COLOR_VALUE.test(value.trim());
}

/** contributes.colors of all extensions (invalid entries are dropped, a later extension wins on the same id). */
export function collectColorContributions(extensions: ManifestLike[]): ColorContribution[] {
  const byId = new Map<string, ColorContribution>();
  for (const extension of extensions) {
    for (const entry of asArray(extension.manifest?.contributes?.colors)) {
      if (!isRecord(entry) || typeof entry.id !== "string" || !COLOR_ID.test(entry.id)) continue;
      const defaults = isRecord(entry.defaults) ? entry.defaults : {};
      const pick = (key: string) => (typeof defaults[key] === "string" ? (defaults[key] as string) : undefined);
      byId.set(entry.id, {
        id: entry.id,
        description: text(entry.description),
        defaults: { dark: pick("dark"), light: pick("light"), highContrast: pick("highContrast"), highContrastLight: pick("highContrastLight") },
      });
    }
  }
  return [...byId.values()];
}

/** The default of a color for a theme kind as a CSS value (`undefined` when it has none or it is not a usable value). */
export function defaultColorFor(color: ColorContribution, kind: ThemeKind): string | undefined {
  const { defaults } = color;
  const value = kind === "dark" ? defaults.dark : kind === "light" ? defaults.light : kind === "hcDark" ? defaults.highContrast : (defaults.highContrastLight ?? defaults.highContrast);
  // Without a high contrast value VS Code falls back to the plain dark / light one.
  const chosen = value ?? (kind === "light" || kind === "hcLight" ? defaults.light : defaults.dark);
  if (!chosen) return undefined;
  const trimmed = chosen.trim();
  // A reference to another color id (`editor.foreground`).
  if (trimmed.includes(".") && COLOR_ID.test(trimmed)) return `var(${cssVariableOf(trimmed)})`;
  return isColorValue(trimmed) ? trimmed : undefined;
}

/**
 * workbench.colorCustomizations for a theme: the top-level colors, then the
 * `"[Theme Name]"` sections that match the theme (by label or id) on top.
 */
export function colorCustomizationsFor(setting: unknown, theme: { id: string; label: string }): Record<string, string> {
  const result: Record<string, string> = {};
  if (!isRecord(setting)) return result;
  const take = (source: Record<string, unknown>) => {
    for (const [id, value] of Object.entries(source)) if (COLOR_ID.test(id) && isColorValue(value)) result[id] = value.trim();
  };
  take(setting);
  for (const [key, value] of Object.entries(setting)) {
    if (!isRecord(value)) continue;
    const match = /^\[(.+)\]$/.exec(key);
    if (match && (match[1] === theme.label || match[1] === theme.id)) take(value);
  }
  return result;
}

/**
 * CSS variables of the contributed colors and of colorCustomizations. A
 * contributed color the theme sets itself is left alone (the theme applies it);
 * customizations override everything.
 */
export function colorsCss(options: {
  colors: ColorContribution[];
  kind: ThemeKind;
  /** Colors the active theme defines. */
  themeColors: Record<string, string>;
  customizations: Record<string, string>;
}): string {
  const lines: string[] = [];
  for (const color of options.colors) {
    if (options.customizations[color.id] || options.themeColors[color.id]) continue;
    const value = defaultColorFor(color, options.kind);
    if (value) lines.push(`  ${cssVariableOf(color.id)}: ${value};`);
  }
  for (const [id, value] of Object.entries(options.customizations)) lines.push(`  ${cssVariableOf(id)}: ${value} !important;`);
  return lines.length ? `:root {\n${lines.join("\n")}\n}\n` : "";
}

/** `type.modifier1.modifier2:language` (type may be `*`). */
export function parseSemanticSelector(selector: string): { type: string; modifiers: string[]; language?: string } | null {
  const [head = "", language] = selector.split(":");
  const [type = "", ...modifiers] = head.split(".");
  if (type !== "*" && !TOKEN_ID.test(type)) return null;
  if (!modifiers.every((modifier) => TOKEN_ID.test(modifier))) return null;
  return { type, modifiers, language: language || undefined };
}

/** Types, modifiers and scope mappings of all extensions. */
export function collectSemanticContributions(extensions: ManifestLike[]): SemanticContributions {
  const types = new Map<string, SemanticTypeContribution>();
  const modifiers = new Map<string, SemanticModifierContribution>();
  const scopes: SemanticScopeContribution[] = [];
  for (const extension of extensions) {
    const contributes = extension.manifest?.contributes;
    for (const entry of asArray(contributes?.semanticTokenTypes)) {
      if (!isRecord(entry) || typeof entry.id !== "string" || !TOKEN_ID.test(entry.id)) continue;
      const superType = typeof entry.superType === "string" && TOKEN_ID.test(entry.superType) ? entry.superType : undefined;
      types.set(entry.id, { id: entry.id, superType, description: text(entry.description) });
    }
    for (const entry of asArray(contributes?.semanticTokenModifiers)) {
      if (!isRecord(entry) || typeof entry.id !== "string" || !TOKEN_ID.test(entry.id)) continue;
      modifiers.set(entry.id, { id: entry.id, description: text(entry.description) });
    }
    for (const entry of asArray(contributes?.semanticTokenScopes)) {
      if (!isRecord(entry) || !isRecord(entry.scopes)) continue;
      const language = typeof entry.language === "string" && entry.language ? entry.language : undefined;
      for (const [key, value] of Object.entries(entry.scopes)) {
        const list = asArray(value).filter((scope): scope is string => typeof scope === "string" && scope.length > 0);
        const selector = parseSemanticSelector(key);
        if (!selector || !list.length) continue;
        scopes.push({ selector: key, language: language ?? selector.language, scopes: list });
      }
    }
  }
  return { types: [...types.values()], modifiers: [...modifiers.values()], scopes };
}

/** A type followed by its super types (cycles cut), for the classes of a token. */
export function semanticTypeChain(type: string, parents: ReadonlyMap<string, string | undefined>): string[] {
  const chain: string[] = [];
  let next: string | undefined = type;
  while (next && !chain.includes(next)) {
    chain.push(next);
    next = parents.get(next);
  }
  return chain;
}

export const semanticLanguageClass = (language: string) => `cm-sem-lang-${language.replace(/[^\w-]/g, "_")}`;

/** CSS selector of a `type.modifiers:language` rule (null for an invalid one). */
export function semanticSelectorCss(selector: string, language?: string): string | null {
  const parsed = parseSemanticSelector(selector);
  if (!parsed) return null;
  const classes = [parsed.type === "*" ? "" : `.cm-sem-${parsed.type}`, ...parsed.modifiers.map((modifier) => `.cm-sem-mod-${modifier}`)].join("");
  const lang = language ?? parsed.language;
  const result = classes + (lang ? `.${semanticLanguageClass(lang)}` : "");
  return result || null;
}
