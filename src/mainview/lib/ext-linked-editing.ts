import { EditorState, StateEffect, StateField, type Extension, type Text, type Transaction } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { HostLinkedEditingRanges } from "../../shared/extensions";
import type { TextRange } from "../../shared/types";
import { extensionService } from "./extensions";
import { getSettings } from "./settings";

/**
 * Linked editing from extensions (languages.registerLinkedEditingRangeProvider):
 * the ranges that mirror each other (HTML/JSX open and close tags, for example)
 * are requested once the cursor rests in a word; while the cursor stays inside
 * one of them, typing or deleting mirrors the same change into the others as a
 * single transaction. The ranges are highlighted while they are linked, and an
 * edit that leaves the range no longer matching the word pattern (the
 * provider's, else the language's) ends linked editing, like VS Code.
 */

/** The document the editor is showing (null when none). */
export type LinkedEditingSource = () => { path: string; language: string } | null;

type Range = { from: number; to: number };
type Change = { from: number; to: number; insert: string };
type Linked = { ranges: Range[]; wordPattern: RegExp | null };

const setLinkedRanges = StateEffect.define<Linked | null>();

const linkedMark = Decoration.mark({ class: "cm-ext-linked-editing" });

const linkedRangesField = StateField.define<Linked | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setLinkedRanges)) return effect.value;
    if (!value || !tr.docChanged) return value;
    // An edit at a boundary extends the range to include the new text.
    return { ...value, ranges: value.ranges.map((range) => mapRange(tr, range)) };
  },
  provide: (field) =>
    EditorView.decorations.from(field, (value) =>
      Decoration.set(
        (value?.ranges ?? []).filter((range) => range.to > range.from).map((range) => linkedMark.range(range.from, range.to)),
        true,
      ),
    ),
});

function mapRange(tr: Transaction, range: Range): Range {
  return { from: tr.changes.mapPos(range.from, -1), to: tr.changes.mapPos(range.to, 1) };
}

/** A word pattern from the host, made safe to reuse (no global / sticky state). */
function compilePattern(pattern: { source: string; flags: string } | undefined): RegExp | null {
  if (!pattern) return null;
  try {
    return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ""));
  } catch {
    return null;
  }
}

/** Whether the first match of the pattern covers the whole text (VS Code's test). */
function matchesWhole(text: string, pattern: RegExp): boolean {
  return (pattern.exec(text)?.[0].length ?? 0) === text.length;
}

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

/** The same changes applied to every other linked range. */
function mirrorChanges(changes: Change[], ranges: Range[], source: Range): Change[] {
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
      const linked = tr.startState.field(linkedRangesField, false);
      if (!linked || linked.ranges.length < 2) return tr;
      const changes = changeSpecs(tr);
      if (!changes.length) return tr;
      // The whole edit has to sit inside one linked range (usually a single character).
      const edited = linked.ranges.find((range) => changes.every((change) => change.from >= range.from && change.to <= range.to));
      if (!edited) return tr;
      if (linked.wordPattern) {
        const after = mapRange(tr, edited);
        // A space typed into a tag name, for example: stop mirroring.
        if (!matchesWhole(tr.newDoc.sliceString(after.from, after.to), linked.wordPattern)) return [tr, { effects: setLinkedRanges.of(null) }];
      }
      return [tr, { changes: mirrorChanges(changes, linked.ranges, edited) }];
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
          const linked = this.view.state.field(linkedRangesField, false);
          if (!linked) return false;
          const head = this.view.state.selection.main.head;
          return linked.ranges.some((range) => head >= range.from && head <= range.to);
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
          const wordPattern = compilePattern(result?.wordPattern ?? extensionService.languageConfiguration(current.language)?.wordPattern);
          view.dispatch({ effects: setLinkedRanges.of(ranges.length > 1 ? { ranges, wordPattern } : null) });
        }
      },
    ),
  ];
}
