import { Tag, tags, type Highlighter } from "@lezer/highlight";
import {
  cssVariable,
  DEFAULT_LIGHT_THEME_ID,
  DEFAULT_THEME_ID,
  isLightKind,
  resolveThemeColors,
  themeBodyClass,
  compileTokenRules,
  matchTokenStyle,
  type ColorThemeData,
  type ColorThemeKind,
  type CompiledTokenRule,
  type TokenColorRule,
  type TokenStyle,
} from "../../shared/color-theme";
import { api } from "./rpc";
import { getSettings, onSettingsChange } from "./settings";

/**
 * The active color theme: workbench colors as `--vscode-*` CSS variables on
 * the document (Lumen's own variables are defined from them in index.css),
 * TextMate token colors for the editor (a Highlighter over the theme's
 * tokenColors) and the semantic token colors.
 */

/* ── default token colors (themes without tokenColors, and Lumen's own) ─── */

const rule = (scope: string, foreground?: string, fontStyle?: string): TokenColorRule => ({ scope, settings: { foreground, fontStyle } });

/** Lumen's dark syntax colors (VS Code's Dark+). */
const DARK_TOKEN_COLORS: TokenColorRule[] = [
  rule("comment", "#6a9955", "italic"),
  rule("string", "#ce9178"),
  rule("string.regexp", "#d16969"),
  rule("constant.character.escape", "#d7ba7d"),
  rule("constant.numeric", "#b5cea8"),
  rule("constant.language", "#569cd6"),
  rule("constant.other.color", "#ce9178"),
  rule("keyword", "#569cd6"),
  rule("keyword.control", "#c586c0"),
  rule("keyword.operator", "#d4d4d4"),
  rule("keyword.other.unit", "#b5cea8"),
  rule("storage", "#569cd6"),
  rule("storage.type", "#569cd6"),
  rule("storage.modifier", "#569cd6"),
  rule("variable.language", "#569cd6"),
  rule("variable", "#9cdcfe"),
  rule("variable.other.constant", "#9cdcfe"),
  rule("variable.other.enummember", "#4fc1ff"),
  rule("meta.object-literal.key", "#9cdcfe"),
  rule("support.variable", "#9cdcfe"),
  rule("entity.name.function", "#dcdcaa"),
  rule("support.function", "#dcdcaa"),
  rule("entity.name.type", "#4ec9b0"),
  rule("entity.name.class", "#4ec9b0"),
  rule("entity.name.namespace", "#4ec9b0"),
  rule("support.type", "#4ec9b0"),
  rule("support.class", "#4ec9b0"),
  rule("entity.name.tag", "#569cd6"),
  rule("entity.other.attribute-name", "#9cdcfe"),
  rule("markup.heading", "#d4d4d4", "bold"),
  rule("markup.bold", undefined, "bold"),
  rule("markup.italic", undefined, "italic"),
  rule("markup.strikethrough", undefined, "strikethrough"),
  rule("markup.underline.link", "#3794ff", "underline"),
  rule("markup.inline.raw", "#ce9178"),
  rule("markup.inserted", "#b5cea8"),
  rule("markup.deleted", "#ce9178"),
  rule("markup.changed", "#569cd6"),
  rule("invalid", "#f44747"),
];

