/**
 * Display languages, shared by the view (Lumen's own strings) and the main
 * process (extension manifests and l10n bundles). Lumen's strings are keyed by
 * their English text, so anything without a translation stays English.
 */

/** The `locale` setting: auto follows the system, the rest are display languages Lumen ships. */
export type LocaleSetting = "auto" | DisplayLanguage;
export type DisplayLanguage = "en" | "ja";

export const DISPLAY_LANGUAGES: readonly { id: DisplayLanguage; label: string; english: string }[] = [
  { id: "en", label: "English", english: "English" },
  { id: "ja", label: "日本語", english: "Japanese" },
];

/** The display language for a `locale` setting; `system` is the OS language (navigator.language, Intl). */
export function resolveDisplayLanguage(setting: string | undefined, system: string | undefined): DisplayLanguage {
  const wanted = (setting && setting !== "auto" ? setting : (system ?? "en")).toLowerCase();
  const match = DISPLAY_LANGUAGES.find((language) => wanted === language.id || wanted.startsWith(`${language.id}-`));
  return match?.id ?? "en";
}

/**
 * Fill `{0}`, `{1}` … (positional) or `{name}` (named, from one object argument) placeholders,
 * as vscode.l10n.t does. Unknown placeholders stay as they are.
 */
export function formatMessage(text: string, args: readonly unknown[] | Record<string, unknown>): string {
  return text.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = (args as Record<string, unknown>)[key];
    return value === undefined ? match : String(value);
  });
}

/**
 * The names of a localized file for a language, most specific first, as VS Code looks them
 * up: `package.nls.zh-cn.json` before `package.nls.zh.json`. English has none (the default file is English).
 */
export function localizedFileNames(language: string, name: (locale: string) => string): string[] {
  const locale = language.toLowerCase();
  if (!locale || locale === "en") return [];
  const base = locale.split("-")[0]!;
  return [...new Set([locale, base])].map(name);
}
