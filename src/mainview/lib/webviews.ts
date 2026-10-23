import { useSyncExternalStore } from "react";
import type { HostToView, HostWebview, HostWebviewOptions } from "../../shared/extensions";
import { extensionService } from "./extensions";
import { api } from "./rpc";
import { showContextMenu, type ContextMenuItem } from "./context-menu";
import { contributedMenuItems } from "../features/menus-walkthroughs/menus";
import { activeColorTheme, onColorThemeChange, themeVariables } from "./theme";
import { themeBodyClass } from "../../shared/color-theme";
import { webviewFindAction, type WebviewFindAction, type WebviewTheme } from "../../shared/webview-document";
import { t } from "./i18n";

/** The active color theme as webview pages get it. */
function webviewTheme(): WebviewTheme {
  const theme = activeColorTheme();
  return { kind: themeBodyClass(theme.kind), name: theme.label, id: theme.id, variables: themeVariables() };
}

/**
 * Webviews of extensions, in the window: every webview is a sandboxed iframe
 * (scripts only when the extension enables them, never the window's origin,
 * so it cannot reach the app or its bridge). The iframes live in one layer
 * above the workbench and are placed over the "slot" element of the tab or
 * view showing them, so moving a slot never reloads the page.
 *
 * As in VS Code, a hidden webview keeps its page only with
 * retainContextWhenHidden: without it the page is dropped (freeing its
 * renderer memory) and loaded again from its html and saved state
 * (setState) when it is shown.
 */

export type WebviewInfo = {
  id: string;
  kind: "panel" | "view";
  viewType: string;
  extensionId: string;
  title: string;
  description?: string;
  badge?: { value: number; tooltip: string } | null;
  /** A panel saved with the window, waiting for its extension to restore it. */
  restoring: boolean;
  /** A custom editor panel: the file it shows. */
  uri?: string;
  /** A custom editor's provider kind. */
  customKind?: "text" | "readonly" | "editable";
  /** A custom editor whose document has unsaved changes. */
  dirty?: boolean;
};

export type WebviewEvent =
  | { type: "created"; id: string; reveal?: { preserveFocus: boolean; beside: boolean } }
  | { type: "disposed"; id: string }
  | { type: "reveal"; id: string; kind: "panel" | "view"; viewType: string; preserveFocus: boolean };

/** What a saved webview panel needs to come back. */
export type SavedWebview = {
  viewType: string;
  title: string;
  state: unknown;
  options: HostWebviewOptions | null;
  /** Custom editor panels also remember the file. */ uri?: string;
};

type Record_ = WebviewInfo & {
  options: HostWebviewOptions;
  html: string;
  state: unknown;
  iframe: HTMLIFrameElement;
  loaded: boolean;
  queue: unknown[];
  shown: boolean;
  reported: string;
  rect: string;
  /** Where the main process serves the page. */
  url?: string;
  /** Bumped for every new page (reloads the frame). */
  version: number;
  /** The page was dropped while hidden (no retainContextWhenHidden); messages to it are dropped too. */
  unloaded: boolean;
};

const TAB_PREFIX = "webview:";

export const isWebviewTab = (path: string | null | undefined): path is string => !!path && path.startsWith(TAB_PREFIX);
export const webviewTabPath = (id: string) => `${TAB_PREFIX}${id}`;
export const webviewIdOf = (path: string) => path.slice(TAB_PREFIX.length);

/**
 * The page comes from its extension's own origin (http://<label>.localhost:<port>), never
 * the window's: same-origin there gives it real storage without reaching the window.
 */
function sandboxFor(options: HostWebviewOptions): string {
  return ["allow-same-origin", "allow-popups", "allow-downloads", options.enableScripts ? "allow-scripts" : "", options.enableForms ? "allow-forms" : ""]
    .filter(Boolean)
    .join(" ");
}

