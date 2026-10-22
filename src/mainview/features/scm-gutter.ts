import { RangeSet, StateEffect, StateField } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter } from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";
import { computeLineChanges, vscodeLineChanges } from "../../shared/scm-diff";
import type { ScmLineChange } from "../../shared/scm-diff";
import { scmStore } from "./scm-store";
import type { ViewFeatureApi } from "./types";
import { showContributedMenu, uriArg } from "./menus-walkthroughs/menus";

/**
 * Quick diff: a gutter next to the line numbers that marks lines changed against
 * the text a source control's quickDiffProvider returns. Clicking a mark shows
 * the `scm/change/title` menu of that change (VS Code shows it on the peek
 * widget of a change); its commands get the resource, all changes and the index.
 */

class ChangeMarker extends GutterMarker {
  readonly kind: ScmLineChange["kind"];
  constructor(kind: ScmLineChange["kind"]) {
    super();
    this.kind = kind;
  }
  eq(other: GutterMarker): boolean {
    return other instanceof ChangeMarker && other.kind === this.kind;
  }
  toDOM(): Node {
    const element = document.createElement("div");
    element.className = `scm-quickdiff scm-quickdiff-${this.kind}`;
    return element;
  }
}

const markers = { added: new ChangeMarker("added"), modified: new ChangeMarker("modified"), deleted: new ChangeMarker("deleted") };

const setChanges = StateEffect.define<ScmLineChange[]>();

const changesField = StateField.define<ScmLineChange[]>({
  create: () => [],
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setChanges)) return effect.value;
    return value;
  },
});

function markerSet(view: EditorView) {
  const doc = view.state.doc;
  const ranges = [];
  const seen = new Set<number>();
  for (const change of view.state.field(changesField)) {
    if (change.kind === "deleted") {
      // Mark the line after the removed lines (or the first line when they were at the top).
      const line = Math.min(doc.lines, Math.max(1, change.line + 1));
      if (!seen.has(line)) {
        seen.add(line);
        ranges.push(markers.deleted.range(doc.line(line).from));
      }
      continue;
    }
    for (let line = change.line; line < change.line + change.count && line <= doc.lines; line++) {
      if (seen.has(line)) continue;
      seen.add(line);
      ranges.push(markers[change.kind].range(doc.line(line).from));
    }
  }
  return RangeSet.of(ranges, true);
}

export function quickDiffExtension(path: string, api: ViewFeatureApi): Extension[] {
  const plugin = ViewPlugin.fromClass(
    class {
      #original: string | null = null;
      #timer: ReturnType<typeof setTimeout> | null = null;
      #token = 0;
      #unsubscribe: () => void;
      #view: EditorView;

      constructor(view: EditorView) {
        this.#view = view;
        void this.#fetch();
        // A source control changed (a commit, a new base): ask for the base text again.
        let lastSignature = this.#signature();
        this.#unsubscribe = scmStore.subscribe(() => {
          const signature = this.#signature();
          if (signature === lastSignature) return;
          lastSignature = signature;
          void this.#fetch();
        });
      }

      #signature(): string {
        return scmStore
          .get()
          .controls.filter((control) => control.hasQuickDiff)
          .map((control) => `${control.handle}:${control.groups.map((group) => group.resources.map((resource) => resource.path).join(",")).join("|")}`)
          .join(";");
      }

      async #fetch() {
        const token = ++this.#token;
        let original: string | null = null;
        if (scmStore.get().controls.some((control) => control.hasQuickDiff)) {
          try {
            original = await api.requestHost<string | null>("quickDiff", [path]);
          } catch {
            original = null;
          }
        }
        if (token !== this.#token) return;
        this.#original = original;
        this.#compute();
      }

      /** The changes in VS Code's `LineChange` form and the index of the one at `line` (1-based), or null. */
      changeAt(line: number): { changes: ReturnType<typeof vscodeLineChanges>; index: number } | null {
        if (this.#original === null) return null;
        const changes = vscodeLineChanges(this.#original, this.#view.state.doc.toString());
        const index = changes.findIndex((change) =>
          change.modifiedEndLineNumber === 0
            ? line === change.modifiedStartLineNumber + 1 || (change.modifiedStartLineNumber === 0 && line === 1)
            : line >= change.modifiedStartLineNumber && line <= change.modifiedEndLineNumber,
        );
        return index < 0 ? null : { changes, index };
      }

      #compute() {
        const changes = this.#original === null ? [] : computeLineChanges(this.#original, this.#view.state.doc.toString());
        // Runs from a timer / promise, never inside a view update.
        this.#view.dispatch({ effects: setChanges.of(changes) });
      }

      update(update: ViewUpdate) {
        if (!update.docChanged || this.#original === null) return;
        if (this.#timer) clearTimeout(this.#timer);
        this.#timer = setTimeout(() => this.#compute(), 250);
      }

      destroy() {
        this.#token++;
        if (this.#timer) clearTimeout(this.#timer);
        this.#unsubscribe();
      }
    },
  );
  const lookup = (key: string): unknown => {
    switch (key) {
      case "resource":
      case "resourcePath":
        return path;
      case "resourceScheme":
      case "originalResourceScheme":
        return /^\w[\w+.-]+:/.test(path) && !/^[a-zA-Z]:[\\/]/.test(path) ? path.slice(0, path.indexOf(":")) : "file";
      case "scmProvider":
        return scmStore.get().controls.find((control) => control.hasQuickDiff)?.id;
      default:
        return undefined;
    }
  };
  const changeMenu = gutter({
    class: "cm-scm-gutter",
    markers: markerSet,
    domEventHandlers: {
      mousedown(view, block, event) {
        const at = view.plugin(plugin)?.changeAt(view.state.doc.lineAt(block.from).number);
        if (!at) return false;
        return showContributedMenu(event as MouseEvent, "scm/change/title", lookup, [uriArg(path), at.changes, at.index]);
      },
    },
  });
  return [changesField, plugin, changeMenu];
}
