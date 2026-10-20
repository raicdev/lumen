import { NotebookCellData, NotebookCellOutputItem, NotebookRange } from "../../compat-types.ts";
import type { Uri } from "../../types.ts";

/**
 * Classes of the notebooks API that need more than the data-only stand-ins in
 * compat-types.ts: outputs with ids, edits that change metadata, the status
 * bar item and the enums only notebooks use.
 */

function enumOf<T extends Record<string, number>>(values: T): Readonly<T> & Readonly<Record<number, string>> {
  const result: Record<string | number, string | number> = { ...values };
  for (const [key, value] of Object.entries(values)) result[value] = key;
  return Object.freeze(result) as Readonly<T> & Readonly<Record<number, string>>;
}

export const NotebookEditorRevealType = enumOf({ Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 });
export const NotebookCellStatusBarAlignment = enumOf({ Left: 1, Right: 2 });

let outputSeq = 0;

export class NotebookCellOutput {
  readonly id: string;
  items: NotebookCellOutputItem[];
  metadata?: Record<string, unknown>;
  constructor(items: NotebookCellOutputItem[], metadata?: Record<string, unknown>) {
    this.id = `output-${++outputSeq}`;
    this.items = items;
    this.metadata = metadata;
  }
}

/** An edit of a notebook: replace cells, or change the metadata of a cell / the notebook. */
export class NotebookEdit {
  range: NotebookRange;
  newCells: NotebookCellData[];
  newCellMetadata?: Record<string, unknown>;
  newNotebookMetadata?: Record<string, unknown>;
  constructor(range: NotebookRange, newCells: NotebookCellData[]) {
    this.range = range;
    this.newCells = newCells;
  }
  static replaceCells(range: NotebookRange, newCells: NotebookCellData[]): NotebookEdit {
    return new NotebookEdit(range, newCells);
  }
  static insertCells(index: number, newCells: NotebookCellData[]): NotebookEdit {
    return new NotebookEdit(new NotebookRange(index, index), newCells);
  }
  static deleteCells(range: NotebookRange): NotebookEdit {
    return new NotebookEdit(range, []);
  }
  static updateCellMetadata(index: number, newCellMetadata: Record<string, unknown>): NotebookEdit {
    const edit = new NotebookEdit(new NotebookRange(index, index), []);
    edit.newCellMetadata = newCellMetadata;
    return edit;
  }
  static updateNotebookMetadata(newNotebookMetadata: Record<string, unknown>): NotebookEdit {
    const edit = new NotebookEdit(new NotebookRange(0, 0), []);
    edit.newNotebookMetadata = newNotebookMetadata;
    return edit;
  }
}

export class NotebookCellStatusBarItem {
  text: string;
  alignment: number;
  command?: string | { command: string; title?: string; arguments?: unknown[] };
  tooltip?: string;
  priority?: number;
  accessibilityInformation?: { label: string; role?: string };
  constructor(text: string, alignment: number) {
    this.text = text;
    this.alignment = alignment;
  }
}

export class TabInputNotebookDiff {
  readonly original: Uri;
  readonly modified: Uri;
  readonly notebookType: string;
  constructor(original: Uri, modified: Uri, notebookType: string) {
    this.original = original;
    this.modified = modified;
    this.notebookType = notebookType;
  }
}

/** The `Tab.input` of an Interactive Window. */
export class TabInputInteractiveWindow {
  readonly uri: Uri;
  readonly inputBoxUri: Uri;
  constructor(uri: Uri, inputBoxUri: Uri) {
    this.uri = uri;
    this.inputBoxUri = inputBoxUri;
  }
}
