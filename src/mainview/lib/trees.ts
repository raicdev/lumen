import { useSyncExternalStore } from "react";
import type { ExtensionManifest, HostToView, HostTreeItem, HostTreeTooltip, HostTreeView, ViewWelcomeContribution } from "../../shared/extensions";
import { extensionService } from "./extensions";
import { resolveContributedMenu } from "../features/menus-walkthroughs/menus";
import type { ResolvedMenuItem } from "../../shared/menus-walkthroughs";

/**
 * Tree views of extensions, in the window: what each tree has loaded (items
 * by handle, children by parent), which items are expanded and selected, and
 * the menus contributed to views (view/title, view/item/context). Children
 * are asked of the host when a tree is first shown or an item expanded.
 */

export type TreeState = {
  items: Map<string, HostTreeItem>;
  /** Children handles by parent handle ("" for the root). */
  children: Map<string, string[]>;
  parents: Map<string, string>;
  expanded: Set<string>;
  /** Items whose initial collapsible state was applied (later refreshes keep the user's choice). */
  seen: Set<string>;
  loading: Set<string>;
  /** Asked to reload while loading: loaded again afterwards. */
  stale: Set<string>;
  selection: string[];
  focused: string | null;
  /** No provider is registered for the view. */
  missing: boolean;
  visible: boolean;
  /** Bumped by reveal(): the tree scrolls the focused item into view. */
  revealToken: number;
  version: number;
};

export type ViewAction = { command: string; title: string; icon?: string; group: string; order: number; extensionId: string; submenu?: ViewAction[] };

const ROOT = "";

/** A drag started in a tree view: the browser only carries this token, the extension's data stays in the host. */
export const TREE_DRAG_TYPE = "application/x-lumen-tree";

function emptyState(): TreeState {
  return {
    items: new Map(),
    children: new Map(),
    parents: new Map(),
    expanded: new Set(),
    seen: new Set(),
    loading: new Set(),
    stale: new Set(),
    selection: [],
    focused: null,
    missing: false,
    visible: false,
    revealToken: 0,
    version: 0,
  };
}

class TreeService {
  #trees = new Map<string, TreeState>();
  #listeners = new Map<string, Set<() => void>>();
  /** Providers' view state (title, message, badge, …): changes rarely, so the window can follow it. */
  #views = new Map<string, HostTreeView>();
  #viewListeners = new Set<() => void>();
  #revealListeners = new Set<(viewId: string, focus: boolean) => void>();
  #commandHandler: ((command: string, args: unknown[]) => void) | null = null;
  /** Bumped when the host restarts: answers for the old host are dropped. */
  #generation = 0;
  #inflight = new Map<string, Promise<void>>();
  /** The tree drag in progress: the browser token, and the host id once the extension answered. */
  #drag: { token: string; dragId: string | null; answered: Promise<string | null> } | null = null;
  #dragSeq = 0;

  /** Bumped when the host restarts (caches keyed on it must be dropped too). */
  get generation(): number {
    return this.#generation;
  }

