import { RangeSet, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter, type ViewUpdate } from "@codemirror/view";
import type { Diagnostic, TextRange } from "../../shared/types";
import type { HostCodeAction } from "../../shared/extensions";
import { extensionService } from "./extensions";
import { showContextMenu, type ContextMenuItem } from "./context-menu";
import { t } from "./i18n";

/**
 * Code actions from extensions (languages.registerCodeActionsProvider): a
 * lightbulb in the gutter on the cursor's line while actions exist. Ctrl+.
 * (editor.action.quickFix) and a click on the lightbulb open a menu; the
 * chosen action's WorkspaceEdit and command are applied by the host.
 */

/** The document code actions are asked for (null when no editor document is shown). */
export type CodeActionsSource = () => { path: string; language: string } | null;

/** The cursor must settle before the lightbulb appears. */
const REQUEST_DEBOUNCE = 300;

/** The requested range: the selection, or the word at the cursor when it is empty. */
function actionRange(view: EditorView): TextRange {
  const state = view.state;
  const selection = state.selection.main;
  const target = selection.empty ? (state.wordAt(selection.head) ?? selection) : selection;
  const from = state.doc.lineAt(target.from);
  const to = state.doc.lineAt(target.to);
  return {
    startLine: from.number - 1,
    startCharacter: target.from - from.from,
    endLine: to.number - 1,
    endCharacter: target.to - to.from,
  };
}

/** Whether two ranges (0-based lines / characters) touch or overlap. */
function rangesOverlap(a: TextRange, b: TextRange): boolean {
  const endsBefore = (x: TextRange, y: TextRange) => x.endLine < y.startLine || (x.endLine === y.startLine && x.endCharacter < y.startCharacter);
  return !endsBefore(a, b) && !endsBefore(b, a);
}

/** The diagnostics the view knows for `path` that touch the range (provider context). */
function diagnosticsInRange(path: string, range: TextRange): Diagnostic[] {
  const all = extensionService.getSnapshot().diagnostics.get(extensionService.viewPath(path)) ?? [];
  return all.filter((diagnostic) => rangesOverlap(diagnostic, range));
}

/** Ask the host for the code actions at the cursor / selection (empty when none). */
export async function fetchCodeActions(view: EditorView, source: CodeActionsSource): Promise<HostCodeAction[]> {
  const current = source();
  if (!current) return [];
  if (!extensionService.providersFor("codeAction", current.path, current.language).length) return [];
  const range = actionRange(view);
  try {
    return await extensionService.call("provideCodeActions", current.path, range, diagnosticsInRange(current.path, range));
  } catch {
    return [];
  }
}

/** Open the code action menu at a screen position; the chosen action runs in the host. */
export function openCodeActionsMenu(x: number, y: number, actions: HostCodeAction[]): void {
  if (!actions.length) return;
  const items: ContextMenuItem[] = actions.map((action) => ({
    type: "item",
    label: action.isPreferred ? `${action.title}  (preferred)` : action.title,
    action: action.id,
    disabled: !!action.disabled,
  }));
  void showContextMenu(x, y, items).then((id) => {
    if (id) extensionService.call("runCodeAction", id).catch(() => {});
  });
}

/** Screen position of the cursor (falls back to the editor's top-left corner). */
function cursorPosition(view: EditorView): { x: number; y: number } {
  const coords = view.coordsAtPos(view.state.selection.main.head);
  if (coords) return { x: coords.left, y: coords.bottom };
  const rect = view.dom.getBoundingClientRect();
  return { x: rect.left + 24, y: rect.top + 24 };
}

/** Ctrl+. (editor.action.quickFix): show the actions at the cursor / selection. */
export async function runQuickFix(view: EditorView, source: CodeActionsSource): Promise<void> {
  const actions = await fetchCodeActions(view, source);
  if (!view.dom.isConnected || !actions.length) return;
  const { x, y } = cursorPosition(view);
  openCodeActionsMenu(x, y, actions);
}

