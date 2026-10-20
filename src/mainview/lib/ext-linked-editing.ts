import { EditorState, StateEffect, StateField, type Extension, type Text, type Transaction } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { HostLinkedEditingRanges } from "../../shared/extensions";
import type { TextRange } from "../../shared/types";
import { extensionService } from "./extensions";
import { getSettings } from "./settings";

/**
 * Linked editing from extensions (languages.registerLinkedEditingRangeProvider):
 * the ranges that mirror each other (HTML/JSX open and close tags, for example)
 * are requested once the cursor rests in a word; while the cursor stays inside
 * one of them, typing or deleting mirrors the same change into the others as a
 * single transaction.
 */

/** The document the editor is showing (null when none). */
export type LinkedEditingSource = () => { path: string; language: string } | null;

type Range = { from: number; to: number };
type Change = { from: number; to: number; insert: string };

const setLinkedRanges = StateEffect.define<Range[] | null>();

const linkedRangesField = StateField.define<Range[] | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setLinkedRanges)) return effect.value;
    if (!value || !tr.docChanged) return value;
    // An edit at a boundary extends the range to include the new text.
    return value.map((range) => ({ from: tr.changes.mapPos(range.from, -1), to: tr.changes.mapPos(range.to, 1) }));
  },
});

/** Offset of a 0-based line / character position. */
function offsetAt(doc: Text, line: number, character: number): number {
  const target = doc.line(Math.min(Math.max(1, line + 1), doc.lines));
  return Math.min(target.from + Math.max(0, character), target.to);
}

function offsetsOf(doc: Text, range: TextRange): Range {
  const from = offsetAt(doc, range.startLine, range.startCharacter);
  return { from, to: Math.max(from, offsetAt(doc, range.endLine, range.endCharacter)) };
}

/** The changes of a transaction, in the coordinates of its start document. */
function changeSpecs(tr: Transaction): Change[] {
  const changes: Change[] = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => changes.push({ from: fromA, to: toA, insert: inserted.toString() }));
  return changes;
}

/** The same changes applied to every other linked range (empty when the edit is not linked). */
function mirrorChanges(tr: Transaction, ranges: Range[]): Change[] {
  const changes = changeSpecs(tr);
  if (!changes.length) return [];
  // The whole edit has to sit inside one linked range (usually a single character).
  const source = ranges.find((range) => changes.every((change) => change.from >= range.from && change.to <= range.to));
  if (!source) return [];
  const mirrored: Change[] = [];
  for (const range of ranges) {
    if (range === source) continue;
    for (const change of changes) {
      mirrored.push({ from: range.from + (change.from - source.from), to: range.from + (change.to - source.from), insert: change.insert });
    }
  }
  return mirrored;
}

export function linkedEditingExtension(source: LinkedEditingSource): Extension {
  return [
    linkedRangesField,
    EditorState.transactionFilter.of((tr) => {
      if (!tr.docChanged || (!tr.isUserEvent("input") && !tr.isUserEvent("delete"))) return tr;
      if (!getSettings()["editor.linkedEditing"]) return tr;
      const ranges = tr.startState.field(linkedRangesField, false);
      if (!ranges || ranges.length < 2) return tr;
      const changes = mirrorChanges(tr, ranges);
      return changes.length ? [tr, { changes }] : tr;
    }),
    ViewPlugin.fromClass(
      class {
        readonly view: EditorView;
        private timer: ReturnType<typeof setTimeout> | null = null;
        private sequence = 0;

        constructor(view: EditorView) {
          this.view = view;
        }

        update(update: ViewUpdate) {
          const target = source();
          if (!target || !this.available(target)) {
            this.invalidate();
            this.clear();
            return;
          }
          // An edit refreshes the ranges (debounced); moving within one keeps it.
          if (update.docChanged) {
            this.schedule();
            return;
          }
          if (update.selectionSet && this.inside()) {
            this.invalidate();
            return;
          }
          if (update.selectionSet) this.schedule();
        }

        destroy() {
          this.invalidate();
        }

        private available(target: { path: string; language: string }): boolean {
          return getSettings()["editor.linkedEditing"] && extensionService.providersFor("linkedEditingRange", target.path, target.language).length > 0;
        }

        private inside(): boolean {
          const ranges = this.view.state.field(linkedRangesField, false);
          if (!ranges) return false;
          const head = this.view.state.selection.main.head;
          return ranges.some((range) => head >= range.from && head <= range.to);
        }

        /** Drop the ranges (and any in-flight request). */
        private invalidate() {
          this.sequence++;
          if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
          }
        }

        private clear() {
          if (this.view.state.field(linkedRangesField, false)) this.view.dispatch({ effects: setLinkedRanges.of(null) });
        }

        /** Ask for the ranges once the cursor settles (200 ms), like VS Code. */
        private schedule() {
          this.invalidate();
          const id = this.sequence;
          this.timer = setTimeout(() => {
            this.timer = null;
            void this.request(id);
          }, 200);
        }

        private async request(id: number) {
          const view = this.view;
          const target = source();
          if (!target) return;
          const head = view.state.selection.main.head;
          const line = view.state.doc.lineAt(head);
          let result: HostLinkedEditingRanges | null;
          try {
            result = await extensionService.call("provideLinkedEditingRanges", target.path, line.number - 1, head - line.from);
          } catch {
            return;
          }
          // A newer request (or the cursor leaving) makes this one stale.
          if (this.sequence !== id || !view.dom.isConnected) return;
          const current = source();
          if (!current || current.path !== target.path || !this.available(current)) return;
          const ranges = result?.ranges?.map((range) => offsetsOf(view.state.doc, range)).filter((range) => range.to > range.from) ?? [];
          view.dispatch({ effects: setLinkedRanges.of(ranges.length > 1 ? ranges : null) });
        }
      },
    ),
  ];
}
