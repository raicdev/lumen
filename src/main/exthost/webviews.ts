import type { HostWebviewOptions } from "../../shared/extensions.ts";
import type { ExtensionHost, ExtensionRuntime } from "./host.ts";
import * as T from "./types.ts";
import { toWire } from "./wire.ts";
import { webviewOrigin } from "../../shared/webview-document.ts";

/**
 * Webviews: panels in the editor area (window.createWebviewPanel, restored
 * through registerWebviewPanelSerializer) and views in view containers
 * (registerWebviewViewProvider). The view renders them in sandboxed iframes;
 * the host keeps the API objects and relays html, messages and state.
 */

type Entry = {
  kind: "panel" | "view";
  receive: T.EventEmitter<unknown>;
  closed: () => void;
  state: (visible: boolean, active: boolean) => void;
};

type ViewProvider = { provider: { resolveWebviewView: (view: unknown, context: unknown, token: unknown) => unknown }; extensionId: string; retain: boolean };
type Serializer = { serializer: { deserializeWebviewPanel: (panel: unknown, state: unknown) => unknown }; runtime: ExtensionRuntime | null };

type RawOptions = {
  enableScripts?: boolean;
  enableForms?: boolean;
  enableCommandUris?: boolean | readonly string[];
  localResourceRoots?: readonly T.Uri[];
  retainContextWhenHidden?: boolean;
  enableFindWidget?: boolean;
  portMapping?: unknown;
};

export class WebviewManager {
  readonly #host: ExtensionHost;
  #seq = 0;
  readonly #entries = new Map<string, Entry>();
  readonly viewProviders = new Map<string, ViewProvider>();
  readonly serializers = new Map<string, Serializer>();
  /** Views the view showed before their provider was there. */
  readonly #pendingViews = new Map<string, { webviewId: string; state: unknown }>();
  readonly #resolvedViews = new Set<string>();

  constructor(host: ExtensionHost) {
    this.#host = host;
  }

