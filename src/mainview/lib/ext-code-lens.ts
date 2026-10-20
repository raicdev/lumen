import { RangeSetBuilder, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { HostCodeLens } from "../../shared/extensions";
import { extensionService } from "./extensions";
import { getSettings, onSettingsChange } from "./settings";

/**
 * Code lenses from extensions (languages.registerCodeLensProvider): small dim
 * actions above the line they belong to. They are fetched when a document
 * opens, after edits (debounced), when a provider asks for a refresh
 * (onDidChangeCodeLenses) and when the editor.codeLens setting changes.
 */

export const setExtensionCodeLenses = StateEffect.define<DecorationSet>();

export const extensionCodeLensesField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setExtensionCodeLenses)) return effect.value;
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** One line's lenses: "title | title", each part clickable. */
class CodeLensWidget extends WidgetType {
  readonly lenses: HostCodeLens[];
  constructor(lenses: HostCodeLens[]) {
    super();
    this.lenses = lenses;
  }
  eq(other: CodeLensWidget) {
    return (
      other.lenses.length === this.lenses.length &&
      this.lenses.every((lens, index) => {
        const otherLens = other.lenses[index];
        return !!otherLens && lens.id === otherLens.id && lens.title === otherLens.title && lens.tooltip === otherLens.tooltip;
      })
    );
  }
  toDOM() {
    const dom = document.createElement("div");
    dom.className = "cm-ext-codelens";
    this.lenses.forEach((lens, index) => {
      if (index) dom.appendChild(document.createTextNode(" | "));
      const item = document.createElement("span");
      item.className = "cm-ext-codelens-item";
      item.textContent = lens.title;
      if (lens.tooltip) item.title = lens.tooltip;
      // The lens runs a command: the click must not reach the editor.
      item.addEventListener("mousedown", (event) => event.preventDefault());
      item.addEventListener("click", (event) => {
        event.preventDefault();
        extensionService.call("runCodeLens", lens.id).catch(() => {});
      });
      dom.appendChild(item);
    });
    return dom;
  }
  ignoreEvent() {
    return false;
  }
}

/** Group the lenses by line and place one widget above each of them. */
export function buildExtensionCodeLenses(doc: Text, lenses: HostCodeLens[]): DecorationSet {
  const byLine = new Map<number, HostCodeLens[]>();
  for (const lens of lenses) {
    const line = Math.min(Math.max(0, lens.line), doc.lines - 1) + 1;
    const list = byLine.get(line);
    if (list) list.push(lens);
    else byLine.set(line, [lens]);
  }
  const builder = new RangeSetBuilder<Decoration>();
  for (const line of [...byLine.keys()].sort((a, b) => a - b)) {
    const from = doc.line(line).from;
    builder.add(from, from, Decoration.widget({ widget: new CodeLensWidget(byLine.get(line)!), block: true, side: -1 }));
  }
  return builder.finish();
}

/** The document the lenses are for (null when no editor document is shown). */
export type CodeLensSource = () => { path: string; language: string } | null;

/** Edits close together must not ask for the lenses again and again. */
const DEBOUNCE = 500;

class CodeLensPlugin {
  readonly view: EditorView;
  readonly #source: CodeLensSource;
  readonly #unsubscribeSettings: () => void;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #sequence = 0;
  #path: string | null = null;

  constructor(view: EditorView, source: CodeLensSource) {
    this.view = view;
    this.#source = source;
    this.#unsubscribeSettings = onSettingsChange(() => this.refresh());
    window.addEventListener("lumen:ext-codelens", this.refresh);
    window.addEventListener("lumen:ext-providers", this.refresh);
    this.refresh();
  }

  update(update: ViewUpdate) {
    if (update.docChanged) this.#debounce();
    else if ((this.#source()?.path ?? null) !== this.#path) this.refresh();
  }

  destroy() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#unsubscribeSettings();
    window.removeEventListener("lumen:ext-codelens", this.refresh);
    window.removeEventListener("lumen:ext-providers", this.refresh);
  }

  /** Fetch the lenses again right away. */
  readonly refresh = () => {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    void this.#fetch();
  };

  #debounce() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#fetch();
    }, DEBOUNCE);
  }

  async #fetch() {
    // Never dispatch while the constructor (or an update) is still running.
    await Promise.resolve();
    const view = this.view;
    const current = this.#source();
    const sequence = ++this.#sequence;
    this.#path = current?.path ?? null;
    if (!current || !getSettings()["editor.codeLens"] || !extensionService.providersFor("codeLens", current.path, current.language).length) {
      view.dispatch({ effects: setExtensionCodeLenses.of(Decoration.none) });
      return;
    }
    let lenses: HostCodeLens[];
    try {
      lenses = await extensionService.call("provideCodeLenses", current.path);
    } catch {
      return;
    }
    if (this.#sequence !== sequence || !view.dom.isConnected) return;
    if (this.#source()?.path !== current.path) return;
    view.dispatch({ effects: setExtensionCodeLenses.of(buildExtensionCodeLenses(view.state.doc, lenses)) });
  }
}

export function codeLensExtension(source: CodeLensSource): Extension {
  return [extensionCodeLensesField, ViewPlugin.define((view) => new CodeLensPlugin(view, source))];
}