/** VS Code's Light+. */
const LIGHT_TOKEN_COLORS: TokenColorRule[] = [
  rule("comment", "#008000", "italic"),
  rule("string", "#a31515"),
  rule("string.regexp", "#811f3f"),
  rule("constant.character.escape", "#ee0000"),
  rule("constant.numeric", "#098658"),
  rule("constant.language", "#0000ff"),
  rule("constant.other.color", "#0451a5"),
  rule("keyword", "#0000ff"),
  rule("keyword.control", "#af00db"),
  rule("keyword.operator", "#000000"),
  rule("keyword.other.unit", "#098658"),
  rule("storage", "#0000ff"),
  rule("storage.type", "#0000ff"),
  rule("storage.modifier", "#0000ff"),
  rule("variable.language", "#0000ff"),
  rule("variable", "#001080"),
  rule("variable.other.constant", "#0070c1"),
  rule("variable.other.enummember", "#0070c1"),
  rule("meta.object-literal.key", "#001080"),
  rule("support.variable", "#001080"),
  rule("entity.name.function", "#795e26"),
  rule("support.function", "#795e26"),
  rule("entity.name.type", "#267f99"),
  rule("entity.name.class", "#267f99"),
  rule("entity.name.namespace", "#267f99"),
  rule("support.type", "#267f99"),
  rule("support.class", "#267f99"),
  rule("entity.name.tag", "#800000"),
  rule("entity.other.attribute-name", "#e50000"),
  rule("markup.heading", "#800000", "bold"),
  rule("markup.bold", undefined, "bold"),
  rule("markup.italic", undefined, "italic"),
  rule("markup.strikethrough", undefined, "strikethrough"),
  rule("markup.underline.link", "#0000ff", "underline"),
  rule("markup.inline.raw", "#800000"),
  rule("markup.inserted", "#098658"),
  rule("markup.deleted", "#a31515"),
  rule("markup.changed", "#0451a5"),
  rule("invalid", "#cd3131"),
];

export const BUILT_IN_THEMES: ColorThemeData[] = [
  { id: DEFAULT_THEME_ID, label: DEFAULT_THEME_ID, kind: "dark", colors: {}, tokenColors: DARK_TOKEN_COLORS, semanticHighlighting: true },
  { id: DEFAULT_LIGHT_THEME_ID, label: DEFAULT_LIGHT_THEME_ID, kind: "light", colors: {}, tokenColors: LIGHT_TOKEN_COLORS, semanticHighlighting: true },
];

/* ── editor highlighting ──────────────────────────────────────────────── */

/** Lezer highlight tags → the TextMate scope VS Code gives the same kind of token. */
const TAG_SCOPES = new Map<Tag, string>([
  [tags.comment, "comment"],
  [tags.docComment, "comment.block.documentation"],
  [tags.string, "string"],
  [tags.special(tags.string), "string.regexp"],
  [tags.regexp, "string.regexp"],
  [tags.escape, "constant.character.escape"],
  [tags.character, "constant.character"],
  [tags.number, "constant.numeric"],
  [tags.bool, "constant.language.boolean"],
  [tags.null, "constant.language.null"],
  [tags.atom, "constant.language"],
  [tags.color, "constant.other.color"],
  [tags.unit, "keyword.other.unit"],
  [tags.keyword, "keyword"],
  [tags.controlKeyword, "keyword.control"],
  [tags.moduleKeyword, "keyword.control.import"],
  [tags.operatorKeyword, "keyword.operator.expression"],
  [tags.definitionKeyword, "storage.type"],
  [tags.modifier, "storage.modifier"],
  [tags.self, "variable.language.this"],
  [tags.operator, "keyword.operator"],
  [tags.punctuation, "punctuation"],
  [tags.variableName, "variable.other.readwrite"],
  [tags.special(tags.variableName), "variable.language"],
  [tags.standard(tags.variableName), "support.variable"],
  [tags.constant(tags.variableName), "variable.other.constant"],
  [tags.function(tags.variableName), "entity.name.function"],
  [tags.function(tags.propertyName), "entity.name.function.member"],
  [tags.propertyName, "variable.other.property"],
  [tags.labelName, "entity.name.label"],
  [tags.typeName, "entity.name.type"],
  [tags.className, "entity.name.type.class"],
  [tags.namespace, "entity.name.namespace"],
  [tags.macroName, "entity.name.function.preprocessor"],
  [tags.tagName, "entity.name.tag"],
  [tags.attributeName, "entity.other.attribute-name"],
  [tags.attributeValue, "string.quoted"],
  [tags.heading, "markup.heading"],
  [tags.strong, "markup.bold"],
  [tags.emphasis, "markup.italic"],
  [tags.strikethrough, "markup.strikethrough"],
  [tags.link, "markup.underline.link"],
  [tags.url, "markup.underline.link"],
  [tags.monospace, "markup.inline.raw"],
  [tags.quote, "markup.quote"],
  [tags.inserted, "markup.inserted"],
  [tags.deleted, "markup.deleted"],
  [tags.changed, "markup.changed"],
  [tags.processingInstruction, "meta.preprocessor"],
  [tags.invalid, "invalid"],
]);

