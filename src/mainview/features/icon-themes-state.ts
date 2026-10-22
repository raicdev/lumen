import { useSyncExternalStore } from "react";
import type { ExtensionDescription, LanguageContribution } from "../../shared/extensions";
import {
  contributedIcons,
  fontCharacterOf,
  iconIdFor,
  resolveContributedIcon,
  type ContributedIcon,
  type ContributedIconTheme,
  type FileIconTheme,
  type IconDefinition,
  type IconFont,
  type ProductIconTheme,
} from "../../shared/icon-themes";
import { extensionService } from "../lib/extensions";
import { getSettings, onSettingsChange } from "../lib/settings";
import { activeColorTheme, onColorThemeChange } from "../lib/theme";
import { createStore, refreshFeatures } from "./store";
import type { ViewFeatureApi } from "./types";

/**
 * State of the file icon theme and the product icon theme: which ones are
 * selected (workbench.iconTheme / workbench.productIconTheme), their loaded
 * contents and the images / fonts they reference (data: URIs the extension
 * host read). FileIcon and Codicon read it; icon-themes.tsx drives it.
 */

type Loaded<T> = { id: string; key: string; theme: T };

type State = {
  file: Loaded<FileIconTheme> | null;
  product: Loaded<ProductIconTheme> | null;
  /** path → data: URI of images and fonts already loaded. */
  assets: Record<string, string>;
  version: number;
};

const store = createStore<State>({ file: null, product: null, assets: {}, version: 0 });

export const FILE_ICON_THEME_SETTING = "workbench.iconTheme";
export const PRODUCT_ICON_THEME_SETTING = "workbench.productIconTheme";

export function useIconThemeState(): State {
  return useSyncExternalStore(store.subscribe, store.get);
}

export function iconThemeState(): State {
  return store.get();
}

/* ── contributions ──────────────────────────────────────────────────────── */

export function contributedIconThemes(extensions: ExtensionDescription[], kind: "file" | "product"): ContributedIconTheme[] {
  const point = kind === "file" ? "iconThemes" : "productIconThemes";
  const themes: ContributedIconTheme[] = [];
  for (const extension of extensions) {
    const contributions = extension.manifest.contributes?.[point];
    if (!Array.isArray(contributions)) continue;
    for (const raw of contributions as { id?: unknown; label?: unknown; path?: unknown }[]) {
      if (!raw || typeof raw !== "object" || typeof raw.path !== "string") continue;
      const label = typeof raw.label === "string" && raw.label ? raw.label : typeof raw.id === "string" ? raw.id : raw.path;
      const separator = extension.location.includes("\\") ? "\\" : "/";
      const path = `${extension.location.replace(/[\\/]+$/, "")}${separator}${raw.path.replace(/^\.?[\\/]+/, "").replace(/[\\/]/g, separator)}`;
      themes.push({ id: typeof raw.id === "string" && raw.id ? raw.id : label, label, extensionId: extension.id, location: extension.location, path, kind });
    }
  }
  return themes;
}

function findTheme(themes: ContributedIconTheme[], id: string): ContributedIconTheme | undefined {
  return themes.find((theme) => theme.id === id) ?? themes.find((theme) => theme.label === id);
}

/* ── settings ───────────────────────────────────────────────────────────── */

