import { DISPLAY_LANGUAGES, formatMessage, resolveDisplayLanguage, type DisplayLanguage } from "../../shared/i18n";
import { ja } from "../locales/ja/index";
import { api } from "./rpc";
import { getSettings, onSettingsChange } from "./settings";
import { notify } from "./toast";

/**
 * Lumen's own strings in the display language (the `locale` setting). Strings
 * are keyed by their English text: `t("Save")`, `t("Rename “{0}” to:", name)`.
 * Anything a catalog lacks stays English. The language is fixed for the life of
 * the window, as in VS Code: a change applies after a reload.
 */

const CATALOGS: Record<DisplayLanguage, Readonly<Record<string, string>>> = { en: {}, ja };

export const displayLanguage: DisplayLanguage = resolveDisplayLanguage(getSettings().locale, navigator.language);
const catalog = CATALOGS[displayLanguage];

/** The display-language text of an English string, with `{0}` / `{name}` placeholders filled in. */
export function t(text: string, ...args: unknown[]): string {
  const translated = catalog[text] ?? text;
  if (!args.length) return translated;
  const values = args.length === 1 && typeof args[0] === "object" && args[0] !== null ? (args[0] as Record<string, unknown>) : args;
  return formatMessage(translated, values);
}

/** Whether `text` reads differently in the display language (the command palette then also matches the English). */
export function isTranslated(text: string): boolean {
  return catalog[text] !== undefined && catalog[text] !== text;
}

/** The name of a `locale` setting value for people, in its own language. */
export function localeLabel(value: string): string {
  if (value === "auto") return t("Auto (System Language)");
  const language = DISPLAY_LANGUAGES.find((entry) => entry.id === value);
  return language ? (language.label === language.english ? language.label : `${language.label} (${language.english})`) : value;
}

/**
 * Tell the main process the display language (extension manifests and l10n bundles follow it)
 * and offer a reload when the `locale` setting changes to another language.
 */
export function startDisplayLanguage(): void {
  document.documentElement.lang = displayLanguage;
  void api()
    .request.setDisplayLanguage({ language: displayLanguage })
    .catch(() => undefined);
  let offered = displayLanguage;
  onSettingsChange(() => {
    const next = resolveDisplayLanguage(getSettings().locale, navigator.language);
    if (next === offered) return;
    offered = next;
    if (next === displayLanguage) return;
    // Say it in the language being switched to: that is the one the user reads.
    const message = CATALOGS[next]["Reload the window to change the display language."] ?? "Reload the window to change the display language.";
    const action = CATALOGS[next]["Reload"] ?? "Reload";
    void notify("info", message, [action]).then((choice) => {
      if (choice === 0) location.reload();
    });
  });
}