/** Tags of TextMate grammar tokens, with the full scopes of the token. */
const textMateScopes = new Map<Tag, readonly string[]>();
const textMateTags = new Map<string, Tag>();
const textMateNames = new Map<string, string>();

/** The parent tag a TextMate token falls back to: a stream token name such as `variableName.function`. */
function tagOfStyle(style: string | null): Tag | undefined {
  if (!style) return undefined;
  const [base, ...modifiers] = style.split(".");
  let tag = (tags as unknown as Record<string, Tag | undefined>)[base!];
  for (const modifier of modifiers) {
    const modify = (tags as unknown as Record<string, ((tag: Tag) => Tag) | undefined>)[modifier];
    if (tag && typeof modify === "function") tag = modify(tag);
  }
  return tag instanceof Tag ? tag : undefined;
}

/**
 * The stream token name for a TextMate token: one name (and tag) per scope
 * list, so the theme can color it by its full scopes.
 */
export function textMateTokenName(scopes: readonly string[], fallback: string | null): string {
  const key = scopes.join(" ");
  let name = textMateNames.get(key);
  if (!name) {
    name = `tm${textMateNames.size}`;
    textMateNames.set(key, name);
    const tag = Tag.define(tagOfStyle(fallback));
    textMateTags.set(name, tag);
    textMateScopes.set(tag, [...scopes]);
  }
  return name;
}

/** StreamLanguage tokenTable for textMateTokenName's names. */
export const textMateTokenTable: Record<string, Tag> = new Proxy({} as Record<string, Tag>, {
  get: (_target, name) => (typeof name === "string" ? textMateTags.get(name) : undefined),
});

function scopesOfTag(tag: Tag): readonly string[] | null {
  const own = textMateScopes.get(tag);
  if (own) return own;
  for (const candidate of tag.set) {
    const scope = TAG_SCOPES.get(candidate);
    if (scope) return [scope];
  }
  return null;
}

/* ── the active theme ─────────────────────────────────────────────────── */

type ActiveTheme = { data: ColorThemeData; colors: Record<string, string>; rules: CompiledTokenRule[]; highlighter: Highlighter };

let active: ActiveTheme;
const listeners = new Set<() => void>();
const appliedVariables = new Set<string>();

function styleSheet(id: string): HTMLStyleElement {
  let element = document.getElementById(id) as HTMLStyleElement | null;
  if (!element) {
    element = document.createElement("style");
    element.id = id;
    document.head.appendChild(element);
  }
  return element;
}

function declarations(style: TokenStyle, important = false): string {
  const flag = important ? " !important" : "";
  const parts: string[] = [];
  if (style.foreground) parts.push(`color: ${style.foreground}${flag}`);
  if (style.fontStyle !== undefined) {
    const words = style.fontStyle.split(/\s+/);
    parts.push(`font-style: ${words.includes("italic") ? "italic" : "normal"}${flag}`);
    parts.push(`font-weight: ${words.includes("bold") ? "bold" : "normal"}${flag}`);
    const lines = [words.includes("underline") ? "underline" : "", words.includes("strikethrough") ? "line-through" : ""].filter(Boolean);
    parts.push(`text-decoration: ${lines.length ? lines.join(" ") : "none"}${flag}`);
  }
  return parts.join("; ");
}

const tagKeys = new WeakMap<Tag, number>();
let nextTagKey = 0;
const tagKey = (tag: Tag) => {
  let key = tagKeys.get(tag);
  if (key === undefined) tagKeys.set(tag, (key = nextTagKey++));
  return key;
};