  constructor() {
    window.addEventListener("lumen:ext-host", (e) => this.#onHost((e as CustomEvent<HostToView>).detail));
  }

  /* ── store ─────────────────────────────────────────────────────────── */

  state(viewId: string): TreeState {
    let state = this.#trees.get(viewId);
    if (!state) {
      state = emptyState();
      this.#trees.set(viewId, state);
    }
    return state;
  }

  subscribe(viewId: string, listener: () => void) {
    let set = this.#listeners.get(viewId);
    if (!set) {
      set = new Set();
      this.#listeners.set(viewId, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  version(viewId: string): number {
    return this.state(viewId).version;
  }

  #changed(viewId: string) {
    this.state(viewId).version++;
    for (const listener of this.#listeners.get(viewId) ?? []) listener();
  }

  subscribeViews = (listener: () => void) => {
    this.#viewListeners.add(listener);
    return () => this.#viewListeners.delete(listener);
  };

  #viewsSnapshot = new Map<string, HostTreeView>();
  getViews = () => this.#viewsSnapshot;

  #viewsChanged() {
    this.#viewsSnapshot = new Map(this.#views);
    for (const listener of this.#viewListeners) listener();
  }

  /** The window shows a view when a tree reveals an item. */
  onReveal(listener: (viewId: string, focus: boolean) => void) {
    this.#revealListeners.add(listener);
    return () => this.#revealListeners.delete(listener);
  }

  /** Runs commands of view toolbars and welcome content (window commands or the extensions'). */
  setCommandHandler(handler: (command: string, args: unknown[]) => void) {
    this.#commandHandler = handler;
  }

  runCommand(command: string, args: unknown[] = []) {
    if (this.#commandHandler) this.#commandHandler(command, args);
    else extensionService.executeCommand(command, args);
  }

  /* ── loading ───────────────────────────────────────────────────────── */

  /** The tree is shown (or hidden): the root is loaded the first time. */
  setVisible(viewId: string, visible: boolean) {
    const state = this.state(viewId);
    if (state.visible === visible) return;
    state.visible = visible;
    extensionService.post({ type: "treeEvent", viewId, event: visible ? "visible" : "hidden", handles: [] });
    if (visible && !state.children.has(ROOT)) void this.load(viewId, null);
    this.#changed(viewId);
  }

  /**
   * (Re)load the children of an item, and of its expanded descendants. One
   * load per item at a time: asked again meanwhile, it loads once more after
   * the running one (and the promise covers both).
   */
  load(viewId: string, handle: string | null): Promise<void> {
    const state = this.state(viewId);
    const key = handle ?? ROOT;
    const id = `${viewId}
${key}`;
    const running = this.#inflight.get(id);
    if (running) {
      state.stale.add(key);
      return running;
    }
    const promise = (async () => {
      do {
        state.stale.delete(key);
        await this.#load(viewId, handle);
      } while (state.stale.has(key));
    })().finally(() => this.#inflight.delete(id));
    this.#inflight.set(id, promise);
    return promise;
  }

  /** The children of an item, loaded (or being loaded) — without asking again when they are there. */
  #ensureLoaded(viewId: string, handle: string | null): Promise<void> {
    const running = this.#inflight.get(`${viewId}
${handle ?? ROOT}`);
    if (running) return running;
    return this.state(viewId).children.has(handle ?? ROOT) ? Promise.resolve() : this.load(viewId, handle);
  }

  async #load(viewId: string, handle: string | null): Promise<void> {
    const state = this.state(viewId);
    const key = handle ?? ROOT;
    if (!extensionService.getSnapshot().ready) return;
    const generation = this.#generation;
    state.loading.add(key);
    this.#changed(viewId);
    let items: HostTreeItem[] | null = [];
    try {
      items = await extensionService.call("treeChildren", viewId, handle);
    } catch (error) {
      console.warn(`[trees] ${viewId}:`, error);
    }
    if (generation !== this.#generation) return;
    state.loading.delete(key);
    if (items === null) {
      state.missing = true;
      this.#changed(viewId);
      return;
    }
    state.missing = false;
    // Items that are gone take what was loaded below them along; the others keep it until they are reloaded.
    const kept = new Set(items.map((item) => item.handle));
    for (const child of state.children.get(key) ?? []) if (!kept.has(child)) this.#forget(state, child);
    for (const item of items) {
      state.items.set(item.handle, item);
      state.parents.set(item.handle, key);
      if (!state.seen.has(item.handle)) {
        state.seen.add(item.handle);
        if (item.collapsible === "expanded") state.expanded.add(item.handle);
      }
      if (item.collapsible === "none") state.expanded.delete(item.handle);
    }
    state.children.set(
      key,
      items.map((item) => item.handle),
    );
    // The host forgot what was below these items: collapsed ones load again when expanded.
    for (const item of items) {
      if (state.expanded.has(item.handle)) continue;
      for (const child of state.children.get(item.handle) ?? []) this.#forget(state, child);
      state.children.delete(item.handle);
    }
    state.selection = state.selection.filter((selected) => state.items.has(selected));
    if (state.focused && !state.items.has(state.focused)) state.focused = null;
    this.#changed(viewId);
    await Promise.all(items.filter((item) => state.expanded.has(item.handle)).map((item) => this.load(viewId, item.handle)));
  }

  /** Drop what was loaded below an item (its own entry is replaced by the new answer). */
  #forget(state: TreeState, handle: string) {
    for (const child of state.children.get(handle) ?? []) this.#forget(state, child);
    state.children.delete(handle);
    state.items.delete(handle);
    state.parents.delete(handle);
  }

  /* ── user actions ──────────────────────────────────────────────────── */

  toggle(viewId: string, handle: string, expand?: boolean) {
    const state = this.state(viewId);
    const item = state.items.get(handle);
    if (!item || item.collapsible === "none") return;
    const next = expand ?? !state.expanded.has(handle);
    if (next === state.expanded.has(handle)) return;
    if (next) state.expanded.add(handle);
    else state.expanded.delete(handle);
    extensionService.post({ type: "treeEvent", viewId, event: next ? "expand" : "collapse", handles: [handle] });
    this.#changed(viewId);
    if (next && !state.children.has(handle)) void this.load(viewId, handle);
  }

  collapseAll(viewId: string) {
    const state = this.state(viewId);
    if (!state.expanded.size) return;
    state.expanded.clear();
    this.#changed(viewId);
  }

  select(viewId: string, handles: string[], focused = handles.at(-1) ?? null) {
    const state = this.state(viewId);
    const same = handles.length === state.selection.length && handles.every((handle, index) => state.selection[index] === handle);
    state.focused = focused;
    if (!same) {
      state.selection = handles;
      extensionService.post({ type: "treeEvent", viewId, event: "select", handles });
    }
    this.#changed(viewId);
  }

  /** Run the item's command (a click). */
  open(viewId: string, handle: string) {
    if (this.state(viewId).items.get(handle)?.hasCommand) extensionService.post({ type: "treeEvent", viewId, event: "open", handles: [handle] });
  }

  setChecked(viewId: string, handle: string, checked: boolean) {
    const state = this.state(viewId);
    const item = state.items.get(handle);
    if (!item) return;
    state.items.set(handle, { ...item, checkbox: checked ? "checked" : "unchecked" });
    extensionService.post({ type: "treeEvent", viewId, event: "checkbox", handles: [handle], checked });
    this.#changed(viewId);
  }

  /** A command of an item's menu: the extension gets the item (and the selection, if it is part of it). */
  itemCommand(viewId: string, command: string, handle: string) {
    const selection = this.state(viewId).selection;
    const handles = selection.includes(handle) && selection.length > 1 ? [handle, ...selection.filter((other) => other !== handle)] : [handle];
    extensionService.post({ type: "treeCommand", viewId, command, handles });
  }

  /* ── tooltips & drag and drop ──────────────────────────────────────── */

  /** TreeDataProvider.resolveTreeItem, called once when an item without a tooltip is hovered. */
  async resolveTooltip(viewId: string, handle: string): Promise<HostTreeTooltip | null> {
    try {
      const resolved = await extensionService.call("resolveTreeItem", viewId, handle);
      return resolved?.tooltip ?? null;
    } catch (error) {
      console.warn(`[trees] ${viewId}:`, error);
      return null;
    }
  }

  /** A drag started: the host runs handleDrag; the returned token goes on the browser's DataTransfer. */
  startTreeDrag(viewId: string, handles: string[]): string {
    const token = `t${++this.#dragSeq}`;
    const answered = extensionService
      .call("treeDrag", viewId, handles)
      .then((id) => {
        if (this.#drag?.token === token) this.#drag.dragId = id ?? null;
        return id ?? null;
      })
      .catch((error: unknown) => {
        console.warn(`[trees] ${viewId}: drag failed`, error);
        return null;
      });
    this.#drag = { token, dragId: null, answered };
    return token;
  }

  /** A drop on a tree item (or the root, `null`): the host runs handleDrop with the drag's data and any files. */
  async drop(viewId: string, targetHandle: string | null, token: string | null, files: string[]): Promise<void> {
    const drag = token && this.#drag?.token === token ? this.#drag : null;
    const dragId = drag ? (drag.dragId ?? (await drag.answered)) : null;
    if (!dragId && !files.length) return;
    try {
      await extensionService.call("treeDrop", viewId, targetHandle, dragId, files.length ? files : undefined);
    } catch (error) {
      console.warn(`[trees] ${viewId}: drop failed`, error);
    }
  }

  /* ── contributions ─────────────────────────────────────────────────── */

  /** Menu entries of a menu (`view/title`, `view/item/context`) whose when clause holds. */
  menu(menuId: string, lookup: (key: string) => unknown): ViewAction[] {
    const toAction = (item: ResolvedMenuItem): ViewAction =>
      item.type === "submenu"
        ? { command: "", title: item.title, group: item.group, order: item.order, extensionId: item.extensionId, submenu: item.items.map(toAction) }
        : { command: item.command, title: item.title, icon: item.icon, group: item.group, order: item.order, extensionId: item.extensionId };
    // resolveContributedMenu sorts navigation first, then by group and order, and evaluates `when`.
    return resolveContributedMenu(menuId, lookup).map(toAction);
  }

  /** Welcome content of a view (contributes.viewsWelcome) whose when clause holds. */
  welcome(viewId: string, lookup: (key: string) => unknown): string[] {
    const out: string[] = [];
    for (const extension of extensionService.getSnapshot().extensions) {
      const manifest: ExtensionManifest = extension.manifest;
      for (const entry of (manifest.contributes?.viewsWelcome ?? []) as ViewWelcomeContribution[]) {
        if (entry?.view === viewId && typeof entry.contents === "string" && extensionService.when(entry.when, lookup)) out.push(entry.contents);
      }
    }
    return out;
  }

  /* ── messages from the host ────────────────────────────────────────── */

  async #reveal(message: Extract<HostToView, { type: "treeReveal" }>) {
    const { viewId, path } = message;
    const state = this.state(viewId);
    const target = path.at(-1);
    if (!target) return;
    for (const listener of this.#revealListeners) listener(viewId, message.focus);
    const expand = path.slice(0, -1);
    if (message.expand) expand.push(target);
    for (const [index, handle] of expand.entries()) {
      await this.#ensureLoaded(viewId, index ? path[index - 1]! : null);
      if (!state.expanded.has(handle)) {
        state.expanded.add(handle);
        extensionService.post({ type: "treeEvent", viewId, event: "expand", handles: [handle] });
      }
      await this.#ensureLoaded(viewId, handle);
    }
    await this.#ensureLoaded(viewId, path.at(-2) ?? null);
    if (message.select) this.select(viewId, [target]);
    else state.focused = target;
    state.revealToken++;
    this.#changed(viewId);
  }

  #onHost(message: HostToView) {
    switch (message.type) {
      case "ready": {
        // A new host: providers register again; the handles (and so what is expanded) stay valid.
        this.#generation++;
        this.#views.clear();
        this.#viewsChanged();
        for (const [viewId, state] of this.#trees) {
          state.items.clear();
          state.children.clear();
          state.parents.clear();
          state.loading.clear();
          state.stale.clear();
          state.missing = false;
          if (state.visible) void this.load(viewId, null);
          this.#changed(viewId);
        }
        return;
      }
      case "treeView": {
        const known = this.#views.has(message.view.viewId);
        this.#views.set(message.view.viewId, message.view);
        this.#viewsChanged();
        const state = this.state(message.view.viewId);
        // Registered after the tree was shown: load it now.
        if (!known && state.visible && (state.missing || !state.children.has(ROOT))) void this.load(message.view.viewId, null);
        return;
      }
      case "treeDispose": {
        this.#views.delete(message.viewId);
        this.#viewsChanged();
        const state = this.state(message.viewId);
        for (const child of state.children.get(ROOT) ?? []) this.#forget(state, child);
        state.children.delete(ROOT);
        state.missing = true;
        this.#changed(message.viewId);
        return;
      }
      case "treeChanged": {
        const state = this.state(message.viewId);
        if (!state.children.has(ROOT)) {
          if (state.visible) void this.load(message.viewId, null);
          return;
        }
        if (!message.handles) {
          void this.load(message.viewId, null);
          return;
        }
        // An item changed: its parent asks for it (and its children) again.
        const parents = new Set<string>();
        for (const handle of message.handles) {
          const parent = state.parents.get(handle);
          if (parent !== undefined) parents.add(parent);
        }
        for (const parent of parents) void this.load(message.viewId, parent === ROOT ? null : parent);
        return;
      }
      case "treeReveal":
        void this.#reveal(message);
        return;
    }
  }
}

export const treeService = new TreeService();

/** Title, message, badge, … of every registered tree view. */
export function useTreeViews(): Map<string, HostTreeView> {
  return useSyncExternalStore(treeService.subscribeViews, treeService.getViews);
}

export function useTree(viewId: string): TreeState {
  useSyncExternalStore(
    (listener) => treeService.subscribe(viewId, listener),
    () => treeService.version(viewId),
  );
  return treeService.state(viewId);
}
