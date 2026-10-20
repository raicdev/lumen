/**
 * Color themes (contributes.themes): VS Code's theme files resolved by the
 * main process, and the workbench colors Lumen paints with. Every color is a
 * CSS variable named like VS Code's (`editor.background` →
 * `--vscode-editor-background`), so the window, webviews and decorations from
 * extensions all follow the active theme.
 */

export type ColorThemeKind = "dark" | "light" | "hcDark" | "hcLight";

/** A theme an extension contributes (package.json contributes.themes). */
export type ExtensionColorTheme = {
  /** The value of `workbench.colorTheme` (VS Code: the theme's id, else its label). */
  id: string;
  label: string;
  kind: ColorThemeKind;
  extensionId: string;
  /** Absolute path of the theme file inside the extension's folder. */
  path: string;
};

export type TokenColorSettings = { foreground?: string; background?: string; fontStyle?: string };

/** A tokenColors rule: TextMate scope selectors (comma separated or a list) and their style. */
export type TokenColorRule = { name?: string; scope?: string | string[]; settings: TokenColorSettings };

export type SemanticTokenStyle = string | { foreground?: string; fontStyle?: string; bold?: boolean; italic?: boolean; underline?: boolean; strikethrough?: boolean };

/** A theme with its `include`s and token color files loaded. */
export type ColorThemeData = {
  id: string;
  label: string;
  kind: ColorThemeKind;
  colors: Record<string, string>;
  tokenColors: TokenColorRule[];
  semanticHighlighting?: boolean;
  semanticTokenColors?: Record<string, SemanticTokenStyle>;
};

export const DEFAULT_THEME_ID = "Lumen Dark";
export const DEFAULT_LIGHT_THEME_ID = "Lumen Light";

/** contributes.themes[].uiTheme → kind. */
export function kindOfUiTheme(uiTheme: unknown): ColorThemeKind {
  if (uiTheme === "vs") return "light";
  if (uiTheme === "hc-black") return "hcDark";
  if (uiTheme === "hc-light") return "hcLight";
  return "dark";
}

export const isLightKind = (kind: ColorThemeKind) => kind === "light" || kind === "hcLight";

/** The body class VS Code gives webviews (`vscode-dark`, `vscode-high-contrast`, …). */
export function themeBodyClass(kind: ColorThemeKind): string {
  if (kind === "light") return "vscode-light";
  if (kind === "hcDark") return "vscode-high-contrast";
  if (kind === "hcLight") return "vscode-high-contrast-light";
  return "vscode-dark";
}

export const cssVariable = (id: string) => `--vscode-${id.replace(/\./g, "-")}`;

/**
 * Default colors: [dark, light], Lumen's own looks (the shell — title bar,
 * activity bar, status bar — is one color and the parts float on it as cards).
 * `@id` refers to another color (resolved for the theme's kind).
 * High contrast themes start from the dark / light column.
 */