/** A Highlighter giving each token the class of its theme style (classes per distinct style). */
function createHighlighter(rules: CompiledTokenRule[], generation: number): Highlighter {
  const classes = new Map<string, string>();
  const byTags = new Map<string, string | null>();
  const sheet = styleSheet("lumen-token-colors");
  sheet.textContent = "";
  const classFor = (style: TokenStyle): string | null => {
    const css = declarations(style);
    if (!css) return null;
    let name = classes.get(css);
    if (!name) {
      name = `tm-${generation}-${classes.size}`;
      classes.set(css, name);
      sheet.textContent += `.${name} { ${css} }\n`;
    }
    return name;
  };
  return {
    style(tagList) {
      const key = tagList.map(tagKey).join(",");
      if (byTags.has(key)) return byTags.get(key)!;
      const result: string[] = [];
      for (const tag of tagList) {
        const scopes = scopesOfTag(tag);
        const name = scopes ? classFor(matchTokenStyle(rules, scopes)) : null;
        if (name) result.push(name);
      }
      const value = result.length ? result.join(" ") : null;
      byTags.set(key, value);
      return value;
    },
  };
}

/** VS Code's default scopes of semantic token types (used when the theme has no rule for a type). */
const SEMANTIC_SCOPES: Record<string, string> = {
  namespace: "entity.name.namespace",
  class: "entity.name.type.class",
  enum: "entity.name.type.enum",
  interface: "entity.name.type.interface",
  struct: "entity.name.type.struct",
  typeParameter: "entity.name.type.parameter",
  type: "entity.name.type",
  parameter: "variable.parameter",
  variable: "variable.other.readwrite",
  property: "variable.other.property",
  enumMember: "variable.other.enummember",
  event: "variable.other.event",
  function: "entity.name.function",
  method: "entity.name.function.member",
  macro: "entity.name.function.preprocessor",
  label: "entity.name.label",
  keyword: "keyword",
  comment: "comment",
  string: "string",
  number: "constant.numeric",
  regexp: "string.regexp",
  operator: "keyword.operator",
  decorator: "entity.name.function.decorator",
};

/** Semantic token colors: the theme's semanticTokenColors, else the scopes of each type (when the theme enables them). */
function semanticCss(theme: ColorThemeData, rules: CompiledTokenRule[]): string {
  if (!theme.semanticHighlighting) return "";
  const css: string[] = [];
  for (const [type, scope] of Object.entries(SEMANTIC_SCOPES)) {
    const body = declarations(matchTokenStyle(rules, [scope]), true);
    if (body) css.push(`.cm-sem-${type} { ${body} }`);
  }
  // Theme rules: "type", "type.modifier", "*.modifier" (a language suffix ":lang" applies everywhere).
  const entries = Object.entries(theme.semanticTokenColors ?? {}).sort((a, b) => a[0].split(".").length - b[0].split(".").length);
  for (const [selector, value] of entries) {
    const [type = "*", ...modifiers] = selector.split(":")[0]!.split(".");
    const style: TokenStyle =
      typeof value === "string"
        ? { foreground: value }
        : {
            foreground: value.foreground,
            fontStyle:
              value.fontStyle ??
              (value.bold || value.italic || value.underline || value.strikethrough
                ? [value.bold && "bold", value.italic && "italic", value.underline && "underline", value.strikethrough && "strikethrough"].filter(Boolean).join(" ")
                : undefined),
          };
    const body = declarations(style, true);
    const classes = [type === "*" ? "" : `.cm-sem-${type}`, ...modifiers.map((modifier) => `.cm-sem-mod-${modifier}`)].join("");
    if (body && classes) css.push(`${classes} { ${body} }`);
  }
  return css.join("\n");
}

let generation = 0;

/** Make a theme the active one: CSS variables, token and semantic colors; listeners repaint. */
export function applyColorTheme(theme: ColorThemeData): void {
  const data = theme.tokenColors.length ? theme : { ...theme, tokenColors: isLightKind(theme.kind) ? LIGHT_TOKEN_COLORS : DARK_TOKEN_COLORS };
  const colors = resolveThemeColors(data.kind, data.colors);
  // The editor's default text color can also come from a .tmTheme's global rule.
  const global = data.tokenColors.find((entry) => entry.scope === undefined)?.settings;
  if (global?.foreground && !data.colors["editor.foreground"]) colors["editor.foreground"] = global.foreground;
  if (global?.background && !data.colors["editor.background"]) colors["editor.background"] = global.background;

  const root = document.documentElement;
  for (const name of appliedVariables) root.style.removeProperty(name);
  appliedVariables.clear();
  for (const [id, value] of Object.entries(colors)) {
    const name = cssVariable(id);
    root.style.setProperty(name, value);
    appliedVariables.add(name);
  }
  root.style.colorScheme = isLightKind(data.kind) ? "light" : "dark";
  root.dataset.themeKind = data.kind;
  for (const kind of ["dark", "light", "hcDark", "hcLight"] as ColorThemeKind[]) root.classList.toggle(themeBodyClass(kind), kind === data.kind);

  const rules = compileTokenRules(data.tokenColors);
  generation++;
  active = { data, colors, rules, highlighter: createHighlighter(rules, generation) };
  styleSheet("lumen-semantic-colors").textContent = semanticCss(data, rules);
  for (const listener of listeners) listener();
}

