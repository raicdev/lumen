import { RangeSetBuilder, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { HostInlayHint } from "../../shared/extensions";
import { extensionService } from "./extensions";

/**
 * Inlay hints from extensions (languages.registerInlayHintsProvider): small
 * inline widgets ("x: number") shown for the visible range. They are refreshed
 * after edits and scrolling (debounced), and when a provider asks to be asked
 * again through onDidChangeInlayHints.
 */

export const setExtensionInlayHints = StateEffect.define<DecorationSet>();

export const extensionInlayHintsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setExtensionInlayHints)) return effect.value;
    // Hints are positions in the text: keep them next to their text across edits.
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

class InlayHintWidget extends WidgetType {
  readonly hint: HostInlayHint;
  constructor(hint: HostInlayHint) {
    super();
    this.hint = hint;
  }
  eq(other: InlayHintWidget) {
    return JSON.stringify(this.hint) === JSON.stringify(other.hint);
  }
  toDOM() {
    const span = document.createElement("span");
    const classes = ["cm-ext-inlay-hint"];
    if (this.hint.kind) classes.push(`cm-ext-inlay-hint-${this.hint.kind}`);
    if (this.hint.paddingLeft) classes.push("cm-ext-inlay-hint-pad-left");
    if (this.hint.paddingRight) classes.push("cm-ext-inlay-hint-pad-right");
    span.className = classes.join(" ");
    span.textContent = this.hint.label;
    if (this.hint.tooltip) span.title = this.hint.tooltip;
    return span;
  }
  ignoreEvent() {
    return true;
  }
}

function offset(doc: Text, line: number, character: number): number {
  const target = doc.line(Math.min(Math.max(1, line + 1), doc.lines));
  return Math.min(target.from + Math.max(0, character), target.to);
}

/** Hints as inline widgets at their positions. */
export function buildInlayHints(doc: Text, hints: HostInlayHint[]): DecorationSet {
  const items: { from: number; decoration: Decoration; order: number }[] = [];
  let order = 0;
  for (const hint of hints) {
    const from = offset(doc, hint.line, hint.character);
    items.push({ from, decoration: Decoration.widget({ widget: new InlayHintWidget(hint), side: 1 }), order: order++ });
  }
  // RangeSetBuilder needs ranges sorted by position.
  items.sort((a, b) => a.from - b.from || a.order - b.order);
  const builder = new RangeSetBuilder<Decoration>();
  for (const item of items) builder.add(item.from, item.from, item.decoration);
  return builder.finish();
}

/** The document inlay hints are asked for (null when no editor document is shown). */
export type InlayHintsSource = () => { path: string; language: string } | null;

/** The range the viewport shows, as 0-based lines and characters. */
function visibleRange(view: EditorView): { startLine: number; startCharacter: number; endLine: number; endCharacter: number } {
  const doc = view.state.doc;
  const start = view.visibleRanges[0]?.from ?? 0;
  const end = view.visibleRanges[view.visibleRanges.length - 1]?.to ?? doc.length;
  const startLine = doc.lineAt(Math.min(start, doc.length));
  const endLine = doc.lineAt(Math.min(end, doc.length));
  return { startLine: startLine.number - 1, startCharacter: start - startLine.from, endLine: endLine.number - 1, endCharacter: end - endLine.from };
}

export function inlayHintsExtension(source: InlayHintsSource): Extension {
  return [
    extensionInlayHintsField,
    ViewPlugin.fromClass(
      class {
        readonly view: EditorView;
        private timer: ReturnType<typeof setTimeout> | null = null;
        private destroyed = false;
        private readonly onChanged = () => this.schedule();

        constructor(view: EditorView) {
          this.view = view;
          window.addEventListener("lumen:ext-inlay-hints", this.onChanged);
          window.addEventListener("lumen:ext-providers", this.onChanged);
          this.schedule();
        }

        update(update: ViewUpdate) {
          if (update.docChanged || update.viewportChanged) this.schedule();
        }

        destroy() {
          this.destroyed = true;
          window.removeEventListener("lumen:ext-inlay-hints", this.onChanged);
          window.removeEventListener("lumen:ext-providers", this.onChanged);
          if (this.timer) clearTimeout(this.timer);
        }

        private schedule() {
          if (this.timer) clearTimeout(this.timer);
          this.timer = setTimeout(() => {
            this.timer = null;
            void this.refresh();
          }, 300);
        }

        private clear() {
          if (this.view.state.field(extensionInlayHintsField, false)?.size) {
            this.view.dispatch({ effects: setExtensionInlayHints.of(Decoration.none) });
          }
        }

        private async refresh() {
          const target = source();
          if (!target) {
            this.clear();
            return;
          }
          if (!extensionService.providersFor("inlayHints", target.path, target.language).length) {
            this.clear();
            return;
          }
          const view = this.view;
          let hints: HostInlayHint[];
          try {
            hints = await extensionService.call("provideInlayHints", target.path, visibleRange(view));
          } catch {
            return;
          }
          if (this.destroyed || this.view !== view || !view.dom.isConnected) return;
          const current = source();
          if (!current || current.path !== target.path) return;
          view.dispatch({ effects: setExtensionInlayHints.of(buildInlayHints(view.state.doc, hints)) });
        }
      },
    ),
  ];
}