class WebviewService {
  #records = new Map<string, Record_>();
  /** Slot elements by key: a panel's webview id, or `view:<viewId>`. */
  #slots = new Map<string, HTMLElement>();
  /** View ids already asked of the host. */
  #requested = new Set<string>();
  #layer: HTMLDivElement | null = null;
  #frame = 0;
  /** Layout watchers, live while there are webviews or slots (no per-frame polling). */
  #resizeObserver: ResizeObserver | null = null;
  #mutationObserver: MutationObserver | null = null;
  #poll: ReturnType<typeof setInterval> | null = null;
  #listeners = new Set<() => void>();
  #snapshot: WebviewInfo[] = [];
  #activePanels = new Set<string>();
  #panelListeners = new Set<(event: WebviewEvent) => void>();
  #stateListeners = new Set<() => void>();
  #commandHandler: ((command: string, args: unknown[]) => void) | null = null;
  #viewStates: Record<string, unknown> = (() => {
    try {
      return JSON.parse(localStorage.getItem("lumen.webviewViewState") ?? "{}") as Record<string, unknown>;
    } catch {
      return {};
    }
  })();

  constructor() {
    window.addEventListener("lumen:ext-host", (e) => this.#onHost((e as CustomEvent<HostToView>).detail));
    window.addEventListener("message", (e) => this.#onFrameMessage(e));
    // Slots move with the layout: re-place the frames when it may have changed.
    window.addEventListener("resize", this.#schedule);
    document.addEventListener("scroll", this.#schedule, true);
    document.addEventListener("transitionend", this.#schedule, true);
    document.addEventListener("animationend", this.#schedule, true);
    extensionService.subscribe(this.#schedule);
    onColorThemeChange(() => {
      const message = { __lumenTheme: webviewTheme() };
      for (const record of this.#records.values()) if (record.loaded) record.iframe.contentWindow?.postMessage(message, "*");
    });
  }

  /* ── store ─────────────────────────────────────────────────────────── */

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = () => this.#snapshot;

  #emit() {
    this.#snapshot = [...this.#records.values()].map(({ id, kind, viewType, extensionId, title, description, badge, restoring, uri, customKind, dirty }) => ({
      id,
      kind,
      viewType,
      extensionId,
      title,
      description,
      badge,
      restoring,
      uri,
      customKind,
      dirty,
    }));
    for (const listener of this.#listeners) listener();
  }

  /** Panels created / disposed / revealed by extensions (the app manages their tabs). */
  onPanelEvent(listener: (event: WebviewEvent) => void) {
    this.#panelListeners.add(listener);
    return () => this.#panelListeners.delete(listener);
  }

  /** A webview called setState (the app saves its window state). */
  onStateChange(listener: () => void) {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  /** Runs `command:` links (enableCommandUris). */
  setCommandHandler(handler: (command: string, args: unknown[]) => void) {
    this.#commandHandler = handler;
  }

  info(id: string): WebviewInfo | undefined {
    return this.#snapshot.find((entry) => entry.id === id);
  }

  /* ── records ───────────────────────────────────────────────────────── */

  #layerElement(): HTMLDivElement {
    if (!this.#layer) {
      this.#layer = document.createElement("div");
      this.#layer.className = "webview-layer";
      document.body.appendChild(this.#layer);
    }
    return this.#layer;
  }

  #create(webview: HostWebview, restoring = false): Record_ {
    const iframe = document.createElement("iframe");
    iframe.className = "webview-frame";
    iframe.setAttribute("sandbox", sandboxFor(webview.options));
    iframe.setAttribute("allow", "clipboard-read; clipboard-write");
    iframe.title = webview.title || webview.viewType;
    iframe.style.visibility = "hidden";
    const record: Record_ = {
      ...webview,
      restoring,
      html: "",
      version: 0,
      state: webview.kind === "view" ? this.#viewStates[webview.viewType] : undefined,
      iframe,
      loaded: false,
      queue: [],
      shown: false,
      reported: "",
      rect: "",
      unloaded: false,
    };
    iframe.addEventListener("load", () => {
      // about:blank of a dropped page is not the webview.
      if (record.unloaded) return;
      record.loaded = true;
      // The theme may have changed since the frame's name was set.
      iframe.contentWindow?.postMessage({ __lumenTheme: webviewTheme() }, "*");
      for (const message of record.queue.splice(0)) iframe.contentWindow?.postMessage(message, "*");
    });
    this.#layerElement().appendChild(iframe);
    this.#records.set(webview.id, record);
    this.#schedule();
    return record;
  }

  #setHtml(record: Record_, html: string) {
    record.html = html;
    record.loaded = false;
    record.version++;
    if (!record.url) return;
    if (this.#keepsPage(record)) this.#load(record);
    else this.#unload(record);
  }

  /** Whether the webview's page stays loaded: shown, or retained while hidden. */
  #keepsPage(record: Record_): boolean {
    return record.shown || record.options.retainContextWhenHidden;
  }

  #load(record: Record_) {
    record.unloaded = false;
    record.loaded = false;
    // The bootstrap reads the saved state and the theme from the frame's name.
    const handoff = record.state === undefined ? { theme: webviewTheme() } : { state: record.state, theme: webviewTheme() };
    record.iframe.name = `lumen-webview:${JSON.stringify(handoff)}`;
    record.iframe.src = `${record.url}?v=${record.version}`;
  }

  /** Drop a hidden page (VS Code without retainContextWhenHidden); `#load` brings it back. */
  #unload(record: Record_) {
    record.unloaded = true;
    record.loaded = false;
    record.queue = [];
    record.iframe.src = "about:blank";
  }

  #remove(id: string) {
    const record = this.#records.get(id);
    if (!record) return;
    record.iframe.remove();
    this.#records.delete(id);
    if (record.kind === "view") this.#requested.delete(record.viewType);
    this.#emit();
    this.#schedule();
  }

  /** A panel restored with the window: shown as a tab until its extension brings it back. */
  createRestoring(saved: SavedWebview): string {
    const id = `r${Math.random().toString(36).slice(2, 10)}`;
    const record = this.#create(
      {
        id,
        kind: "panel",
        extensionId: "",
        viewType: saved.viewType,
        title: saved.title,
        options: saved.options ?? { enableScripts: true, enableForms: true, enableCommandUris: false, retainContextWhenHidden: false },
        uri: saved.uri,
      },
      true,
    );
    record.state = saved.state;
    this.#emit();
    return id;
  }

  /** Panels waiting for their serializer. */
  restoringPanels(): (SavedWebview & { id: string })[] {
    return [...this.#records.values()]
      .filter((record) => record.restoring)
      .map((record) => ({ id: record.id, viewType: record.viewType, title: record.title, state: record.state, options: record.options, uri: record.uri }));
  }

  /** Saved form of a panel (for the window state). */
  save(id: string): SavedWebview | null {
    const record = this.#records.get(id);
    if (!record || record.kind !== "panel") return null;
    return { viewType: record.viewType, title: record.title, state: record.state, options: record.options, uri: record.uri };
  }

  /** The webview id of the open custom editor (panel with a file) for `uri`, if any. */
  customEditorFor(uri: string | null | undefined): Record_ | undefined {
    if (!uri) return undefined;
    const key = uri.toLowerCase();
    return [...this.#records.values()].find((record) => record.kind === "panel" && record.uri && record.uri.toLowerCase() === key);
  }

  /** Custom editors with unsaved changes (for the window's close guard). */
  dirtyCustomEditors(): { uri: string; viewType: string; kind: "text" | "readonly" | "editable" }[] {
    return [...this.#records.values()]
      .filter((record) => record.kind === "panel" && record.uri && record.dirty && !record.restoring)
      .map((record) => ({ uri: record.uri!, viewType: record.viewType, kind: record.customKind ?? "text" }));
  }

  /** The user closed a panel's tab. */
  close(id: string) {
    const record = this.#records.get(id);
    if (!record) return;
    if (!record.restoring) extensionService.post({ type: "webviewClosed", id });
    this.#remove(id);
  }

  /** The extension host restarted: views reload, panels wait for their serializers. */
  hostRestarted() {
    for (const record of [...this.#records.values()]) {
      if (record.kind === "view") {
        this.#remove(record.id);
        continue;
      }
      record.restoring = true;
      record.iframe.src = "about:blank";
    }
    this.#requested.clear();
    this.#emit();
    this.#schedule();
  }

  /* ── slots ─────────────────────────────────────────────────────────── */

  attachSlot(key: string, element: HTMLElement) {
    this.#slots.set(key, element);
    this.#watch();
    this.#resizeObserver?.observe(element);
    this.#schedule();
  }

  detachSlot(key: string, element: HTMLElement) {
    if (this.#slots.get(key) === element) this.#slots.delete(key);
    this.#resizeObserver?.unobserve(element);
    this.#schedule();
  }

  /** Panels shown as the active editor of the active group. */
  setActivePanels(ids: string[]) {
    this.#activePanels = new Set(ids);
    this.#schedule();
  }

  /** Place the frames on the next frame (once, however often it is asked). */
  #schedule = () => {
    if (!this.#frame) this.#frame = requestAnimationFrame(this.#tick);
  };

  /**
   * Re-place the frames when the layout may have changed — slots resized,
   * DOM or class changes, transitions — instead of measuring every frame,
   * which kept the window busy as long as any webview existed.
   */
  #watch() {
    if (this.#resizeObserver) return;
    this.#resizeObserver = new ResizeObserver(this.#schedule);
    for (const slot of this.#slots.values()) this.#resizeObserver.observe(slot);
    this.#mutationObserver = new MutationObserver((records) => {
      // The frames' own style changes do not move any slot.
      if (records.some((record) => !this.#layer?.contains(record.target))) this.#schedule();
    });
    this.#mutationObserver.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style", "hidden"] });
    // Safety net for moves nothing above reports.
    this.#poll = setInterval(this.#schedule, 1000);
  }

  #unwatch() {
    this.#resizeObserver?.disconnect();
    this.#mutationObserver?.disconnect();
    if (this.#poll) clearInterval(this.#poll);
    this.#resizeObserver = null;
    this.#mutationObserver = null;
    this.#poll = null;
  }

  #tick = () => {
    this.#frame = 0;
    if (!this.#records.size && !this.#slots.size) {
      this.#unwatch();
      return;
    }
    this.#watch();
    // Views shown for the first time are resolved by their extension.
    for (const [key, slot] of this.#slots) {
      if (!key.startsWith("view:")) continue;
      const viewId = key.slice(5);
      if (this.#requested.has(viewId) || !extensionService.getSnapshot().ready || !this.#visible(slot)) continue;
      this.#requested.add(viewId);
      extensionService.post({ type: "webviewViewVisible", viewId, webviewId: `v${Math.random().toString(36).slice(2, 10)}`, state: this.#viewStates[viewId] });
    }
    for (const record of this.#records.values()) {
      const slot = this.#slots.get(record.kind === "panel" ? record.id : `view:${record.viewType}`);
      const visible = !!slot && this.#visible(slot);
      if (visible) {
        const rect = slot.getBoundingClientRect();
        const key = `${rect.left},${rect.top},${rect.width},${rect.height}`;
        if (key !== record.rect) {
          record.rect = key;
          Object.assign(record.iframe.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
        }
      }
      if (visible !== record.shown) {
        record.shown = visible;
        record.iframe.style.visibility = visible ? "visible" : "hidden";
        if (record.html && record.url && !record.restoring && !record.options.retainContextWhenHidden) {
          if (visible && record.unloaded) this.#load(record);
          else if (!visible && !record.unloaded) this.#unload(record);
        }
      }
      const active = record.kind === "panel" ? visible && this.#activePanels.has(record.id) : visible;
      const report = `${visible}:${active}`;
      if (report !== record.reported && !record.restoring) {
        record.reported = report;
        extensionService.post({ type: "webviewViewState", id: record.id, visible, active });
      }
    }
  };

  #visible(slot: HTMLElement): boolean {
    if (!slot.isConnected || slot.offsetParent === null) return false;
    const rect = slot.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /* ── messages ──────────────────────────────────────────────────────── */

  #onHost(message: HostToView) {
    switch (message.type) {
      case "ready":
        this.hostRestarted();
        return;
      case "webviewCreate": {
        const existing = this.#records.get(message.webview.id);
        if (existing) {
          // A restored panel, now owned by its extension again.
          Object.assign(existing, { ...message.webview, restoring: false, reported: "" });
          existing.iframe.setAttribute("sandbox", sandboxFor(message.webview.options));
        } else this.#create(message.webview);
        this.#emit();
        if (message.webview.kind === "panel")
          for (const listener of this.#panelListeners) listener({ type: "created", id: message.webview.id, reveal: message.reveal });
        return;
      }
      case "webviewHtml": {
        const record = this.#records.get(message.id);
        if (record) this.#setHtml(record, message.html);
        return;
      }
      case "webviewUpdate": {
        const record = this.#records.get(message.id);
        if (!record) return;
        if (message.title !== undefined) record.title = message.title;
        if (message.description !== undefined) record.description = message.description;
        if (message.badge !== undefined) record.badge = message.badge;
        if (message.dirty !== undefined) record.dirty = message.dirty;
        if (message.uri !== undefined) record.uri = message.uri;
        if (message.options) {
          const sandbox = sandboxFor(message.options);
          record.options = message.options;
          if (record.iframe.getAttribute("sandbox") !== sandbox) {
            // The sandbox only applies to new documents: reload the page.
            record.iframe.setAttribute("sandbox", sandbox);
            if (record.html) this.#setHtml(record, record.html);
          }
        }
        this.#emit();
        return;
      }
      case "webviewPost": {
        const record = this.#records.get(message.id);
        // A dropped page gets nothing, as in VS Code (it asks again when shown).
        if (!record || record.unloaded) return;
        if (record.loaded) record.iframe.contentWindow?.postMessage(message.message, "*");
        else record.queue.push(message.message);
        return;
      }
      case "webviewReveal": {
        const record = this.#records.get(message.id);
        if (!record) return;
        for (const listener of this.#panelListeners)
          listener({ type: "reveal", id: record.id, kind: record.kind, viewType: record.viewType, preserveFocus: message.preserveFocus });
        return;
      }
      case "webviewDispose":
        this.#remove(message.id);
        for (const listener of this.#panelListeners) listener({ type: "disposed", id: message.id });
        return;
    }
  }

  /**
   * Right click in a webview: Cut / Copy / Paste (unless the element's
   * data-vscode-context says preventDefaultContextMenuItems) and the
   * extensions' webview/context entries. The context's keys are context keys
   * (webviewSection, …) next to webviewId; commands get the context with `webview`.
   */
  #contextMenu(
    record: { iframe: HTMLIFrameElement; viewType: string },
    menu: { x: number; y: number; context: Record<string, unknown>; selection: boolean; editable: boolean },
  ) {
    const context = menu.context && typeof menu.context === "object" ? menu.context : {};
    const lookup = (key: string): unknown => (key === "webviewId" ? record.viewType : key in context ? context[key] : undefined);
    const contributed = contributedMenuItems("webview/context", lookup, [{ ...context, webview: record.viewType }]);
    const frame = record.iframe.contentWindow;
    const edit = (command: string, text?: string) => frame?.postMessage({ __lumenEdit: command, text }, "*");
    const own: ContextMenuItem[] = context.preventDefaultContextMenuItems
      ? []
      : [
          { type: "item", label: t("Cut"), action: "cut", disabled: !menu.editable || !menu.selection, run: () => edit("cut") },
          { type: "item", label: t("Copy"), action: "copy", disabled: !menu.selection, run: () => edit("copy") },
          {
            type: "item",
            label: t("Paste"),
            action: "paste",
            disabled: !menu.editable,
            run: () =>
              void navigator.clipboard.readText().then(
                (text) => edit("paste", text),
                () => {},
              ),
          },
        ];
    if (!own.length && !contributed.length) return;
    const rect = record.iframe.getBoundingClientRect();
    void showContextMenu(
      rect.left + menu.x,
      rect.top + menu.y,
      own.length && contributed.length ? [...contributed, { type: "separator" }, ...own] : [...contributed, ...own],
    );
  }

  #find(record: Record_, action: WebviewFindAction) {
    if (!record.loaded) return;
    record.iframe.focus();
    record.iframe.contentWindow?.postMessage({ __lumenFind: action }, "*");
  }

  /**
   * The webview find commands (editor.action.webvieweditor.showFind, ...): the active
   * panel's find bar, when it was created with enableFindWidget. False when there is none.
   */
  find(action: WebviewFindAction): boolean {
    const record = [...this.#records.values()].find(
      (candidate) => candidate.kind === "panel" && candidate.shown && this.#activePanels.has(candidate.id) && candidate.options.enableFindWidget,
    );
    if (!record) return false;
    this.#find(record, action);
    return true;
  }

  #onFrameMessage(event: MessageEvent) {
    const data = event.data as { __lumenWebview?: string; data?: unknown } | null;
    if (!data || typeof data.__lumenWebview !== "string") return;
    const record = [...this.#records.values()].find((candidate) => candidate.iframe.contentWindow === event.source);
    if (!record) return;
    switch (data.__lumenWebview) {
      case "message":
        if (!record.restoring) extensionService.post({ type: "webviewMessage", id: record.id, message: data.data });
        return;
      case "state":
        record.state = data.data;
        if (record.kind === "view") {
          this.#viewStates[record.viewType] = data.data;
          try {
            // Other windows write their views' states here too: keep theirs.
            const stored = JSON.parse(localStorage.getItem("lumen.webviewViewState") ?? "{}") as Record<string, unknown>;
            localStorage.setItem("lumen.webviewViewState", JSON.stringify({ ...stored, [record.viewType]: data.data }));
          } catch {
            /* too large or unavailable */
          }
        }
        for (const listener of this.#stateListeners) listener();
        return;
      case "link":
        void api().request.openExternal({ url: String(data.data) });
        return;
      case "command": {
        if (!record.options.enableCommandUris) return;
        const match = /^command:([^?]+)(?:\?(.*))?$/i.exec(String(data.data));
        if (!match) return;
        let args: unknown[] = [];
        try {
          const parsed = match[2] ? JSON.parse(decodeURIComponent(match[2])) : [];
          args = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          /* no arguments */
        }
        this.#commandHandler?.(match[1]!, args);
        return;
      }
      case "keydown": {
        const init = data.data as KeyboardEventInit;
        // Ctrl+F / F3 in a panel with enableFindWidget: the page's own find bar.
        const find = record.kind === "panel" && record.options.enableFindWidget ? webviewFindAction(init) : null;
        if (find) {
          this.#find(record, find);
          return;
        }
        window.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true }));
        return;
      }
      case "contextmenu":
        this.#contextMenu(record, data.data as { x: number; y: number; context: Record<string, unknown>; selection: boolean; editable: boolean });
        return;
      case "focus":
        if (record.kind === "panel")
          for (const listener of this.#panelListeners)
            listener({ type: "reveal", id: record.id, kind: "panel", viewType: record.viewType, preserveFocus: true });
        return;
    }
  }
}

export const webviewService = new WebviewService();

export function useWebviews(): WebviewInfo[] {
  return useSyncExternalStore(webviewService.subscribe, webviewService.getSnapshot);
}
