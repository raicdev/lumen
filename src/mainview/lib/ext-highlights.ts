import { RangeSetBuilder, StateEffect, StateField, type Text } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import type { HostDocumentHighlight } from "../../shared/extensions";

/**
 * Document highlights an extension reported for the symbol at the cursor
 * (languages.registerDocumentHighlightProvider): subtle marks that appear once
 * the cursor rests and go away again when the document changes.
 */

export const setExtensionHighlights = StateEffect.define<DecorationSet>();

export const extensionHighlightsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setExtensionHighlights)) return effect.value;
    // Highlights are about one cursor position: an edit makes them stale.
    return tr.docChanged ? Decoration.none : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const readMark = Decoration.mark({ class: "cm-ext-highlight" });
const writeMark = Decoration.mark({ class: "cm-ext-highlight-write" });

function offset(doc: Text, line: number, character: number): number {
  const target = doc.line(Math.min(Math.max(1, line + 1), doc.lines));
  return Math.min(target.from + Math.max(0, character), target.to);
}

/** Highlight ranges as marks ("write" gets the stronger colour). */
export function buildExtensionHighlights(doc: Text, highlights: HostDocumentHighlight[]): DecorationSet {
  const items: { from: number; to: number; decoration: Decoration }[] = [];
  for (const highlight of highlights) {
    const from = offset(doc, highlight.range.startLine, highlight.range.startCharacter);
    const to = Math.max(from, offset(doc, highlight.range.endLine, highlight.range.endCharacter));
    if (to <= from) continue;
    items.push({ from, to, decoration: highlight.kind === "write" ? writeMark : readMark });
  }
  // RangeSetBuilder needs ranges sorted by position.
  items.sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const item of items) builder.add(item.from, item.to, item.decoration);
  return builder.finish();
}

/** Show the highlights an extension reported. */
export function showExtensionHighlights(view: EditorView, highlights: HostDocumentHighlight[]) {
  view.dispatch({ effects: setExtensionHighlights.of(buildExtensionHighlights(view.state.doc, highlights)) });
}

/** Drop the highlights (no provider matched, or the request failed). */
export function clearExtensionHighlights(view: EditorView) {
  view.dispatch({ effects: setExtensionHighlights.of(Decoration.none) });
}
