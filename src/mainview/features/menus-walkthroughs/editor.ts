import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, showPanel, type Panel } from "@codemirror/view";
import { flattenMenu, parseResourceKey, type ResolvedMenuItem } from "../../../shared/menus-walkthroughs";
import { registerMenuAugmenter, showContextMenu, type ContextMenuItem } from "../../lib/context-menu";
import { extensionService } from "../../lib/extensions";
import { basename, dirname } from "../../lib/paths";
import { contributedMenuItems, resolveContributedMenu, runMenuCommand, toContextItems, uriArg } from "./menus";
import { resourceLabel } from "./state";

/**
 * Menus in the text editor: `editor/context` (right click, with the
 * `editor/context/copy` "Copy As" submenu), `editor/lineNumber/context` (right
 * click on the line numbers), `editor/title` and `editor/title/run` (action
 * strip above the editor; also shows the label of non-file resources as their
 * resourceLabelFormatters say), `editor/title/context` (items added to the tab
 * menu) and `explorer/context` (items added to the explorer's own menu).
 */

/** Context keys of a resource without an editor (tabs): the ones of `editorLookup`. */
export function resourceLookup(path: string): (key: string) => unknown {
  return editorLookup(path, extensionService.documentLanguage(path) ?? "", null);
}

/** Context keys of an editor (the ones menus' when clauses use most). */
function editorLookup(path: string, languageId: string, view: EditorView | null): (key: string) => unknown {
  const resource = parseResourceKey(path);
  const scheme = path.startsWith("untitled:") ? "untitled" : (resource?.scheme ?? "file");
  return (key) => {
    switch (key) {
      case "resource":
      case "resourcePath":
        return path;
      case "resourceScheme":
        return scheme;
      case "resourceFilename":
        return basename(path);
      case "resourceDirname":
        return dirname(path);
      case "resourceExtname":
        return /(\.[^./\\]+)$/.exec(path)?.[1] ?? "";
      case "resourceLangId":
      case "editorLangId":
        return languageId;
      case "isFileSystemResource":
        return scheme === "file";
      case "editorHasSelection":
        return !!view && !view.state.selection.main.empty;
      case "editorHasMultipleSelections":
        return !!view && view.state.selection.ranges.length > 1;
      case "editorTextFocus":
      case "editorFocus":
        return !!view?.hasFocus;
      case "editorIsOpen":
        return true;
      case "editorReadonly":
        return !!view?.state.readOnly;
      default:
        return undefined;
    }
  };
}

const clipboard = (view: EditorView): ContextMenuItem[] => {
  const selected = () => view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
  const empty = view.state.selection.main.empty;
  return [
    {
      type: "item",
      label: "Cut",
      action: "cut",
      disabled: empty || view.state.readOnly,
      run: () => {
        void navigator.clipboard.writeText(selected()).then(() => view.dispatch(view.state.replaceSelection("")));
      },
    },
    { type: "item", label: "Copy", action: "copy", disabled: empty, run: () => void navigator.clipboard.writeText(selected()) },
    {
      type: "item",
      label: "Paste",
      action: "paste",
      disabled: view.state.readOnly,
      run: () => {
        void navigator.clipboard.readText().then((text) => {
          view.dispatch(view.state.replaceSelection(text));
          view.focus();
        });
      },
    },
  ];
};

/**
 * editor/context: shown only when an extension contributes to it (the editor
 * has no right-click menu of its own); editor/context/copy entries are the
 * "Copy As" submenu after Copy.
 */
function contextMenu(path: string, languageId: string): Extension {
  return EditorView.domEventHandlers({
    contextmenu(event, view) {
      const lookup = editorLookup(path, languageId, view);
      const items = resolveContributedMenu("editor/context", lookup);
      const copyAs = contributedMenuItems("editor/context/copy", lookup, [uriArg(path)]);
      if (!items.length && !copyAs.length) return false;
      event.preventDefault();
      const run = (command: string) => runMenuCommand(command, [uriArg(path)]);
      const edit = clipboard(view);
      if (copyAs.length) edit.splice(2, 0, { type: "submenu", label: "Copy As", items: copyAs });
      void showContextMenu(event.clientX, event.clientY, [...toContextItems(items, run), ...(items.length ? [{ type: "separator" as const }] : []), ...edit]);
      return true;
    },
  });
}