export function activeColorTheme(): ColorThemeData {
  return active.data;
}

export function isDarkTheme(): boolean {
  return !isLightKind(active.data.kind);
}

/** A resolved workbench color of the active theme (`editor.background`, …). */
export function themeColor(id: string): string | undefined {
  return active.colors[id];
}

export function themeHighlighter(): Highlighter {
  return active.highlighter;
}

/** Every workbench color of the active theme as CSS variables (for webviews). */
export function themeVariables(): Record<string, string> {
  return Object.fromEntries(Object.entries(active.colors).map(([id, value]) => [cssVariable(id), value]));
}

/** A CSS value following the active theme's color (`var(--vscode-…)`), with a fallback for ids no theme defines. */
export function themeColorReference(id: string, fallback?: string): string {
  return fallback ? `var(${cssVariable(id)}, ${fallback})` : `var(${cssVariable(id)})`;
}

export function onColorThemeChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/* ── choosing a theme ─────────────────────────────────────────────────── */

export type ColorThemeEntry = { id: string; label: string; kind: ColorThemeKind; extensionId?: string };

const loaded = new Map<string, Promise<ColorThemeData | null>>();

/** Lumen's themes and the ones the enabled extensions contribute. */
export async function listColorThemes(): Promise<ColorThemeEntry[]> {
  const builtIn = BUILT_IN_THEMES.map(({ id, label, kind }) => ({ id, label, kind }));
  try {
    const { themes } = await api().request.extensionThemes({});
    return [...builtIn, ...themes.map(({ id, label, kind, extensionId }) => ({ id, label, kind, extensionId }))];
  } catch {
    return builtIn;
  }
}

/** A theme by id or label (contributed themes are loaded once). */
export function loadColorTheme(id: string): Promise<ColorThemeData | null> {
  const builtIn = BUILT_IN_THEMES.find((theme) => theme.id === id || theme.label === id);
  if (builtIn) return Promise.resolve(builtIn);
  let pending = loaded.get(id);
  if (!pending) {
    pending = api()
      .request.extensionColorTheme({ id })
      .then(({ theme, error }) => {
        if (!theme) console.warn(`[theme] ${error ?? `cannot load '${id}'`}`);
        return theme;
      })
      .catch((error: unknown) => {
        console.warn(`[theme] cannot load '${id}'`, error);
        return null;
      });
    pending.then((theme) => theme ?? loaded.delete(id));
    loaded.set(id, pending);
  }
  return pending;
}

let applying = 0;

/** Show a theme (also used to preview one in the picker); unknown ids fall back to Lumen Dark. */
export async function showColorTheme(id: string): Promise<boolean> {
  const token = ++applying;
  const theme = await loadColorTheme(id);
  if (token !== applying) return !!theme;
  applyColorTheme(theme ?? BUILT_IN_THEMES[0]!);
  return !!theme;
}

/** Apply workbench.colorTheme (again: extensions changed and may have brought or taken the theme). */
export function reloadConfiguredColorTheme(forget = false): Promise<boolean> {
  if (forget) loaded.clear();
  return showColorTheme(getSettings()["workbench.colorTheme"] || DEFAULT_THEME_ID);
}

applyColorTheme(BUILT_IN_THEMES[0]!);

let configured = getSettings()["workbench.colorTheme"];
onSettingsChange(() => {
  const next = getSettings()["workbench.colorTheme"];
  if (next === configured) return;
  configured = next;
  void reloadConfiguredColorTheme();
});
