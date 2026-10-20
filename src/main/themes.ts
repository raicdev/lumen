import { readFile } from "fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "path";
import vscodeTextmate from "vscode-textmate";
import { kindOfUiTheme, type ColorThemeData, type ExtensionColorTheme, type SemanticTokenStyle, type TokenColorRule } from "../shared/color-theme.ts";
import type { ExtensionDescription } from "../shared/extensions.ts";
import { parseJsonc } from "../shared/jsonc.ts";

/**
 * Color themes of the enabled extensions (contributes.themes), loaded the way
 * VS Code does: a JSON theme may `include` another one, take its tokenColors
 * from a .tmTheme / .json file, and a .tmTheme's global settings become
 * workbench colors.
 */

function insideFolder(folder: string, file: string): boolean {
  const path = relative(resolve(folder), resolve(file));
  return !!path && !path.startsWith("..") && !isAbsolute(path);
}

export function contributedThemes(extensions: ExtensionDescription[]): ExtensionColorTheme[] {
  const themes: ExtensionColorTheme[] = [];
  for (const extension of extensions) {
    const contributions = extension.manifest.contributes?.themes;
    if (!Array.isArray(contributions)) continue;
    for (const raw of contributions as { id?: unknown; label?: unknown; uiTheme?: unknown; path?: unknown }[]) {
      if (!raw || typeof raw !== "object" || typeof raw.path !== "string") continue;
      const path = resolve(extension.location, raw.path);
      if (!insideFolder(extension.location, path)) continue;
      const label = typeof raw.label === "string" && raw.label ? raw.label : typeof raw.id === "string" ? raw.id : raw.path;
      themes.push({ id: typeof raw.id === "string" && raw.id ? raw.id : label, label, kind: kindOfUiTheme(raw.uiTheme), extensionId: extension.id, path });
    }
  }
  return themes;
}

/** .tmTheme global settings → workbench colors (like VS Code's convertSettings). */
const TM_THEME_COLORS: Record<string, string> = {
  background: "editor.background",
  foreground: "editor.foreground",
  caret: "editorCursor.foreground",
  selection: "editor.selectionBackground",
  inactiveSelection: "editor.inactiveSelectionBackground",
  lineHighlight: "editor.lineHighlightBackground",
  invisibles: "editorWhitespace.foreground",
  guide: "editorIndentGuide.background",
  activeGuide: "editorIndentGuide.activeBackground",
  findHighlight: "editor.findMatchHighlightBackground",
  selectionHighlight: "editor.selectionHighlightBackground",
  gutterForeground: "editorLineNumber.foreground",
};

type Loaded = { colors: Record<string, string>; tokenColors: TokenColorRule[]; semanticHighlighting?: boolean; semanticTokenColors: Record<string, SemanticTokenStyle> };

async function readThemeFile(path: string, root: string): Promise<unknown> {
  if (!insideFolder(root, path)) throw new Error(`${path} is outside the extension`);
  const text = await readFile(path, "utf8");
  if (extname(path).toLowerCase() === ".json") return parseJsonc(text);
  // .tmTheme (plist XML)
  return vscodeTextmate.parseRawGrammar(text, path);
}

function tokenRules(value: unknown): TokenColorRule[] {
  if (!Array.isArray(value)) return [];
  return value.filter((rule): rule is TokenColorRule => !!rule && typeof rule === "object" && !!(rule as TokenColorRule).settings && typeof (rule as TokenColorRule).settings === "object");
}

async function loadInto(result: Loaded, path: string, root: string, seen: Set<string>): Promise<void> {
  const key = resolve(path).toLowerCase();
  if (seen.has(key)) throw new Error(`the theme includes itself: ${path}`);
  seen.add(key);
  const content = (await readThemeFile(path, root)) as Record<string, unknown> | null;
  if (!content || typeof content !== "object") throw new Error(`${path} is not a theme`);
  if (extname(path).toLowerCase() !== ".json") {
    // A .tmTheme: its rules are token colors.
    result.tokenColors.push(...tokenRules(content.settings));
    return;
  }
  if (typeof content.include === "string") await loadInto(result, resolve(dirname(path), content.include), root, seen);
  if (content.colors && typeof content.colors === "object") {
    for (const [id, value] of Object.entries(content.colors as Record<string, unknown>)) if (typeof value === "string") result.colors[id] = value;
  }
  if (typeof content.tokenColors === "string") {
    const file = (await readThemeFile(resolve(dirname(path), content.tokenColors), root)) as { settings?: unknown; tokenColors?: unknown } | null;
    result.tokenColors.push(...tokenRules(file?.settings ?? file?.tokenColors ?? file));
  } else result.tokenColors.push(...tokenRules(content.tokenColors));
  if (typeof content.semanticHighlighting === "boolean") result.semanticHighlighting = content.semanticHighlighting;
  if (content.semanticTokenColors && typeof content.semanticTokenColors === "object") Object.assign(result.semanticTokenColors, content.semanticTokenColors);
}

/** A contributed theme with its includes and token color files resolved. */
export async function loadColorTheme(theme: ExtensionColorTheme, extensionRoot: string): Promise<ColorThemeData> {
  const result: Loaded = { colors: {}, tokenColors: [], semanticTokenColors: {} };
  await loadInto(result, theme.path, extensionRoot, new Set());
  // The rule without a scope holds a .tmTheme's editor colors; the theme's `colors` win.
  for (const rule of result.tokenColors) {
    if (rule.scope !== undefined) continue;
    for (const [setting, value] of Object.entries(rule.settings as Record<string, unknown>)) {
      const id = TM_THEME_COLORS[setting];
      if (id && typeof value === "string" && result.colors[id] === undefined) result.colors[id] = value;
    }
  }
  return {
    id: theme.id,
    label: theme.label,
    kind: theme.kind,
    colors: result.colors,
    tokenColors: result.tokenColors,
    semanticHighlighting: result.semanticHighlighting,
    semanticTokenColors: Object.keys(result.semanticTokenColors).length ? result.semanticTokenColors : undefined,
  };
}
