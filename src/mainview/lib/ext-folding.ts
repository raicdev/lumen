import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { foldService } from "@codemirror/language";
import type { HostFoldingRange } from "../../shared/extensions";
import { extensionService } from "./extensions";

/**
 * Folding ranges from extensions (languages.registerFoldingRangeProvider): a
 * CodeMirror fold service backed by the ranges the provider returned for the
 * current document. They are fetched when a document opens, after edits
 * (debounced), and when providers change; with no matching provider the
 * language's own folding is used.
 */

/** The cached ranges (`null`: none, fall back to the language's folding). */
const setFoldingRanges = StateEffect.define<HostFoldingRange[] | null>();

const foldingRangesField = StateField.define<HostFoldingRange[] | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setFoldingRanges)) return effect.value;
    // Line numbers shift on edits: wait for the refresh instead of folding wrong lines.
    return tr.docChanged ? null : value;
  },
});

/**
 * A fold service over the cached ranges: a range start..end (0-based lines)
 * folds from the end of the start line through the end of the end line.
 */
const extensionFoldService = foldService.of((state, lineStart) => {
  const ranges = state.field(foldingRangesField, false);
  if (!ranges) return null;
  const line = state.doc.lineAt(lineStart);
  const start = line.number - 1;
  for (const range of ranges) {
    if (range.start !== start || range.end <= start) continue;
    const to = state.doc.line(Math.min(range.end + 1, state.doc.lines)).to;
    if (to > line.to) return { from: line.to, to };
  }
  return null;
});

/** The document the ranges are for (null when no editor document is shown). */
export type FoldingSource = () => { path: string; language: string } | null;

/** Edits close together must not ask for the ranges again and again. */
const DEBOUNCE = 500;

class FoldingPlugin {
  readonly view: EditorView;
  readonly #source: FoldingSource;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #sequence = 0;
  #path: string | null = null;

  constructor(view: EditorView, source: FoldingSource) {
    this.view = view;
    this.#source = source;
    window.addEventListener("lumen:ext-providers", this.refresh);
    this.refresh();
  }

  update(update: ViewUpdate) {
    if (update.docChanged) this.#debounce();
    else if ((this.#source()?.path ?? null) !== this.#path) this.refresh();
  }

  destroy() {
    if (this.#timer) clearTimeout(this.#timer);
    window.removeEventListener("lumen:ext-providers", this.refresh);
  }

  /** Fetch the ranges again right away. */
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
    if (!current || !extensionService.providersFor("foldingRange", current.path, current.language).length) {
      if (view.state.field(foldingRangesField, false)) view.dispatch({ effects: setFoldingRanges.of(null) });
      return;
    }
    let ranges: HostFoldingRange[];
    try {
      ranges = await extensionService.call("provideFoldingRanges", current.path);
    } catch {
      return;
    }
    if (this.#sequence !== sequence || !view.dom.isConnected) return;
    if (this.#source()?.path !== current.path) return;
    view.dispatch({ effects: setFoldingRanges.of(ranges) });
  }
}

export function foldingExtension(source: FoldingSource): Extension {
  return [foldingRangesField, extensionFoldService, ViewPlugin.define((view) => new FoldingPlugin(view, source))];
}