export const COLOR_DEFAULTS: Record<string, [string, string]> = {
  /* base */
  foreground: ["#d4d4d8", "#3b3b3b"],
  descriptionForeground: ["#a1a1aa", "#6b6b6b"],
  disabledForeground: ["#71717a", "#8b8b8b"],
  errorForeground: ["#f48771", "#a1260d"],
  focusBorder: ["#5b8def", "#005fb8"],
  "icon.foreground": ["#c4c4cc", "#424242"],
  "widget.shadow": ["#00000080", "#0000001f"],
  "widget.border": ["#ffffff14", "#e5e5e5"],
  "selection.background": ["#5b8def4d", "#add6ff"],
  "sash.hoverBorder": ["@focusBorder", "@focusBorder"],
  "textLink.foreground": ["#7aa7ff", "#005fb8"],
  "textLink.activeForeground": ["#9cbcff", "#004a8f"],
  "textPreformat.foreground": ["#d7ba7d", "#a31515"],
  "textBlockQuote.background": ["#ffffff08", "#f6f6f6"],
  "textBlockQuote.border": ["#5b8def80", "#005fb880"],
  "textCodeBlock.background": ["#ffffff12", "#dcdcdc66"],
  "textSeparator.foreground": ["#ffffff2e", "#0000002e"],
  "progressBar.background": ["#5b8def", "#005fb8"],
  "toolbar.hoverBackground": ["#ffffff14", "#0000000f"],
  "toolbar.activeBackground": ["#ffffff0d", "#0000001a"],
  "charts.red": ["#f14c4c", "#e51400"],
  "charts.blue": ["#5b8def", "#1a85ff"],
  "charts.yellow": ["#cca700", "#bf8803"],
  "charts.green": ["#89d185", "#388a34"],
  "charts.purple": ["#b180d7", "#652d90"],
  "charts.orange": ["#d18616", "#d18616"],
  "testing.iconPassed": ["#73c991", "#388a34"],
  "settings.modifiedItemIndicator": ["#5b8def", "#005fb8"],

  /* editor */
  "editor.background": ["#1a1a1d", "#ffffff"],
  "editor.foreground": ["#d4d4d8", "#000000"],
  "editorCursor.foreground": ["#e4e4e7", "#1f1f1f"],
  "editor.selectionBackground": ["#5b8def42", "#add6ff"],
  "editor.inactiveSelectionBackground": ["#ffffff14", "#e5ebf1"],
  "editor.lineHighlightBackground": ["#ffffff06", "#0000000a"],
  "editorLineNumber.foreground": ["#5c5c66", "#a0a0a8"],
  "editorLineNumber.activeForeground": ["#c4c4cc", "#3b3b3b"],
  "editorGutter.background": ["@editor.background", "@editor.background"],
  "editorGutter.addedBackground": ["#2ea043", "#48985d"],
  "editorGutter.modifiedBackground": ["#1b81a8", "#2090d3"],
  "editorGutter.deletedBackground": ["#f14c4c", "#e51400"],
  "editorIndentGuide.background": ["#2a2a30", "#e8e8ec"],
  "editorIndentGuide.activeBackground": ["#48484f", "#c4c4cc"],
  "editorWhitespace.foreground": ["#e3e4e229", "#33333333"],
  "editorBracketMatch.background": ["#ffffff1a", "#0064001a"],
  "editorBracketMatch.border": ["#888888", "#b9b9b9"],
  "editor.findMatchBackground": ["#ea5c0080", "#a8ac94"],
  "editor.findMatchHighlightBackground": ["#ea5c0054", "#ea5c0055"],
  "editor.wordHighlightBackground": ["#78aaff29", "#57575740"],
  "editor.wordHighlightStrongBackground": ["#ffaa5a38", "#0e639c40"],
  "editor.stackFrameHighlightBackground": ["#ffcc0024", "#ffff6673"],
  "editor.focusedStackFrameHighlightBackground": ["#89d1851f", "#cee7ce73"],
  "editorError.foreground": ["#f14c4c", "#e51400"],
  "editorWarning.foreground": ["#cca700", "#bf8803"],
  "editorInfo.foreground": ["#3794ff", "#1a85ff"],
  "editorCodeLens.foreground": ["#999999", "#919191"],
  "editorGhostText.foreground": ["#ffffff57", "#00000077"],
  "editorInlayHint.foreground": ["#969696", "#969696"],
  "editorInlayHint.background": ["#6161611a", "#c4c4c41a"],
  "editorLink.activeForeground": ["#4e94ce", "#0000ff"],
  "editorWidget.background": ["#222226", "#f8f8f8"],
  "editorWidget.foreground": ["@foreground", "@foreground"],
  "editorWidget.border": ["#ffffff14", "#e5e5e5"],
  "editorHoverWidget.background": ["@editorWidget.background", "@editorWidget.background"],
  "editorHoverWidget.foreground": ["@foreground", "@foreground"],
  "editorHoverWidget.border": ["#ffffff14", "#e5e5e5"],
  "editorSuggestWidget.background": ["@editorHoverWidget.background", "@editorHoverWidget.background"],
  "editorSuggestWidget.foreground": ["@editor.foreground", "@editor.foreground"],
  "editorSuggestWidget.border": ["@editorHoverWidget.border", "@editorHoverWidget.border"],
  "editorSuggestWidget.selectedBackground": ["@list.inactiveSelectionBackground", "@list.activeSelectionBackground"],
  "editorSuggestWidget.selectedForeground": ["@editorSuggestWidget.foreground", "@list.activeSelectionForeground"],
  "editorSuggestWidget.highlightForeground": ["@list.highlightForeground", "@list.highlightForeground"],
  "editorGroup.border": ["#ffffff12", "#0000001a"],
  "editorGroup.dropBackground": ["#5b8def29", "#005fb81f"],
  "editorGroupHeader.tabsBackground": ["@editor.background", "@editor.background"],
  "editorOverviewRuler.border": ["#7f7f7f4d", "#7f7f7f4d"],
  "minimap.background": ["@editor.background", "@editor.background"],
  "diffEditor.insertedLineBackground": ["#2ea04326", "#9bb95533"],
  "diffEditor.removedLineBackground": ["#f8514926", "#ff000033"],
  "diffEditor.insertedTextBackground": ["#2ea0434d", "#9ccc2c40"],
  "diffEditor.removedTextBackground": ["#f851494d", "#ff000033"],

  /* tabs */
  "tab.activeBackground": ["#ffffff12", "#0000000d"],
  "tab.activeForeground": ["@foreground", "#1f1f1f"],
  "tab.inactiveBackground": ["#00000000", "#00000000"],
  "tab.inactiveForeground": ["@descriptionForeground", "#6b6b6b"],
  "tab.border": ["#00000000", "#00000000"],
  "tab.activeBorderTop": ["@focusBorder", "@focusBorder"],
  "tab.hoverBackground": ["@list.hoverBackground", "@list.hoverBackground"],

  /* workbench parts */
  "titleBar.activeBackground": ["#111113", "#eeeef0"],
  "titleBar.activeForeground": ["@foreground", "#1f1f1f"],
  "titleBar.inactiveBackground": ["@titleBar.activeBackground", "@titleBar.activeBackground"],
  "titleBar.inactiveForeground": ["@disabledForeground", "#8b8b8b"],
  "titleBar.border": ["#00000000", "#00000000"],
  "activityBar.background": ["@titleBar.activeBackground", "@titleBar.activeBackground"],
  "activityBar.foreground": ["#e4e4e7", "#1f1f1f"],
  "activityBar.inactiveForeground": ["#7c7c86", "#6b6b6b"],
  "activityBar.activeBorder": ["@focusBorder", "@focusBorder"],
  "activityBar.border": ["#00000000", "#00000000"],
  "activityBarBadge.background": ["@focusBorder", "@focusBorder"],
  "activityBarBadge.foreground": ["#ffffff", "#ffffff"],
  "sideBar.background": ["#17171a", "#f8f8f9"],
  "sideBar.foreground": ["@foreground", "@foreground"],
  "sideBar.border": ["#ffffff0f", "#0000001a"],
  "sideBarTitle.foreground": ["@foreground", "#1f1f1f"],
  "sideBarSectionHeader.background": ["@sideBar.background", "@sideBar.background"],
  "sideBarSectionHeader.foreground": ["@foreground", "@foreground"],
  "sideBarSectionHeader.border": ["#ffffff0f", "#0000001a"],
  "panel.background": ["@sideBar.background", "@sideBar.background"],
  "panel.border": ["#ffffff0f", "#0000001a"],
  "panelTitle.activeForeground": ["@foreground", "#1f1f1f"],
  "panelTitle.inactiveForeground": ["@descriptionForeground", "#6b6b6b"],
  "panelTitle.activeBorder": ["@focusBorder", "@focusBorder"],
  "statusBar.background": ["@titleBar.activeBackground", "@titleBar.activeBackground"],
  "statusBar.foreground": ["@descriptionForeground", "#4b4b4b"],
  "statusBar.border": ["#00000000", "#00000000"],
  "statusBar.debuggingBackground": ["#cc6633", "#cc6633"],
  "statusBar.debuggingForeground": ["#ffffff", "#ffffff"],
  "statusBarItem.hoverBackground": ["#ffffff14", "#0000000f"],
  "statusBarItem.activeBackground": ["#ffffff1f", "#0000001a"],
  "statusBarItem.errorBackground": ["#c72e0f", "#c72e0f"],
  "statusBarItem.warningBackground": ["#7a6400", "#725102"],
  "statusBarItem.prominentBackground": ["#ffffff1f", "#0000001a"],

  /* lists, inputs, buttons, menus */
  "list.hoverBackground": ["#ffffff0a", "#0000000a"],
  "list.activeSelectionBackground": ["#5b8def33", "#dbe7fb"],
  "list.activeSelectionForeground": ["#ffffff", "#1f1f1f"],
  "list.inactiveSelectionBackground": ["#ffffff12", "#0000000f"],
  "list.focusOutline": ["@focusBorder", "@focusBorder"],
  "list.highlightForeground": ["#7aa7ff", "#005fb8"],
  "list.errorForeground": ["#f88070", "#b01011"],
  "list.warningForeground": ["#cca700", "#855f00"],
  "list.dropBackground": ["#5b8def38", "#dbe7fb"],
  "tree.indentGuidesStroke": ["#3a3a41", "#d4d4d8"],
  "input.background": ["#ffffff0a", "#ffffff"],
  "input.foreground": ["@foreground", "@foreground"],
  "input.border": ["#ffffff14", "#d8d8dc"],
  "input.placeholderForeground": ["#71717a", "#8b8b8b"],
  "inputOption.activeBorder": ["@focusBorder", "@focusBorder"],
  "inputOption.activeBackground": ["#5b8def33", "#005fb826"],
  "inputValidation.errorBackground": ["#5a1d1d", "#f2dede"],
  "inputValidation.errorBorder": ["#be1100", "#be1100"],
  "dropdown.background": ["#222226", "#ffffff"],
  "dropdown.foreground": ["@foreground", "@foreground"],
  "dropdown.border": ["#ffffff14", "#d8d8dc"],
  "checkbox.background": ["@dropdown.background", "@dropdown.background"],
  "checkbox.foreground": ["@dropdown.foreground", "@dropdown.foreground"],
  "checkbox.border": ["@dropdown.border", "@dropdown.border"],
  "button.background": ["#3d73e0", "#005fb8"],
  "button.foreground": ["#ffffff", "#ffffff"],
  "button.hoverBackground": ["#4d82ee", "#0258a8"],
  "button.border": ["#00000000", "#00000000"],
  "button.secondaryBackground": ["#2a2a30", "#e5e5e8"],
  "button.secondaryForeground": ["@foreground", "#1f1f1f"],
  "button.secondaryHoverBackground": ["#34343b", "#dadade"],
  "badge.background": ["#2e2e35", "#e2e2e6"],
  "badge.foreground": ["@foreground", "#3b3b3b"],
  "scrollbarSlider.background": ["#ffffff1a", "#0000001f"],
  "scrollbarSlider.hoverBackground": ["#ffffff2b", "#00000033"],
  "scrollbarSlider.activeBackground": ["#ffffff40", "#0000004d"],
  "menu.background": ["@editorWidget.background", "#ffffff"],
  "menu.foreground": ["@foreground", "@foreground"],
  "menu.selectionBackground": ["@list.activeSelectionBackground", "@list.activeSelectionBackground"],
  "menu.selectionForeground": ["@foreground", "#1f1f1f"],
  "menu.border": ["#ffffff14", "#e5e5e5"],
  "quickInput.background": ["@editorWidget.background", "@editorWidget.background"],
  "quickInput.foreground": ["@editorWidget.foreground", "@editorWidget.foreground"],
  "quickInputList.focusBackground": ["@list.activeSelectionBackground", "@list.activeSelectionBackground"],
  "quickInputList.focusForeground": ["@foreground", "@list.activeSelectionForeground"],
  "notifications.background": ["@editorWidget.background", "@editorWidget.background"],
  "notifications.foreground": ["@foreground", "@foreground"],
  "notifications.border": ["#ffffff14", "#e5e5e5"],
  "keybindingLabel.background": ["#ffffff0f", "#0000000a"],
  "keybindingLabel.foreground": ["#c4c4cc", "#3b3b3b"],
  "keybindingLabel.border": ["#ffffff1a", "#0000001f"],
  "extensionButton.prominentBackground": ["@button.background", "@button.background"],
  "extensionButton.prominentForeground": ["@button.foreground", "@button.foreground"],
  "extensionButton.prominentHoverBackground": ["@button.hoverBackground", "@button.hoverBackground"],

  /* source control, problems */
  "gitDecoration.addedResourceForeground": ["#81b88b", "#587c0c"],
  "gitDecoration.modifiedResourceForeground": ["#e2c08d", "#895503"],
  "gitDecoration.deletedResourceForeground": ["#c74e39", "#ad0707"],
  "gitDecoration.untrackedResourceForeground": ["#73c991", "#007100"],
  "gitDecoration.renamedResourceForeground": ["#73c991", "#007100"],
  "gitDecoration.conflictingResourceForeground": ["#e4676b", "#ad0707"],
  "problemsErrorIcon.foreground": ["@editorError.foreground", "@editorError.foreground"],
  "problemsWarningIcon.foreground": ["@editorWarning.foreground", "@editorWarning.foreground"],

  /* terminal */
  "terminal.background": ["@panel.background", "@panel.background"],
  "terminal.foreground": ["#d4d4d8", "#333333"],
  "terminalCursor.foreground": ["#e4e4e7", "#333333"],
  "terminal.selectionBackground": ["#5b8def4d", "#add6ff"],
  "terminal.ansiBlack": ["#000000", "#000000"],
  "terminal.ansiRed": ["#f14c4c", "#cd3131"],
  "terminal.ansiGreen": ["#89d185", "#00bc00"],
  "terminal.ansiYellow": ["#cca700", "#949800"],
  "terminal.ansiBlue": ["#3794ff", "#0451a5"],
  "terminal.ansiMagenta": ["#b180d7", "#bc05bc"],
  "terminal.ansiCyan": ["#29b8db", "#0598bc"],
  "terminal.ansiWhite": ["#cccccc", "#555555"],
  "terminal.ansiBrightBlack": ["#666666", "#666666"],
  "terminal.ansiBrightRed": ["#f14c4c", "#cd3131"],
  "terminal.ansiBrightGreen": ["#89d185", "#14ce14"],
  "terminal.ansiBrightYellow": ["#cca700", "#b5ba00"],
  "terminal.ansiBrightBlue": ["#3794ff", "#0451a5"],
  "terminal.ansiBrightMagenta": ["#b180d7", "#bc05bc"],
  "terminal.ansiBrightCyan": ["#29b8db", "#0598bc"],
  "terminal.ansiBrightWhite": ["#e5e5e5", "#a5a5a5"],

  /* debugging */
  "debugIcon.breakpointForeground": ["#e51400", "#e51400"],
  "debugIcon.breakpointDisabledForeground": ["#848484", "#848484"],
  "debugIcon.breakpointUnverifiedForeground": ["#848484", "#848484"],
  "debugIcon.breakpointCurrentStackframeForeground": ["#ffcc00", "#be8700"],
  "debugIcon.breakpointStackframeForeground": ["#89d185", "#89d185"],
  "debugIcon.startForeground": ["#89d185", "#388a34"],
  "debugIcon.continueForeground": ["#89d185", "#007acc"],
  "debugIcon.restartForeground": ["#89d185", "#388a34"],
  "debugToolBar.foreground": ["#75beff", "#007acc"],
  "debugTokenExpression.name": ["#c586c0", "#9b46b0"],
  "debugTokenExpression.string": ["#ce9178", "#a31515"],
  "debugTokenExpression.number": ["#b5cea8", "#098658"],
  "debugTokenExpression.boolean": ["#569cd6", "#0000ff"],
  "debugConsole.errorForeground": ["@errorForeground", "@errorForeground"],
};