/* ── editor/lineNumber/context ───────────────────────────────────────────── */

/** The editor/lineNumber/context entries for a line (1-based); commands get `{ lineNumber, uri }` like VS Code's. */
export function lineNumberMenuItems(path: string, line: number, languageId = extensionService.documentLanguage(path) ?? ""): ContextMenuItem[] {
  const base = editorLookup(path, languageId, null);
  const lookup = (key: string) => (key === "editorLineNumber" ? line : base(key));
  return contributedMenuItems("editor/lineNumber/context", lookup, [{ lineNumber: line, uri: uriArg(path) }]);
}

/** Right click on the line numbers (the breakpoint gutter adds the same entries to its own menu). */
function lineNumberMenu(path: string, languageId: string): Extension {
  return ViewPlugin.define((view) => {
    const onContextMenu = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest(".cm-lineNumbers")) return;
      const block = view.lineBlockAtHeight(event.clientY - view.documentTop);
      const items = lineNumberMenuItems(path, view.state.doc.lineAt(block.from).number, languageId);
      if (!items.length) return;
      event.preventDefault();
      event.stopPropagation();
      void showContextMenu(event.clientX, event.clientY, items);
    };
    view.dom.addEventListener("contextmenu", onContextMenu);
    return { destroy: () => view.dom.removeEventListener("contextmenu", onContextMenu) };
  });
}

/* ── editor/title strip ──────────────────────────────────────────────────── */

const setStrip = StateEffect.define<boolean>();

function stripWanted(path: string, languageId: string): boolean {
  const lookup = editorLookup(path, languageId, null);
  return !!resourceLabel(path) || resolveContributedMenu("editor/title", lookup).length > 0 || resolveContributedMenu("editor/title/run", lookup).length > 0;
}

function actionButton(item: Extract<ResolvedMenuItem, { type: "command" }>, run: (command: string) => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-btn cm-title-action";
  button.title = item.title;
  if (item.icon && item.icon.startsWith("data:")) {
    const image = document.createElement("img");
    image.src = item.icon;
    image.alt = item.title;
    button.appendChild(image);
  } else button.textContent = item.title;
  button.addEventListener("click", () => run(item.command));
  return button;
}

function createStrip(path: string, languageId: string): (view: EditorView) => Panel {
  return (view) => {
    const dom = document.createElement("div");
    dom.className = "cm-title-strip";
    const render = () => {
      dom.replaceChildren();
      const label = document.createElement("span");
      label.className = "cm-title-label";
      label.textContent = resourceLabel(path) ?? "";
      const actions = document.createElement("span");
      actions.className = "cm-title-actions";
      const lookup = editorLookup(path, languageId, view);
      const items = resolveContributedMenu("editor/title", lookup);
      const run = (command: string) => runMenuCommand(command, [uriArg(path)]);
      // editor/title/run: the first entry is the run button, the others are in its "▾" drop-down (like VS Code's).
      const runItems = flattenMenu(resolveContributedMenu("editor/title/run", lookup));
      if (runItems.length) {
        const primary = actionButton(runItems[0]!, run);
        primary.classList.add("cm-title-run");
        primary.prepend("▶ ");
        actions.appendChild(primary);
        if (runItems.length > 1) {
          const more = document.createElement("button");
          more.type = "button";
          more.className = "icon-btn cm-title-action cm-title-run-more";
          more.title = "More Run Actions…";
          more.textContent = "▾";
          more.addEventListener("click", () => {
            const rect = more.getBoundingClientRect();
            void showContextMenu(rect.left, rect.bottom, toContextItems(runItems.slice(1), run));
          });
          actions.appendChild(more);
        }
      }
      // "navigation" entries are buttons; everything else (and submenus) is behind the "…" button.
      const inline = items.filter((item): item is Extract<ResolvedMenuItem, { type: "command" }> => item.type === "command" && item.group === "navigation");
      const overflow = items.filter((item) => !inline.includes(item as never));
      for (const item of inline) actions.appendChild(actionButton(item, run));
      if (overflow.length) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "icon-btn cm-title-action";
        more.title = "More Actions…";
        more.textContent = "…";
        more.addEventListener("click", () => {
          const rect = more.getBoundingClientRect();
          void showContextMenu(rect.left, rect.bottom, toContextItems(overflow, run));
        });
        actions.appendChild(more);
      }
      dom.append(label, actions);
    };
    render();
    // Selection / focus changes can flip when clauses (editorHasSelection); the extensions list can change too.
    const unsubscribe = extensionService.subscribe(render);
    return {
      dom,
      top: true,
      update: (update) => {
        if (update.selectionSet || update.focusChanged || update.docChanged) render();
      },
      destroy: () => unsubscribe(),
    };
  };
}

