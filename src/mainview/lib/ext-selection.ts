import { EditorSelection, type EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { selectParentSyntax, simplifySelection } from "@codemirror/commands";
import type { TextRange } from "../../shared/types";
import { extensionService } from "./extensions";
import { offsetOf } from "./text-edits";

/**
 * Selection ranges from extensions (languages.registerSelectionRangeProvider):
 * smartSelect.expand grows the selection to the next larger range the provider
 * returned (smartSelect.shrink walks back through them). Without a matching
 * provider the editor's own syntax selection is used.
 */

export type SelectionRangeSource = () => { path: string; language: string } | null;

type OffsetRange = { from: number; to: number };

type Expansion = {
  /** Nested ranges (offsets) per selection, innermost first. */
  chains: OffsetRange[][];
  /** Index into `chains` currently applied, per selection (-1: nothing found). */
  indexes: number[];
  /** The selection the expansion represents, to detect changes made by the user. */
  applied: OffsetRange[];
};

const expansions = new WeakMap<EditorView, Expansion>();
const sequences = new WeakMap<EditorView, number>();

/** The selection of `state` as plain from/to offsets. */
function selectionRanges(state: EditorState): OffsetRange[] {
  return state.selection.ranges.map((range) => ({ from: range.from, to: range.to }));
}

function sameRanges(a: OffsetRange[], b: OffsetRange[]): boolean {
  return a.length === b.length && a.every((range, index) => range.from === b[index]!.from && range.to === b[index]!.to);
}

/** A provider range as offsets (ordered). */
function offsetRange(text: string, range: TextRange): OffsetRange {
  const from = offsetOf(text, range.startLine, range.startCharacter);
  const to = offsetOf(text, range.endLine, range.endCharacter);
  return from <= to ? { from, to } : { from: to, to: from };
}

/** The index of the smallest range of `chain` that strictly contains `target`. */
function containing(chain: OffsetRange[], target: OffsetRange): number {
  for (let index = 0; index < chain.length; index++) {
    const range = chain[index]!;
    if (range.from <= target.from && range.to >= target.to && range.to - range.from > target.to - target.from) return index;
  }
  return -1;
}

function apply(view: EditorView, ranges: OffsetRange[], expansion: Expansion, indexes: number[]): void {
  view.dispatch({
    selection: EditorSelection.create(ranges.map((range) => EditorSelection.range(range.from, range.to))),
    scrollIntoView: true,
    userEvent: "select",
  });
  expansion.applied = ranges;
  expansion.indexes = indexes;
}

/** Grow the selection through an extension provider (the editor's own syntax without one). */
export async function expandSelection(view: EditorView, source: SelectionRangeSource): Promise<void> {
  const target = source();
  if (!target) return;
  if (!extensionService.providersFor("selectionRange", target.path, target.language).length) {
    selectParentSyntax(view);
    return;
  }
  const state = view.state;
  const current = selectionRanges(state);
  const existing = expansions.get(view);
  if (existing && sameRanges(existing.applied, current) && existing.indexes.every((index) => index >= 0)) {
    // Step each selection outwards through the chain we already have.
    const indexes = existing.indexes.map((index) => index + 1);
    const ranges = existing.chains.map((chain, index) => chain[indexes[index]!]);
    if (ranges.every((range) => range)) apply(view, ranges as OffsetRange[], existing, indexes);
    return;
  }
  const text = state.doc.toString();
  const positions = state.selection.ranges.map((range) => {
    const line = state.doc.lineAt(range.head);
    return { line: line.number - 1, character: range.head - line.from };
  });
  const sequence = (sequences.get(view) ?? 0) + 1;
  sequences.set(view, sequence);
  let result: TextRange[][];
  try {
    result = await extensionService.call("provideSelectionRanges", target.path, positions);
  } catch {
    return;
  }
  if (sequences.get(view) !== sequence || view.state !== state) return;
  const chains = positions.map((_position, index) => (result[index] ?? []).map((range) => offsetRange(text, range)));
  const indexes = current.map((range, index) => containing(chains[index] ?? [], range));
  // Where the provider offered nothing larger, keep the current selection.
  const ranges = current.map((range, index) => (indexes[index]! >= 0 ? chains[index]![indexes[index]!]! : range));
  const expansion: Expansion = { chains, indexes, applied: current };
  expansions.set(view, expansion);
  if (ranges.some((range, index) => range.from !== current[index]!.from || range.to !== current[index]!.to)) {
    apply(view, ranges, expansion, indexes);
  }
}

/** Shrink back through the expansion stack (or the editor's own syntax selection). */
export function shrinkSelection(view: EditorView): void {
  const current = selectionRanges(view.state);
  const existing = expansions.get(view);
  if (existing && sameRanges(existing.applied, current)) {
    const indexes = existing.indexes.map((index) => index - 1);
    const ranges = existing.chains.map((chain, index) => chain[indexes[index]!]);
    if (ranges.every((range) => range)) {
      apply(view, ranges as OffsetRange[], existing, indexes);
      return;
    }
  }
  expansions.delete(view);
  simplifySelection(view);
}