/**
 * Every workbench color for a theme: the theme's own values, then the
 * defaults for its kind (references resolved). Colors only the theme knows are
 * kept too, so extensions' ThemeColors and webviews can use them.
 */
export function resolveThemeColors(kind: ColorThemeKind, colors: Record<string, string>): Record<string, string> {
  const column = isLightKind(kind) ? 1 : 0;
  const resolved: Record<string, string> = {};
  const resolve = (id: string, depth: number): string | undefined => {
    if (resolved[id] !== undefined) return resolved[id];
    const own = colors[id];
    const value = typeof own === "string" && own ? own : COLOR_DEFAULTS[id]?.[column];
    if (value === undefined) return undefined;
    const result = value.startsWith("@") ? (depth > 8 ? undefined : resolve(value.slice(1), depth + 1)) : value;
    if (result !== undefined) resolved[id] = result;
    return result;
  };
  for (const id of Object.keys(COLOR_DEFAULTS)) resolve(id, 0);
  for (const [id, value] of Object.entries(colors)) if (typeof value === "string" && value && !value.startsWith("@")) resolved[id] ??= value;
  return resolved;
}

/* ── TextMate scope matching ──────────────────────────────────────────── */

type Selector = { parts: string[]; excluded: string[] };
export type CompiledTokenRule = { selectors: Selector[]; settings: TokenColorSettings; index: number };
export type TokenStyle = { foreground?: string; fontStyle?: string };

