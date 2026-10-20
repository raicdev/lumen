import type { EditorView } from "@codemirror/view";
import type { LanguagesExtraAvailability } from "../../../shared/languages-extra";
import type { ViewFeatureApi } from "../types";

/** State shared by the hierarchy panel and the editor integrations of the "languages-extra" area. */

/** What the registered providers can do for a document; refetched after the host reported a change. */
const availability = new Map<string, { version: number; value: LanguagesExtraAvailability | null; pending: boolean }>();
let version = 0;
const changeListeners = new Set<() => void>();
const inlineValueListeners = new Set<() => void>();

/** The providers changed (registered / disposed): availability is stale, editors ask again. */
export function providersChanged(): void {
  version++;
  for (const listener of [...changeListeners]) listener();
}

export function inlineValuesChanged(): void {
  for (const listener of [...inlineValueListeners]) listener();
}

export function onProvidersChange(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => void changeListeners.delete(listener);
}

export function onInlineValuesChange(listener: () => void): () => void {
  inlineValueListeners.add(listener);
  return () => void inlineValueListeners.delete(listener);
}

/**
 * Last known availability for the document (null until the first answer
 * arrives). Stale entries are returned while a fresh answer is fetched.
 */
export function availabilityFor(api: ViewFeatureApi, path: string, languageId: string): LanguagesExtraAvailability | null {
  const key = `${path}\0${languageId}`;
  let entry = availability.get(key);
  if (!entry) {
    entry = { version: -1, value: null, pending: false };
    availability.set(key, entry);
  }
  if (entry.version !== version && !entry.pending) {
    entry.pending = true;
    const asked = version;
    const current = entry;
    api
      .requestHost<LanguagesExtraAvailability>("availability", [path, languageId])
      .then((value) => {
        current.value = value;
        current.version = asked;
      })
      .catch(() => {
        current.version = asked;
      })
      .finally(() => {
        current.pending = false;
        // A change arrived while asking: ask again.
        if (current.version !== version) availabilityFor(api, path, languageId);
        else for (const listener of [...changeListeners]) listener();
      });
  }
  return entry.value;
}

/** The text editor the user used last (hierarchy commands start from its cursor). */
let lastEditor: { view: EditorView; path: string; languageId: string } | null = null;

export function setLastEditor(editor: { view: EditorView; path: string; languageId: string }): void {
  lastEditor = editor;
}

export function clearLastEditor(view: EditorView): void {
  if (lastEditor?.view === view) lastEditor = null;
}

export function getLastEditor(): { view: EditorView; path: string; languageId: string } | null {
  return lastEditor;
}

/** Does a provider's mime type filter (`[]` = everything) match one of the transferred types? */
export function mimeAccepted(patterns: string[], types: string[], hasFiles: boolean): boolean {
  if (!patterns.length) return true;
  return types.some((type) => {
    const mime = type.toLowerCase();
    return patterns.some((pattern) => {
      const p = pattern.toLowerCase();
      if (p === "files") return hasFiles;
      if (p === "*" || p === "*/*") return true;
      return p.endsWith("/*") ? mime.startsWith(p.slice(0, -1)) : mime === p;
    });
  });
}