// The Settings type has no icon theme keys; settings.ts stores any key.
export function configuredTheme(key: string): string {
  const value = (getSettings() as unknown as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

/* ── loading ────────────────────────────────────────────────────────────── */

let sequence = { file: 0, product: 0 };
let currentApi: ViewFeatureApi | null = null;
const requested = new Set<string>();
const pending = new Map<string, Set<string>>();
let flushing = false;

function setAssets(loaded: Record<string, string | null>): void {
  const add: Record<string, string> = {};
  for (const [path, uri] of Object.entries(loaded)) if (uri) add[path] = uri;
  if (!Object.keys(add).length) return;
  store.set((state) => ({ ...state, assets: { ...state.assets, ...add }, version: state.version + 1 }));
  refreshFeatures();
}

function flushAssets(): void {
  flushing = false;
  const api = currentApi;
  if (!api) return;
  for (const [key, paths] of [...pending]) {
    pending.delete(key);
    const list = [...paths];
    for (let i = 0; i < list.length; i += 64) {
      api
        .requestHost<Record<string, string | null>>("assets", [key, list.slice(i, i + 64)])
        .then(setAssets)
        .catch(() => undefined);
    }
  }
}

function wantAsset(key: string, path: string): void {
  const id = `${key}\n${path}`;
  if (requested.has(id) || store.get().assets[path]) return;
  requested.add(id);
  let paths = pending.get(key);
  if (!paths) pending.set(key, (paths = new Set()));
  paths.add(path);
  if (!flushing) {
    flushing = true;
    queueMicrotask(flushAssets);
  }
}

const FONT_FORMATS = ["woff2", "woff", "truetype", "opentype"];

/** The `src` of a font face to load (the best format first); `null` when no source is loaded yet. */
function fontSource(font: IconFont, key: string, assets: Record<string, string>): { uri: string; format: string } | null {
  const sorted = [...font.src].sort((a, b) => rank(a) - rank(b));
  const best = sorted[0];
  if (!best) return null;
  const uri = assets[best.path];
  if (!uri) {
    wantAsset(key, best.path);
    return null;
  }
  return { uri, format: best.format ?? "woff" };
  function rank(source: { path: string; format?: string }): number {
    const index = FONT_FORMATS.indexOf(
      (source.format ?? source.path.split(".").pop() ?? "").toLowerCase().replace("ttf", "truetype").replace("otf", "opentype"),
    );
    return index < 0 ? FONT_FORMATS.length : index;
  }
}

export function fontFamilyOf(kind: "file" | "product", fontId: string | undefined, fonts: IconFont[]): string | undefined {
  const font = fonts.find((candidate) => candidate.id === fontId) ?? (fontId === undefined ? fonts[0] : undefined);
  return font ? `lumen-${kind}-icons-${font.id}` : undefined;
}

let fontStyle: HTMLStyleElement | null = null;

/** Keep the @font-face rules of the selected themes in a style element. */
function syncFontFaces(state: State): void {
  if (typeof document === "undefined") return;
  const rules: string[] = [];
  for (const [kind, loaded] of [["file", state.file] as const, ["product", state.product] as const]) {
    if (!loaded) continue;
    for (const font of loaded.theme.fonts) {
      const source = fontSource(font, loaded.key, state.assets);
      if (!source) continue;
      const family = fontFamilyOf(kind, font.id, loaded.theme.fonts);
      // Values come from theme JSON: only let well-formed ones into the CSS text.
      if (!family || !/^[\w-]+$/.test(family) || !/^[\w-]+$/.test(source.format)) continue;
      const weight = font.weight && /^(normal|bold|bolder|lighter|[1-9]00)$/.test(font.weight) ? font.weight : "normal";
      const style = font.style && /^(normal|italic|oblique)$/.test(font.style) ? font.style : "normal";
      rules.push(
        `@font-face{font-family:"${family}";src:url("${source.uri}") format("${source.format}");font-weight:${weight};font-style:${style};font-display:block}`,
      );
    }
  }
  for (const [path, family] of contributedFamilies) {
    const uri = state.assets[path];
    const format = FONT_FORMAT_OF[path.split(".").pop()?.toLowerCase() ?? ""];
    if (uri && format) rules.push(`@font-face{font-family:"${family}";src:url("${uri}") format("${format}");font-display:block}`);
  }
  if (!fontStyle) {
    fontStyle = document.createElement("style");
    fontStyle.id = "lumen-icon-theme-fonts";
    document.head.appendChild(fontStyle);
  }
  const text = rules.join("\n");
  if (fontStyle.textContent !== text) fontStyle.textContent = text;
}

store.subscribe(() => syncFontFaces(store.get()));

async function loadTheme<T>(api: ViewFeatureApi, theme: ContributedIconTheme): Promise<Loaded<T>> {
  const result = await api.requestHost<{ key: string; theme: T }>("load", [theme.kind, theme.extensionId, theme.path]);
  return { id: theme.id, key: result.key, theme: result.theme };
}

/** Load (or unload, when the setting is empty or names no contributed theme) the selected file icon theme. */
export async function applyFileIconTheme(api: ViewFeatureApi, force = false): Promise<void> {
  const mine = ++sequence.file;
  const id = configuredTheme(FILE_ICON_THEME_SETTING);
  const contributed = id ? findTheme(contributedIconThemes(api.getExtensions(), "file"), id) : undefined;
  if (!contributed) {
    store.set((state) => (state.file ? { ...state, file: null, version: state.version + 1 } : state));
    return;
  }
  if (!force && store.get().file?.id === contributed.id) return;
  try {
    const loaded = await loadTheme<FileIconTheme>(api, contributed);
    if (mine !== sequence.file) return;
    store.set((state) => ({ ...state, file: loaded, version: state.version + 1 }));
  } catch (error) {
    if (mine === sequence.file)
      api.showMessage("error", `Cannot load file icon theme "${contributed.label}": ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function applyProductIconTheme(api: ViewFeatureApi, force = false): Promise<void> {
  const mine = ++sequence.product;
  const id = configuredTheme(PRODUCT_ICON_THEME_SETTING);
  const contributed = id ? findTheme(contributedIconThemes(api.getExtensions(), "product"), id) : undefined;
  if (!contributed) {
    store.set((state) => (state.product ? { ...state, product: null, version: state.version + 1 } : state));
    return;
  }
  if (!force && store.get().product?.id === contributed.id) return;
  try {
    const loaded = await loadTheme<ProductIconTheme>(api, contributed);
    if (mine !== sequence.product) return;
    store.set((state) => ({ ...state, product: loaded, version: state.version + 1 }));
    refreshFeatures();
  } catch (error) {
    if (mine === sequence.product)
      api.showMessage("error", `Cannot load product icon theme "${contributed.label}": ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function bindIconThemes(api: ViewFeatureApi): void {
  currentApi = api;
  // A restarted host forgot the themes it loaded: ask for the assets again.
  requested.clear();
  collectLanguages(api.getExtensions());
  collectIcons(api.getExtensions());
}

/* ── contributes.icons ──────────────────────────────────────────────────── */

let iconContributions = new Map<string, ContributedIcon>();
/** Font path → font family of the fonts contributed icons use. */
const contributedFamilies = new Map<string, string>();
const FONT_FORMAT_OF: Record<string, string> = { woff2: "woff2", woff: "woff", ttf: "truetype", otf: "opentype" };

function collectIcons(extensions: ExtensionDescription[]): void {
  iconContributions = contributedIcons(extensions);
  store.set((state) => ({ ...state, version: state.version + 1 }));
}

function wantIconFont(extensionId: string, path: string): void {
  const id = `icons\n${path}`;
  const api = currentApi;
  if (!api || requested.has(id)) return;
  requested.add(id);
  api
    .requestHost<string | null>("iconFont", [extensionId, path])
    .then((uri) => setAssets({ [path]: uri }))
    .catch(() => undefined);
}

/**
 * An icon of `contributes.icons` by id: a glyph of the extension's font (once it is loaded),
 * or the codicon an alias ends at. `undefined` when no extension contributes the id.
 */
export function contributedIcon(id: string, state: State = store.get()): { char: string; family: string } | { codicon: string } | undefined {
  const icon = resolveContributedIcon(id, iconContributions);
  if (!icon || "codicon" in icon) return icon;
  let family = contributedFamilies.get(icon.fontPath);
  if (!family) contributedFamilies.set(icon.fontPath, (family = `lumen-contributed-icons-${contributedFamilies.size}`));
  if (!state.assets[icon.fontPath]) {
    wantIconFont(icon.extensionId, icon.fontPath);
    return undefined;
  }
  return { char: fontCharacterOf(icon.fontCharacter), family };
}

/* ── lookup ─────────────────────────────────────────────────────────────── */

const BUILT_IN_EXTENSIONS: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascriptreact",
  json: "json",
  jsonc: "jsonc",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  md: "markdown",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cs: "csharp",
  php: "php",
  rb: "ruby",
  sh: "shellscript",
  bash: "shellscript",
  ps1: "powershell",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sql: "sql",
  xml: "xml",
  vue: "vue",
  svelte: "svelte",
  kt: "kotlin",
  lua: "lua",
  swift: "swift",
};
const BUILT_IN_NAMES: Record<string, string> = { dockerfile: "dockerfile", makefile: "makefile" };

let languageByExtension = new Map<string, string>();
let languageByName = new Map<string, string>();

function collectLanguages(extensions: ExtensionDescription[]): void {
  const byExtension = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const extension of extensions) {
    const languages = extension.manifest.contributes?.languages as LanguageContribution[] | undefined;
    if (!Array.isArray(languages)) continue;
    for (const language of languages) {
      for (const ext of language.extensions ?? []) byExtension.set(ext.replace(/^\./, "").toLowerCase(), language.id);
      for (const name of language.filenames ?? []) byName.set(name.toLowerCase(), language.id);
    }
  }
  languageByExtension = byExtension;
  languageByName = byName;
}

function languageIdOf(name: string): string | undefined {
  const lower = name.toLowerCase();
  const byName = languageByName.get(lower) ?? BUILT_IN_NAMES[lower];
  if (byName) return byName;
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return undefined;
  const extension = lower.slice(dot + 1);
  return languageByExtension.get(extension) ?? BUILT_IN_EXTENSIONS[extension];
}

export type ThemedIcon =
  | { kind: "image"; src: string }
  | { kind: "font"; char: string; family: string; color?: string; size?: string }
  /** The theme has no icon for this entry (or it is still loading). */
  | { kind: "none" };

function schemeOf(): "dark" | "light" | "highContrast" {
  const kind = activeColorTheme().kind;
  if (kind === "hcDark" || kind === "hcLight") return "highContrast";
  return kind === "light" ? "light" : "dark";
}

function render(loaded: Loaded<FileIconTheme>, definition: IconDefinition | undefined, assets: Record<string, string>): ThemedIcon {
  if (!definition) return { kind: "none" };
  if (definition.path) {
    const src = assets[definition.path];
    if (!src) {
      wantAsset(loaded.key, definition.path);
      return { kind: "none" };
    }
    return { kind: "image", src };
  }
  if (definition.fontCharacter) {
    const family = fontFamilyOf("file", definition.fontId, loaded.theme.fonts);
    if (!family) return { kind: "none" };
    const font = loaded.theme.fonts.find((candidate) => candidate.id === (definition.fontId ?? loaded.theme.fonts[0]?.id));
    if (font && !fontLoaded(font, loaded, assets)) return { kind: "none" };
    return { kind: "font", char: fontCharacterOf(definition.fontCharacter), family, color: definition.fontColor, size: definition.fontSize ?? font?.size };
  }
  return { kind: "none" };
}

function fontLoaded(font: IconFont, loaded: Loaded<{ fonts: IconFont[] }>, assets: Record<string, string>): boolean {
  return fontSource(font, loaded.key, assets) !== null;
}

/** The icon of a file, or `undefined` when no file icon theme is selected (the built-in glyphs apply). */
export function themedFileIcon(name: string, state: State = store.get()): ThemedIcon | undefined {
  const loaded = state.file;
  if (!loaded) return undefined;
  const id = iconIdFor(loaded.theme, { kind: "file", name, languageId: languageIdOf(name) }, schemeOf());
  return render(loaded, id ? loaded.theme.iconDefinitions[id] : undefined, state.assets);
}

export function themedFolderIcon(name: string, expanded: boolean, root: boolean, state: State = store.get()): ThemedIcon | undefined {
  const loaded = state.file;
  if (!loaded) return undefined;
  const id = iconIdFor(loaded.theme, { kind: "folder", name, expanded, root }, schemeOf());
  return render(loaded, id ? loaded.theme.iconDefinitions[id] : undefined, state.assets);
}

/** A glyph of the product icon theme for a codicon id (`"chevron-down"`), when the theme defines it and its font is loaded. */
export function productIcon(codicon: string, state: State = store.get()): { char: string; family: string } | undefined {
  const loaded = state.product;
  const definition = loaded?.theme.icons[codicon];
  if (!loaded || !definition) return undefined;
  const font = loaded.theme.fonts.find((candidate) => candidate.id === definition.fontId) ?? loaded.theme.fonts[0];
  if (!font || !fontLoaded(font, loaded, state.assets)) return undefined;
  const family = fontFamilyOf("product", font.id, loaded.theme.fonts);
  return family ? { char: fontCharacterOf(definition.fontCharacter), family } : undefined;
}

export function hidesExplorerArrows(): boolean {
  return !!store.get().file?.theme.hidesExplorerArrows;
}

/** Re-render themed icons when the color theme (light / dark variants) or the selection settings change. */
export function watchIconThemeInputs(api: ViewFeatureApi): () => void {
  let last = `${configuredTheme(FILE_ICON_THEME_SETTING)}\n${configuredTheme(PRODUCT_ICON_THEME_SETTING)}`;
  const offSettings = onSettingsChange(() => {
    const now = `${configuredTheme(FILE_ICON_THEME_SETTING)}\n${configuredTheme(PRODUCT_ICON_THEME_SETTING)}`;
    if (now === last) return;
    last = now;
    void applyFileIconTheme(api);
    void applyProductIconTheme(api);
  });
  const offTheme = onColorThemeChange(() => store.set((state) => ({ ...state, version: state.version + 1 })));
  const offExtensions = extensionService.subscribe(() => {
    collectLanguages(api.getExtensions());
    collectIcons(api.getExtensions());
  });
  return () => {
    offSettings();
    offTheme();
    offExtensions();
  };
}