/** The lightbulb marker: clicking it opens the menu for the actions it holds. */
class LightbulbMarker extends GutterMarker {
  readonly actions: HostCodeAction[];
  constructor(actions: HostCodeAction[]) {
    super();
    this.actions = actions;
  }
  eq(other: GutterMarker) {
    return (
      other instanceof LightbulbMarker &&
      other.actions.length === this.actions.length &&
      other.actions.every((action, index) => action.id === this.actions[index]?.id)
    );
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = "cm-code-action-lightbulb";
    el.textContent = "💡";
    el.title = this.actions.length === 1 ? this.actions[0]!.title : t("Show Code Actions");
    el.addEventListener("mousedown", (event) => event.preventDefault());
    el.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const rect = el.getBoundingClientRect();
      openCodeActionsMenu(rect.right + 2, rect.bottom, this.actions);
    });
    return el;
  }
}

type LightbulbState = { position: number; marker: GutterMarker } | null;

const setLightbulb = StateEffect.define<LightbulbState>();

const lightbulbField = StateField.define<LightbulbState>({
  create: () => null,
  update(value, tr) {
    let next = value;
    for (const effect of tr.effects) if (effect.is(setLightbulb)) next = effect.value;
    if (next === value) return value;
    // Keep the lightbulb on the line it was shown for across edits.
    return next && tr.docChanged ? { position: tr.changes.mapPos(next.position, -1), marker: next.marker } : next;
  },
});

const lightbulbGutter = gutter({
  class: "cm-code-action-gutter",
  markers: (view) => {
    const state = view.state.field(lightbulbField, false);
    if (!state) return RangeSet.empty;
    const doc = view.state.doc;
    const line = doc.lineAt(Math.min(Math.max(0, state.position), doc.length));
    return RangeSet.of([state.marker.range(line.from)]);
  },
});

class CodeActionsPlugin {
  readonly view: EditorView;
  readonly #source: CodeActionsSource;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #sequence = 0;
  #path: string | null = null;

  constructor(view: EditorView, source: CodeActionsSource) {
    this.view = view;
    this.#source = source;
    window.addEventListener("lumen:ext-providers", this.refresh);
    window.addEventListener("lumen:ext-diagnostics", this.refresh);
    this.#schedule();
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet) this.#schedule();
    else if ((this.#source()?.path ?? null) !== this.#path) this.refresh();
  }

  destroy() {
    if (this.#timer) clearTimeout(this.#timer);
    window.removeEventListener("lumen:ext-providers", this.refresh);
    window.removeEventListener("lumen:ext-diagnostics", this.refresh);
  }

  readonly refresh = () => {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    void this.#fetch();
  };

  #schedule() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#fetch();
    }, REQUEST_DEBOUNCE);
  }

  #set(state: LightbulbState) {
    this.view.dispatch({ effects: setLightbulb.of(state) });
  }

  #clear() {
    if (this.view.state.field(lightbulbField, false)) this.#set(null);
  }

  async #fetch() {
    // Never dispatch while the constructor (or an update) is still running.
    await Promise.resolve();
    const view = this.view;
    const current = this.#source();
    const sequence = ++this.#sequence;
    this.#path = current?.path ?? null;
    if (!current || !extensionService.providersFor("codeAction", current.path, current.language).length) {
      this.#clear();
      return;
    }
    const actions = await fetchCodeActions(view, this.#source);
    if (this.#sequence !== sequence || !view.dom.isConnected) return;
    if (this.#source()?.path !== current.path) return;
    if (!actions.length) {
      this.#clear();
      return;
    }
    this.#set({ position: view.state.selection.main.head, marker: new LightbulbMarker(actions) });
  }
}

/** The lightbulb in the gutter, refreshed as the cursor settles. */
export function codeActionsExtension(source: CodeActionsSource): Extension {
  return [lightbulbField, lightbulbGutter, ViewPlugin.define((view) => new CodeActionsPlugin(view, source))];
}
