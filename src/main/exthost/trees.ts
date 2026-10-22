import { readFileSync, statSync } from "fs";
import { extname } from "path";
import type { HostTreeIcon, HostTreeItem, HostTreeTooltip, HostTreeView } from "../../shared/extensions.ts";
import { DataTransfer, DataTransferItem } from "./compat-types.ts";
import type { ExtensionHost, ExtensionRuntime } from "./host.ts";
import * as T from "./types.ts";
import { markdownOf } from "./wire.ts";

/**
 * Tree views (window.registerTreeDataProvider / createTreeView). The view
 * asks for the children of an item by handle when it shows or expands it;
 * the host keeps the extension's elements and answers with plain items.
 * Handles are stable across refreshes, like VS Code's: `TreeItem.id`, or the
 * parent's handle and the label — so expanded items stay expanded.
 */

type Provider = {
  getChildren: (element?: unknown) => unknown;
  getTreeItem: (element: unknown) => unknown;
  getParent?: (element: unknown) => unknown;
  resolveTreeItem?: (item: T.TreeItem, element: unknown, token: unknown) => unknown;
  onDidChangeTreeData?: (listener: (event: unknown) => unknown) => { dispose(): unknown };
};

/** TreeView's drag and drop controller (options.dragAndDropController). */
type DragAndDropController = {
  dragMimeTypes?: string[];
  dropMimeTypes?: string[];
  handleDrag?: (source: unknown[], dataTransfer: DataTransfer, token: unknown) => unknown;
  handleDrop?: (target: unknown | undefined, dataTransfer: DataTransfer, token: unknown) => unknown;
};

type TreeOptions = {
  treeDataProvider: Provider;
  showCollapseAll?: boolean;
  canSelectMany?: boolean;
  manageCheckboxStateManually?: boolean;
  dragAndDropController?: DragAndDropController;
};

type Tree = {
  viewId: string;
  extensionId: string;
  provider: Provider;
  view: HostTreeView;
  dragAndDrop?: DragAndDropController;
  elements: Map<string, unknown>;
  /** The TreeItem a handle was wired from (for resolveTreeItem). */
  items: Map<string, T.TreeItem>;
  handles: Map<unknown, string>;
  /** Children handles by parent handle ("" for the root). */
  children: Map<string, string[]>;
  commands: Map<string, T.Command>;
  selection: unknown[];
  visible: boolean;
  expand: T.EventEmitter<{ element: unknown }>;
  collapse: T.EventEmitter<{ element: unknown }>;
  select: T.EventEmitter<{ selection: unknown[] }>;
  visibility: T.EventEmitter<{ visible: boolean }>;
  checkbox: T.EventEmitter<{ items: [unknown, number][] }>;
  subscription: { dispose(): unknown } | undefined;
};