export function compileTokenRules(rules: TokenColorRule[]): CompiledTokenRule[] {
  return rules.flatMap((value, index) => {
    if (value.scope === undefined || !value.settings) return [];
    const raw = Array.isArray(value.scope) ? value.scope : String(value.scope).split(",");
    const selectors = raw
      .map((text) => {
        // "a b -c": c excludes, the rest is a descendant path.
        const [path = "", ...excluded] = String(text).split(/\s+-\s*/);
        return { parts: path.trim().split(/\s+/).filter(Boolean), excluded: excluded.map((part) => part.trim()).filter(Boolean) };
      })
      .filter((selector) => selector.parts.length);
    return selectors.length ? [{ selectors, settings: value.settings, index }] : [];
  });
}

const scopeMatches = (scope: string, selector: string) => scope === selector || scope.startsWith(`${selector}.`);

/** How well a selector matches a token's scopes (innermost last), or null. Higher is more specific. */
function score(selector: Selector, scopes: readonly string[]): number[] | null {
  const last = selector.parts[selector.parts.length - 1]!;
  for (let depth = scopes.length - 1; depth >= 0; depth--) {
    if (!scopeMatches(scopes[depth]!, last)) continue;
    // Ancestors match outer scopes, in order.
    let cursor = depth - 1;
    let ok = true;
    for (let part = selector.parts.length - 2; part >= 0 && ok; part--) {
      while (cursor >= 0 && !scopeMatches(scopes[cursor]!, selector.parts[part]!)) cursor--;
      if (cursor < 0) ok = false;
      cursor--;
    }
    if (!ok) continue;
    if (selector.excluded.some((excluded) => scopes.some((scope) => scopeMatches(scope, excluded)))) return null;
    return [depth, last.split(".").length, selector.parts.length];
  }
  return null;
}

const better = (a: number[], b: number[] | null) => {
  if (!b) return true;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return true; // a later rule wins a tie
};

/** The foreground and font style a theme gives a token (each from its most specific rule). */
export function matchTokenStyle(rules: CompiledTokenRule[], scopes: readonly string[]): TokenStyle {
  let foreground: { value: string; score: number[] } | null = null;
  let fontStyle: { value: string; score: number[] } | null = null;
  for (const compiled of rules) {
    let best: number[] | null = null;
    for (const selector of compiled.selectors) {
      const result = score(selector, scopes);
      if (result && better(result, best)) best = result;
    }
    if (!best) continue;
    if (compiled.settings.foreground && better(best, foreground?.score ?? null)) foreground = { value: compiled.settings.foreground, score: best };
    if (typeof compiled.settings.fontStyle === "string" && better(best, fontStyle?.score ?? null)) fontStyle = { value: compiled.settings.fontStyle, score: best };
  }
  return { foreground: foreground?.value, fontStyle: fontStyle?.value };
}