function titleStrip(path: string, languageId: string): Extension {
  const wanted = StateField.define<boolean>({
    create: () => stripWanted(path, languageId),
    update: (value, transaction) => {
      for (const effect of transaction.effects) if (effect.is(setStrip)) return effect.value;
      return value;
    },
    provide: (field) => showPanel.from(field, (on) => (on ? createStrip(path, languageId) : null)),
  });
  // Extensions load after the first editors open: look again when the list changes.
  const follow = ViewPlugin.define((view) => {
    const check = () => {
      const want = stripWanted(path, languageId);
      if (want !== view.state.field(wanted)) queueMicrotask(() => view.dispatch({ effects: setStrip.of(want) }));
    };
    const unsubscribe = extensionService.subscribe(check);
    return { destroy: () => unsubscribe() };
  });
  return [wanted, follow];
}

export function menuEditorExtensions(path: string, languageId: string): Extension[] {
  return [contextMenu(path, languageId), lineNumberMenu(path, languageId), titleStrip(path, languageId)];
}

/* ── editor/title/context ────────────────────────────────────────────────── */

/**
 * Adds the `editor/title/context` entries to an editor tab's menu (tabs carry
 * `data-tab-path`, `data-group` and `data-index`); terminal tabs get
 * `terminal/title/context` instead. Commands get the resource and VS Code's
 * `{ groupId, editorIndex }`.
 */
export function installTabMenu(): void {
  registerMenuAugmenter((_items, target) => {
    const tab = target?.closest<HTMLElement>(".tab[data-tab-path]");
    const path = tab?.dataset.tabPath;
    if (!tab || !path) return null;
    if (path.startsWith("terminal:")) {
      const id = path.slice("terminal:".length);
      const items = contributedMenuItems(
        "terminal/title/context",
        (key) => (key === "terminalEditorActive" || key === "terminalEditorFocus" ? true : undefined),
        [{ $ref: { area: "terminal", id } }],
      );
      return items.length ? items : null;
    }
    const base = resourceLookup(path);
    const lookup = (key: string) =>
      key === "isActiveEditorGroup" ? tab.classList.contains("active") : key === "activeEditorIsPinned" ? !tab.classList.contains("preview") : base(key);
    const context = { groupId: tab.dataset.group, editorIndex: Number(tab.dataset.index) };
    const items = contributedMenuItems("editor/title/context", lookup, [uriArg(path), context]);
    return items.length ? items : null;
  });
}

/* ── explorer/context ────────────────────────────────────────────────────── */

/** Adds the `explorer/context` entries of extensions to the explorer's context menu (rows carry `data-path`). */
export function installExplorerMenu(): void {
  registerMenuAugmenter((_items, target) => {
    const row = target?.closest<HTMLElement>(".tree-item[data-path]");
    if (!row?.dataset.path) return null;
    const path = row.dataset.path;
    const folder = row.dataset.dir === "1";
    const lookup = (key: string): unknown => {
      switch (key) {
        case "explorerResourceIsFolder":
          return folder;
        case "explorerViewletVisible":
        case "explorerViewletFocus":
        case "filesExplorerFocus":
          return true;
        case "listMultiSelection":
          return false;
        case "resource":
        case "resourcePath":
          return path;
        case "resourceScheme":
          return "file";
        case "resourceFilename":
          return basename(path);
        case "resourceDirname":
          return dirname(path);
        case "resourceExtname":
          return /(\.[^./\\]+)$/.exec(path)?.[1] ?? "";
        case "isFileSystemResource":
          return true;
        default:
          return undefined;
      }
    };
    const resolved = resolveContributedMenu("explorer/context", lookup);
    if (!flattenMenu(resolved).length) return null;
    // VS Code passes the clicked resource and the list of selected ones.
    return toContextItems(resolved, (command) => runMenuCommand(command, [uriArg(path), [uriArg(path)]]));
  });
}