  #hostOptions(raw: RawOptions): HostWebviewOptions {
    return {
      enableScripts: !!raw.enableScripts,
      // Forms default to the scripts setting, like VS Code.
      enableForms: raw.enableForms ?? !!raw.enableScripts,
      enableCommandUris: !!raw.enableCommandUris,
      retainContextWhenHidden: !!raw.retainContextWhenHidden,
    };
  }

  /** The `Webview` object (shared by panels and views). */
  #createWebview(id: string, runtime: ExtensionRuntime | null, initial: RawOptions, onOptions: (options: HostWebviewOptions) => void) {
    const host = this.#host;
    let raw: RawOptions = { ...initial };
    let html = "";
    let disposed = false;
    const receive = new T.EventEmitter<unknown>();
    const toHost = () => this.#hostOptions(raw);
    const origin = webviewOrigin(runtime?.id ?? "unknown", host.init.webviewPort);
    const setRoots = () => {
      const defaults = [runtime?.description.location, host.workspace].filter((path): path is string => !!path).map((path) => T.Uri.file(path));
      const roots = (raw.localResourceRoots ?? defaults)
        .map((uri) => T.Uri.revive(uri)!)
        .filter((uri) => uri.scheme === "file")
        .map((uri) => uri.fsPath);
      // Sent before the html, so the files are reachable when the page loads.
      void host.requestMain("setWebviewRoots", id, roots);
    };
    setRoots();
    const webview = {
      get html() {
        return html;
      },
      set html(value: string) {
        html = String(value);
        if (!disposed) host.post({ type: "webviewHtml", id, html });
      },
      get options() {
        return raw;
      },
      set options(value: RawOptions) {
        raw = { ...value };
        setRoots();
        onOptions(toHost());
      },
      // The page's own origin (one per extension): resources load same-origin.
      get cspSource() {
        return origin;
      },
      asWebviewUri: (uri: T.Uri) => {
        const target = T.Uri.revive(uri)!;
        if (target.scheme !== "file") return target;
        const path = target.fsPath.replace(/\\/g, "/").replace(/^\/+/, "");
        return T.Uri.from({
          scheme: "http",
          authority: origin.replace(/^https?:\/\//, ""),
          path: `/${host.init.webviewToken}/${encodeURIComponent(id)}/${path}`,
        });
      },
      postMessage: async (message: unknown) => {
        if (disposed) return false;
        host.post({ type: "webviewPost", id, message: toWire(message) });
        return true;
      },
      onDidReceiveMessage: receive.event,
    };
    return {
      webview,
      receive,
      options: toHost,
      dispose: () => {
        disposed = true;
        receive.dispose();
      },
    };
  }

  /* ── panels ────────────────────────────────────────────────────────── */

  createPanel(
    runtime: ExtensionRuntime | null,
    viewType: string,
    title: string,
    showOptions: number | { viewColumn?: number; preserveFocus?: boolean } | undefined,
    options: RawOptions = {},
    restoreId?: string,
    custom?: { uri?: string; dirty?: boolean; customKind?: "text" | "readonly" | "editable" },
  ): Record<string, unknown> {
    const host = this.#host;
    // Not guessable: the id is part of the page's and its files' URLs.
    const id = restoreId ?? `h${++this.#seq}${Math.random().toString(36).slice(2, 10)}`;
    const column = typeof showOptions === "object" ? showOptions?.viewColumn : showOptions;
    const preserveFocus = typeof showOptions === "object" ? !!showOptions?.preserveFocus : false;
    const extensionId = runtime?.id ?? "unknown";
    let currentTitle = title;
    let visible = true;
    let active = !preserveFocus;
    let disposed = false;
    const disposeEmitter = new T.EventEmitter<void>();
    const stateEmitter = new T.EventEmitter<unknown>();
    const parts = this.#createWebview(id, runtime, options, (hostOptions) => {
      if (!disposed) host.post({ type: "webviewUpdate", id, options: hostOptions });
    });
    const panel: Record<string, unknown> = {
      /** The webview's id (part of its page URL); not part of the public WebviewPanel API. */
      id,
      webview: parts.webview,
      viewType,
      get title() {
        return currentTitle;
      },
      set title(value: string) {
        currentTitle = String(value);
        if (!disposed) host.post({ type: "webviewUpdate", id, title: currentTitle });
      },
      iconPath: undefined,
      get options() {
        return { ...parts.webview.options, enableFindWidget: options.enableFindWidget, retainContextWhenHidden: options.retainContextWhenHidden };
      },
      get viewColumn() {
        return column === T.ViewColumn.Beside ? T.ViewColumn.Two : (column ?? T.ViewColumn.One);
      },
      get active() {
        return active;
      },
      get visible() {
        return visible;
      },
      onDidDispose: disposeEmitter.event,
      onDidChangeViewState: stateEmitter.event,
      reveal: (_column?: number, keepFocus = false) => {
        if (!disposed) host.post({ type: "webviewReveal", id, preserveFocus: keepFocus });
      },
      dispose: () => {
        if (disposed) return;
        host.post({ type: "webviewDispose", id });
        finish();
      },
    };
    const finish = () => {
      if (disposed) return;
      disposed = true;
      this.#entries.delete(id);
      parts.dispose();
      disposeEmitter.fire();
      disposeEmitter.dispose();
      stateEmitter.dispose();
    };
    this.#entries.set(id, {
      kind: "panel",
      receive: parts.receive,
      closed: finish,
      state: (nextVisible, nextActive) => {
        if (nextVisible === visible && nextActive === active) return;
        visible = nextVisible;
        active = nextActive;
        stateEmitter.fire({ webviewPanel: panel });
      },
    });
    host.post({
      type: "webviewCreate",
      webview: { id, kind: "panel", extensionId, viewType, title, options: parts.options(), ...(custom ?? {}) },
      reveal: restoreId ? undefined : { preserveFocus, beside: column === T.ViewColumn.Beside },
    });
    return panel;
  }

  registerSerializer(runtime: ExtensionRuntime | null, viewType: string, serializer: Serializer["serializer"]): T.Disposable {
    if (this.serializers.has(viewType)) throw new Error(`a webview panel serializer for '${viewType}' is already registered`);
    this.serializers.set(viewType, { serializer, runtime });
    return new T.Disposable(() => {
      if (this.serializers.get(viewType)?.serializer === serializer) this.serializers.delete(viewType);
    });
  }

  /** The window was restored with a panel of this type: let its serializer bring it back. */
  async deserialize(viewType: string, webviewId: string, title: string, state: unknown, options: HostWebviewOptions | null): Promise<boolean> {
    await this.#host.activateByEvent(`onWebviewPanel:${viewType}`);
    const entry = this.serializers.get(viewType);
    if (!entry) return false;
    const panel = this.createPanel(entry.runtime, viewType, title, { viewColumn: T.ViewColumn.Active, preserveFocus: true }, options ?? { enableScripts: true }, webviewId);
    try {
      await entry.serializer.deserializeWebviewPanel(panel, state);
      return true;
    } catch (error) {
      this.#host.log("error", `restoring a ${viewType} webview failed: ${error instanceof Error ? error.message : error}`, entry.runtime?.id);
      (panel.dispose as () => void)();
      return false;
    }
  }

  /* ── views ─────────────────────────────────────────────────────────── */

  registerViewProvider(runtime: ExtensionRuntime | null, viewId: string, provider: ViewProvider["provider"], options?: { webviewOptions?: { retainContextWhenHidden?: boolean } }): T.Disposable {
    if (this.viewProviders.has(viewId)) throw new Error(`a webview view provider for '${viewId}' is already registered`);
    this.viewProviders.set(viewId, { provider, extensionId: runtime?.id ?? "unknown", retain: !!options?.webviewOptions?.retainContextWhenHidden });
    queueMicrotask(() => void this.#resolveView(viewId));
    return new T.Disposable(() => {
      if (this.viewProviders.get(viewId)?.provider === provider) this.viewProviders.delete(viewId);
    });
  }

  /** A contributed webview view is shown for the first time. */
  viewVisible(viewId: string, webviewId: string, state: unknown): void {
    if (this.#resolvedViews.has(viewId)) return;
    this.#pendingViews.set(viewId, { webviewId, state });
    void this.#host.activateByEvent(`onView:${viewId}`).then(() => this.#resolveView(viewId));
  }

  async #resolveView(viewId: string): Promise<void> {
    const pending = this.#pendingViews.get(viewId);
    const entry = this.viewProviders.get(viewId);
    if (!pending || !entry || this.#resolvedViews.has(viewId)) return;
    this.#pendingViews.delete(viewId);
    this.#resolvedViews.add(viewId);
    const host = this.#host;
    const id = pending.webviewId;
    const runtime = host.runtimes.get(entry.extensionId.toLowerCase()) ?? null;
    let title: string | undefined;
    let description: string | undefined;
    let badge: { value: number; tooltip: string } | undefined;
    let visible = true;
    const disposeEmitter = new T.EventEmitter<void>();
    const visibility = new T.EventEmitter<void>();
    const parts = this.#createWebview(id, runtime, {}, (hostOptions) => host.post({ type: "webviewUpdate", id, options: hostOptions }));
    const view: Record<string, unknown> = {
      viewType: viewId,
      webview: parts.webview,
      get title() {
        return title;
      },
      set title(value: string | undefined) {
        title = value;
        host.post({ type: "webviewUpdate", id, title: value ?? "" });
      },
      get description() {
        return description;
      },
      set description(value: string | undefined) {
        description = value;
        host.post({ type: "webviewUpdate", id, description: value ?? "" });
      },
      get badge() {
        return badge;
      },
      set badge(value: { value: number; tooltip: string } | undefined) {
        badge = value;
        host.post({ type: "webviewUpdate", id, badge: value ?? null });
      },
      get visible() {
        return visible;
      },
      onDidDispose: disposeEmitter.event,
      onDidChangeVisibility: visibility.event,
      show: (preserveFocus = false) => host.post({ type: "webviewReveal", id, preserveFocus }),
    };
    this.#entries.set(id, {
      kind: "view",
      receive: parts.receive,
      closed: () => {
        this.#entries.delete(id);
        this.#resolvedViews.delete(viewId);
        parts.dispose();
        disposeEmitter.fire();
      },
      state: (nextVisible) => {
        if (nextVisible === visible) return;
        visible = nextVisible;
        visibility.fire();
      },
    });
    host.post({ type: "webviewCreate", webview: { id, kind: "view", extensionId: entry.extensionId, viewType: viewId, title: "", options: parts.options() } });
    try {
      await entry.provider.resolveWebviewView(view, { state: pending.state }, new T.CancellationTokenSource().token);
    } catch (error) {
      host.log("error", `resolving the webview view ${viewId} failed: ${error instanceof Error ? (error.stack ?? error.message) : error}`, entry.extensionId);
    }
  }

  /* ── messages from the view ────────────────────────────────────────── */

  receive(id: string, message: unknown): void {
    this.#entries.get(id)?.receive.fire(message);
  }

  viewState(id: string, visible: boolean, active: boolean): void {
    this.#entries.get(id)?.state(visible, active);
  }

  closed(id: string): void {
    this.#entries.get(id)?.closed();
  }
}