const IMAGE_TYPES: Record<string, string> = { ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif" };
const COLLAPSIBLE: HostTreeItem["collapsible"][] = ["none", "collapsed", "expanded"];

export class TreeViewManager {
  readonly #host: ExtensionHost;
  readonly #trees = new Map<string, Tree>();
  readonly #icons = new Map<string, string | null>();
  /** Items to reload, per view (onDidChangeTreeData fires in bursts). */
  readonly #changed = new Map<string, Set<string> | null>();
  /** Data transfers of drags in progress, by the id the view holds. */
  readonly #drags = new Map<string, { elements: unknown[]; dataTransfer: DataTransfer }>();
  #dragSeq = 0;

  constructor(host: ExtensionHost) {
    this.#host = host;
  }

  get viewIds(): string[] {
    return [...this.#trees.keys()];
  }

  register(runtime: ExtensionRuntime | null, viewId: string, provider: Provider): T.Disposable {
    const view = this.create(runtime, viewId, { treeDataProvider: provider });
    return new T.Disposable(() => (view.dispose as () => void)());
  }

  /** The TreeView object handed to the extension. */
  create(runtime: ExtensionRuntime | null, viewId: string, options: TreeOptions): Record<string, unknown> {
    const provider = options?.treeDataProvider;
    if (!provider || typeof provider.getChildren !== "function" || typeof provider.getTreeItem !== "function") {
      throw new Error(`a tree data provider for '${viewId}' needs getChildren and getTreeItem`);
    }
    this.#dispose(viewId);
    const host = this.#host;
    const extensionId = runtime?.id ?? "unknown";
    const controller = options.dragAndDropController;
    const tree: Tree = {
      viewId,
      extensionId,
      provider,
      view: {
        viewId,
        extensionId,
        showCollapseAll: !!options.showCollapseAll,
        canSelectMany: !!options.canSelectMany,
        dragMimeTypes: controller?.handleDrag && controller.dragMimeTypes?.length ? [...controller.dragMimeTypes] : [],
        dropMimeTypes: controller?.handleDrop && controller.dropMimeTypes?.length ? [...controller.dropMimeTypes] : [],
      },
      dragAndDrop: controller,
      elements: new Map(),
      items: new Map(),
      handles: new Map(),
      children: new Map(),
      commands: new Map(),
      selection: [],
      visible: false,
      expand: new T.EventEmitter(),
      collapse: new T.EventEmitter(),
      select: new T.EventEmitter(),
      visibility: new T.EventEmitter(),
      checkbox: new T.EventEmitter(),
      subscription: undefined,
    };
    tree.subscription = provider.onDidChangeTreeData?.((event) => this.#onDataChanged(tree, event));
    this.#trees.set(viewId, tree);
    const update = (patch: Partial<HostTreeView>) => {
      Object.assign(tree.view, patch);
      if (this.#trees.get(viewId) === tree) host.post({ type: "treeView", view: { ...tree.view } });
    };
    update({});
    const manager = this;
    return {
      get selection() {
        return [...tree.selection];
      },
      get visible() {
        return tree.visible;
      },
      onDidExpandElement: tree.expand.event,
      onDidCollapseElement: tree.collapse.event,
      onDidChangeSelection: tree.select.event,
      onDidChangeVisibility: tree.visibility.event,
      onDidChangeCheckboxState: tree.checkbox.event,
      get title() {
        return tree.view.title;
      },
      set title(value: string | undefined) {
        update({ title: value });
      },
      get description() {
        return tree.view.description;
      },
      set description(value: string | undefined) {
        update({ description: value });
      },
      get message() {
        return tree.view.message;
      },
      set message(value: string | undefined) {
        update({ message: value });
      },
      get badge() {
        return tree.view.badge ?? undefined;
      },
      set badge(value: { value: number; tooltip: string } | undefined) {
        update({ badge: value ?? null });
      },
      reveal: (element: unknown, revealOptions?: { select?: boolean; focus?: boolean; expand?: boolean | number }) =>
        manager.#reveal(tree, element, revealOptions ?? {}),
      dispose: () => {
        if (manager.#trees.get(viewId) === tree) manager.#dispose(viewId);
      },
    };
  }

  #dispose(viewId: string): void {
    const tree = this.#trees.get(viewId);
    if (!tree) return;
    this.#trees.delete(viewId);
    tree.subscription?.dispose();
    this.#host.post({ type: "treeDispose", viewId });
  }

  /* ── items ─────────────────────────────────────────────────────────── */

  async children(viewId: string, handle: string | null): Promise<HostTreeItem[] | null> {
    let tree = this.#trees.get(viewId);
    if (!tree) {
      await this.#host.activateByEvent(`onView:${viewId}`);
      tree = this.#trees.get(viewId);
      if (!tree) return null;
    }
    const key = handle ?? "";
    if (handle !== null && !tree.elements.has(handle)) return [];
    const element = handle === null ? undefined : tree.elements.get(handle);
    let list: unknown[];
    try {
      list = ((await tree.provider.getChildren(element)) as unknown[] | null | undefined) ?? [];
    } catch (error) {
      this.#host.log("error", `${viewId}: getChildren failed: ${error instanceof Error ? (error.stack ?? error.message) : error}`, tree.extensionId);
      return [];
    }
    for (const child of tree.children.get(key) ?? []) this.#forget(tree, child);
    const items: HostTreeItem[] = [];
    const used = new Set<string>();
    for (const child of list) {
      let item: T.TreeItem;
      try {
        item = ((await tree.provider.getTreeItem(child)) as T.TreeItem | undefined) ?? new T.TreeItem("");
      } catch (error) {
        this.#host.log("error", `${viewId}: getTreeItem failed: ${error instanceof Error ? error.message : error}`, tree.extensionId);
        continue;
      }
      const label = labelOf(item);
      let childHandle = item.id !== undefined ? `i/${item.id}` : `${key}/${label}`;
      for (let n = 1; used.has(childHandle); n++) childHandle = `${item.id !== undefined ? `i/${item.id}` : `${key}/${label}`}#${n}`;
      used.add(childHandle);
      tree.elements.set(childHandle, child);
      tree.items.set(childHandle, item);
      tree.handles.set(child, childHandle);
      if (item.command) tree.commands.set(childHandle, item.command);
      items.push(this.#wireItem(item, childHandle, label));
    }
    tree.children.set(
      key,
      items.map((item) => item.handle),
    );
    return items;
  }

  #forget(tree: Tree, handle: string): void {
    for (const child of tree.children.get(handle) ?? []) this.#forget(tree, child);
    tree.children.delete(handle);
    tree.commands.delete(handle);
    const element = tree.elements.get(handle);
    tree.elements.delete(handle);
    tree.items.delete(handle);
    if (tree.handles.get(element) === handle) tree.handles.delete(element);
  }

  #wireItem(item: T.TreeItem, handle: string, label: string): HostTreeItem {
    const collapsible = COLLAPSIBLE[item.collapsibleState ?? 0] ?? "none";
    let description: string | undefined;
    if (typeof item.description === "string") description = item.description;
    else if (item.description === true && item.resourceUri) {
      const path = item.resourceUri.scheme === "file" ? item.resourceUri.fsPath : item.resourceUri.path;
      const parts = path.split(/[/\\]/);
      parts.pop();
      description = parts.join(path.includes("\\") ? "\\" : "/");
      const root = this.#host.workspace;
      if (root && description.toLowerCase().startsWith(root.toLowerCase())) description = description.slice(root.length + 1);
    }
    const state = typeof item.checkboxState === "object" ? item.checkboxState?.state : item.checkboxState;
    const highlights = typeof item.label === "object" ? item.label?.highlights : undefined;
    return {
      handle,
      label,
      highlights: highlights?.length ? highlights.map(([start, end]) => [start, end]) : undefined,
      description: description || undefined,
      tooltip: tooltipOf(item.tooltip),
      collapsible,
      icon: this.#icon(item, collapsible),
      contextValue: item.contextValue,
      hasCommand: !!item.command,
      checkbox: state === undefined ? undefined : state === T.TreeItemCheckboxState.Checked ? "checked" : "unchecked",
    };
  }

  #icon(item: T.TreeItem, collapsible: HostTreeItem["collapsible"]): HostTreeIcon | undefined {
    const icon = item.iconPath as T.ThemeIcon | T.Uri | string | { light?: T.Uri | string; dark?: T.Uri | string } | undefined;
    const name = item.resourceUri ? (item.resourceUri.path.split("/").pop() ?? "") : "";
    if (icon instanceof T.ThemeIcon || (icon && typeof icon === "object" && "id" in icon && typeof icon.id === "string")) {
      const themeIcon = icon as T.ThemeIcon;
      if ((themeIcon.id === "file" || themeIcon.id === "folder") && item.resourceUri) return { file: name, folder: themeIcon.id === "folder" };
      return { codicon: themeIcon.id, color: themeIcon.color?.id };
    }
    const source = icon && typeof icon === "object" && !T.Uri.isUri(icon) && ("dark" in icon || "light" in icon) ? (icon.dark ?? icon.light) : icon;
    if (source) {
      const uri = typeof source === "string" ? T.Uri.file(source) : T.Uri.isUri(source) ? source : undefined;
      if (uri?.scheme === "http" || uri?.scheme === "https" || uri?.scheme === "data") return { url: uri.toString(true) };
      if (uri?.scheme === "file") {
        const url = this.#imageUrl(uri.fsPath);
        if (url) return { url };
      }
      return undefined;
    }
    if (item.resourceUri) return { file: name, folder: collapsible !== "none" };
    return undefined;
  }

  /** An icon file as a data URL (cached; small images only). */
  #imageUrl(path: string): string | null {
    const cached = this.#icons.get(path);
    if (cached !== undefined) return cached;
    let url: string | null = null;
    const type = IMAGE_TYPES[extname(path).toLowerCase()];
    try {
      if (type && statSync(path).size <= 256 * 1024) url = `data:${type};base64,${readFileSync(path).toString("base64")}`;
    } catch {
      /* missing icon */
    }
    this.#icons.set(path, url);
    return url;
  }

  /* ── resolve, drag and drop ────────────────────────────────────────── */

  /** TreeDataProvider.resolveTreeItem: an item's tooltip, resolved when it is hovered. */
  async resolveItem(viewId: string, handle: string): Promise<{ tooltip?: HostTreeTooltip } | null> {
    const tree = this.#trees.get(viewId);
    if (!tree?.provider.resolveTreeItem || !tree.items.has(handle)) return null;
    const element = tree.elements.get(handle);
    const item = tree.items.get(handle)!;
    try {
      const resolved = (await tree.provider.resolveTreeItem(item, element, new T.CancellationTokenSource().token)) as T.TreeItem | null | undefined;
      return { tooltip: tooltipOf(resolved?.tooltip) };
    } catch (error) {
      this.#host.log("error", `${viewId}: resolveTreeItem failed: ${error instanceof Error ? error.message : error}`, tree.extensionId);
      return null;
    }
  }

  /** The extension's handleDrag fills a DataTransfer; the returned id is passed back to drop. */
  async drag(viewId: string, handles: string[]): Promise<string | null> {
    const tree = this.#trees.get(viewId);
    const controller = tree?.dragAndDrop;
    if (!tree || !controller?.handleDrag || !controller.dragMimeTypes?.length) return null;
    const elements = handles.filter((handle) => tree.elements.has(handle)).map((handle) => tree.elements.get(handle));
    const dataTransfer = new DataTransfer();
    // The dragged elements under the tree's internal MIME type, like VS Code.
    dataTransfer.set(`application/vnd.code.tree.${viewId.toLowerCase()}`, new DataTransferItem(elements));
    try {
      await controller.handleDrag(elements, dataTransfer, new T.CancellationTokenSource().token);
    } catch (error) {
      this.#host.log("error", `${viewId}: handleDrag failed: ${error instanceof Error ? error.message : error}`, tree.extensionId);
    }
    const id = `drag-${++this.#dragSeq}`;
    // Bounded: a cancelled drag never reports a drop.
    if (this.#drags.size >= 64) this.#drags.delete(this.#drags.keys().next().value as string);
    this.#drags.set(id, { elements, dataTransfer });
    return id;
  }

  /** The extension's handleDrop, with the DataTransfer built at drag time plus files and the target tree's items. */
  async drop(viewId: string, targetHandle: string | null, dragId: string | null, files?: string[]): Promise<boolean> {
    const tree = this.#trees.get(viewId);
    const controller = tree?.dragAndDrop;
    if (!tree || !controller?.handleDrop || !controller.dropMimeTypes?.length) return false;
    if (targetHandle !== null && !tree.elements.has(targetHandle)) return false;
    const drag = dragId ? this.#drags.get(dragId) : undefined;
    const dataTransfer = drag ? drag.dataTransfer : new DataTransfer();
    if (drag) dataTransfer.set(`application/vnd.code.tree.${viewId.toLowerCase()}`, new DataTransferItem(drag.elements));
    if (files?.length) dataTransfer.set("text/uri-list", new DataTransferItem(files.map((file) => T.Uri.file(file).toString()).join("\r\n")));
    try {
      await controller.handleDrop(targetHandle === null ? undefined : tree.elements.get(targetHandle), dataTransfer, new T.CancellationTokenSource().token);
    } catch (error) {
      this.#host.log("error", `${viewId}: handleDrop failed: ${error instanceof Error ? error.message : error}`, tree.extensionId);
      return false;
    } finally {
      if (dragId) this.#drags.delete(dragId);
    }
    return true;
  }

  /* ── changes & reveal ──────────────────────────────────────────────── */

  #onDataChanged(tree: Tree, event: unknown): void {
    if (this.#trees.get(tree.viewId) !== tree) return;
    const scheduled = this.#changed.has(tree.viewId);
    const current = this.#changed.get(tree.viewId);
    const elements = event === undefined || event === null ? null : Array.isArray(event) ? event : [event];
    let next: Set<string> | null = null;
    if (elements && current !== null) {
      next = current ?? new Set();
      for (const element of elements) {
        const handle = tree.handles.get(element);
        // An element the view never saw: nothing shown to refresh.
        if (handle) next.add(handle);
      }
    }
    this.#changed.set(tree.viewId, next);
    if (scheduled) return;
    queueMicrotask(() => {
      const handles = this.#changed.get(tree.viewId);
      this.#changed.delete(tree.viewId);
      if (handles === undefined || this.#trees.get(tree.viewId) !== tree) return;
      if (handles && !handles.size) return;
      this.#host.post({ type: "treeChanged", viewId: tree.viewId, handles: handles ? [...handles] : null });
    });
  }

  async #reveal(tree: Tree, element: unknown, options: { select?: boolean; focus?: boolean; expand?: boolean | number }): Promise<void> {
    const chain = [element];
    if (tree.provider.getParent) {
      for (let parent = await tree.provider.getParent(element); parent !== undefined && parent !== null; parent = await tree.provider.getParent!(parent)) {
        chain.unshift(parent);
        if (chain.length > 64) break;
      }
    }
    // Load each level, so every element on the way has a handle.
    let parentHandle: string | null = null;
    const path: string[] = [];
    for (const step of chain) {
      if (!tree.children.has(parentHandle ?? "")) await this.children(tree.viewId, parentHandle);
      let handle = tree.handles.get(step);
      if (!handle) {
        await this.children(tree.viewId, parentHandle);
        handle = tree.handles.get(step);
      }
      if (!handle) throw new Error(`cannot reveal an element that is not in the tree of '${tree.viewId}'`);
      path.push(handle);
      parentHandle = handle;
    }
    this.#host.post({ type: "treeReveal", viewId: tree.viewId, path, select: options.select ?? true, focus: !!options.focus, expand: options.expand ?? false });
  }

  /* ── events from the view ──────────────────────────────────────────── */

  event(viewId: string, event: "expand" | "collapse" | "select" | "open" | "visible" | "hidden" | "checkbox", handles: string[], checked?: boolean): void {
    const tree = this.#trees.get(viewId);
    if (!tree) return;
    const elements = handles.filter((handle) => tree.elements.has(handle)).map((handle) => tree.elements.get(handle));
    switch (event) {
      case "expand":
        for (const element of elements) tree.expand.fire({ element });
        return;
      case "collapse":
        for (const element of elements) tree.collapse.fire({ element });
        return;
      case "select":
        tree.selection = elements;
        tree.select.fire({ selection: [...elements] });
        return;
      case "open": {
        const command = handles[0] ? tree.commands.get(handles[0]) : undefined;
        if (!command) return;
        void this.#host.executeCommand(command.command, command.arguments ?? []).catch((error: unknown) => this.#failed(tree, command.command, error));
        return;
      }
      case "visible":
      case "hidden": {
        const visible = event === "visible";
        if (tree.visible === visible) return;
        tree.visible = visible;
        tree.visibility.fire({ visible });
        return;
      }
      case "checkbox":
        tree.checkbox.fire({ items: elements.map((element) => [element, checked ? T.TreeItemCheckboxState.Checked : T.TreeItemCheckboxState.Unchecked]) });
        return;
    }
  }

  /** A command of an item's menu: called with the item, and the selection when several items are selected. */
  command(viewId: string, command: string, handles: string[]): void {
    const tree = this.#trees.get(viewId);
    if (!tree) return;
    const elements = handles.filter((handle) => tree.elements.has(handle)).map((handle) => tree.elements.get(handle));
    const args = elements.length > 1 ? [elements[0], elements] : elements;
    void this.#host.executeCommand(command, args).catch((error: unknown) => this.#failed(tree, command, error));
  }

  #failed(tree: Tree, command: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.#host.log("error", `command ${command} failed: ${message}`, tree.extensionId);
    this.#host.post({ type: "message", kind: "error", message: `Running the command '${command}' failed: ${message}`, extensionId: tree.extensionId });
  }
}

function labelOf(item: T.TreeItem): string {
  const label = typeof item.label === "object" && item.label ? item.label.label : item.label;
  if (label) return String(label);
  if (item.resourceUri) return item.resourceUri.path.split("/").filter(Boolean).pop() ?? item.resourceUri.path;
  return "";
}

/** A TreeItem.tooltip as wire data: MarkdownString → `{ markdown }`, a plain string stays plain. */
function tooltipOf(value: unknown): HostTreeTooltip | undefined {
  if (typeof value === "string") return value || undefined;
  if (value && typeof value === "object") {
    const markdown = markdownOf(value);
    return markdown ? { markdown } : undefined;
  }
  return undefined;
}
