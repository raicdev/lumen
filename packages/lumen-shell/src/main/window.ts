import { randomBytes } from "crypto";
import { Emitter } from "../shared/emitter.ts";
import type { RpcApi, RpcHandlers, RPCSchema } from "../shared/protocol.ts";
import type { Envelope } from "../shared/protocol.ts";
import { RpcEndpoint, createApi } from "../shared/rpc.ts";
import { NativeWebview, SizeHint, type NativeHandle } from "./native/webview.ts";
import { platform } from "./native/index.ts";
import type { MenuGroup, PageRect, ResizeEdge, WindowState } from "./native/platform.ts";
import { prelude } from "../view/prelude.ts";
import { app } from "./app.ts";

export type CloseGuard = () => boolean | Promise<boolean>;

/** Something `defineMainRPC()` can attach to a window. */
export type RpcAttachment<S extends RPCSchema> = {
  attach(window: BrowserWindow<S>): void;
  handlers: RpcHandlers;
};

export type BrowserWindowOptions<S extends RPCSchema = RPCSchema> = {
  title?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  minWidth?: number;
  minHeight?: number;
  resizable?: boolean;
  /** HTTP(S) URL or a plain path to load. */
  url?: string;
  html?: string;
  /** Enable WebView2 devtools (F12 / Ctrl+Shift+I). */
  debug?: boolean;
  /**
   * `false` removes the OS title bar so the page can draw its own. Mark drag
   * areas with `data-lumen-drag-region` and use `window.__lumen.window` for the
   * minimize / maximize / close buttons.
   */
  frame?: boolean;
  /** Background (`#rrggbb`) shown before the page paints — match your app's. */
  backgroundColor?: string;
  /**
   * Show the window as soon as the page has rendered (default `true`). With
   * `false`, call `show()` yourself (e.g. from `ready-to-show`).
   */
  show?: boolean;
  rpc?: RpcAttachment<S>;
  /** Async guard consulted before the window closes (unsaved changes…). */
  closeGuard?: CloseGuard;
};

export type WindowEvents = {
  ready: [];
  /** The page has rendered its first frame. */
  "ready-to-show": [];
  maximize: [];
  unmaximize: [];
  closed: [];
  "menu-action": [action: string];
};

/**
 * The renderer-facing handle: send messages, issue requests, evaluate JS.
 * `send` / `request` are typed by the RPC schema passed to `defineMainRPC()`.
 */
export class WebContents<S extends RPCSchema = RPCSchema> {
  #window: BrowserWindow<S>;

  constructor(window: BrowserWindow<S>) {
    this.#window = window;
  }

  /** Post a typed message to the page. */
  get send(): RpcApi<S, "webview">["send"] {
    return this.#window.endpointApi.send;
  }

  /** Ask the page something and await the answer. */
  get request(): RpcApi<S, "webview">["request"] {
    return this.#window.endpointApi.request;
  }

  /** Fire-and-forget message on an untyped channel. */
  post(channel: string, payload: unknown): void {
    this.#window.postToView({ t: "msg", ns: "webview", ch: channel, payload });
  }

  /** Request on an untyped channel. */
  call(channel: string, payload: unknown): Promise<unknown> {
    return this.#window.endpoint.request(channel, payload);
  }

  /** Evaluate JavaScript in the page (result is ignored). */
  eval(source: string): void {
    this.#window.native.eval(source);
  }

  reload(): void {
    this.#window.native.eval("location.reload()");
  }

  /** Install the in-page menu bar (used when the platform has no native menus). */
  installMenu(menu: MenuGroup[]): void {
    this.post("__lumen:install-menu", menu);
  }
}

export class BrowserWindow<S extends RPCSchema = RPCSchema> {
  readonly webContents: WebContents<S>;
  readonly events = new Emitter<WindowEvents>();

  #native: NativeWebview;
  /** Proves a bridge call comes from this window's own page (see prelude()). */
  #bridgeToken = randomBytes(16).toString("hex");
  #endpoint: RpcEndpoint;
  #api: RpcApi<S, "webview">;
  #outbox: Envelope[] = [];
  #ready = false;
  #destroyed = false;
  #guard: CloseGuard | null = null;
  #guardPassed = false;
  #guardRunning = false;
  #title = "Lumen";
  #frameless = false;
  #autoShow = true;
  #shown = false;
  #readyToShow = false;
  #revealTimer: ReturnType<typeof setTimeout> | null = null;
  #state: WindowState = "normal";

  constructor(options: BrowserWindowOptions<S> = {}) {
    const width = options.width ?? 1024;
    const height = options.height ?? 720;

    this.#title = options.title ?? app.name;
    this.#frameless = options.frame === false && typeof platform().startDrag === "function";
    this.#autoShow = options.show !== false;

    // WebView2 paints this until the page's first frame (instead of white).
    const background = webView2Color(options.backgroundColor);
    if (background) process.env.WEBVIEW2_DEFAULT_BACKGROUND_COLOR = background;

    this.#native = new NativeWebview({ debug: options.debug ?? !app.packaged });
    this.#guard = options.closeGuard ?? null;

    this.#endpoint = new RpcEndpoint({
      ns: "main",
      peerNs: "webview",
      outbound: (envelope) => {
        this.postToView(envelope);
        return null;
      },
      handlers: {},
      timeoutMs: 60_000,
      log: (message) => console.warn(`[lumen-shell] ${message}`),
    });
    this.#api = createApi<S, "webview">(this.#endpoint);
    this.webContents = new WebContents<S>(this);

    app.registerWindow(this as unknown as BrowserWindow<RPCSchema>);

    // The native window is still hidden here: style it (frame, background) and
    // keep it invisible until the page has painted, so nothing flashes.
    const handle = this.#native.windowHandle;
    platform().subclassWindow(handle, this.#hooks(), {
      frameless: this.#frameless,
      backgroundColor: options.backgroundColor,
      hidden: true,
    });

    this.#native.setSize(width, height, options.resizable === false ? SizeHint.Fixed : SizeHint.None);
    this.#native.setTitle(this.#title);
    if (options.minWidth && options.minHeight) {
      this.#native.setSize(options.minWidth, options.minHeight, SizeHint.Min);
    }

    if (options.x !== undefined || options.y !== undefined) {
      platform().moveResize(handle, { x: options.x, y: options.y });
    } else {
      platform().center(handle, width, height);
    }

    // Bridge + prelude must exist before the page starts loading.
    this.#native.initScript(`window.__lumenWindowOptions = ${JSON.stringify({ frameless: this.#frameless })};`);
    this.#native.initScript(prelude(this.#bridgeToken, options.url ? new URL(options.url).origin : null));
    this.#native.bind("__lumen_invoke", (_seq, args) => this.#handleBridge(args));

    // Never leave the window invisible if the page fails to report its first frame.
    if (this.#autoShow) this.#revealTimer = setTimeout(() => this.show(), 3000);

    options.rpc?.attach(this);

    if (options.html) this.#native.setHtml(options.html);
    else if (options.url) this.#native.navigate(options.url);
  }

  /** Underlying native window / webview handles. */
  get native(): NativeWebview {
    return this.#native;
  }

  get handle(): NativeHandle {
    return this.#native.windowHandle;
  }

  /** @internal used by WebContents */
  get endpoint(): RpcEndpoint {
    return this.#endpoint;
  }

  /** @internal used by WebContents */
  get endpointApi(): RpcApi<S, "webview"> {
    return this.#api;
  }

  get title(): string {
    return this.#title;
  }

  get destroyed(): boolean {
    return this.#destroyed;
  }

  get isReady(): boolean {
    return this.#ready;
  }

  get frameless(): boolean {
    return this.#frameless;
  }

  setTitle(title: string): void {
    this.#title = title;
    this.#native.setTitle(title);
    try {
      platform().setTitle(this.handle, title);
    } catch {
      /* title is already set through the webview */
    }
  }

  /** Arm/replace the close guard (unsaved changes protection). */
  setCloseGuard(guard: CloseGuard | null): void {
    this.#guard = guard;
  }

  /** @internal */
  setRpcHandlers(handlers: RpcHandlers): void {
    this.#endpoint.setHandlers(handlers);
  }

  /** @internal */
  postToView(envelope: Envelope): void {
    if (this.#destroyed) return;
    if (!this.#ready) {
      this.#outbox.push(envelope);
      return;
    }
    const payload = JSON.stringify(JSON.stringify(envelope));
    this.#native.eval(`window.__lumen && window.__lumen.receive(${payload})`);
  }

  /** Ask the window to close, honouring the close guard. */
  async requestClose(): Promise<boolean> {
    if (this.#destroyed) return true;

    if (this.#guard && !this.#guardPassed) {
      if (this.#guardRunning) return false;
      this.#guardRunning = true;
      let allow = true;
      try {
        allow = await this.#guard();
      } catch (error) {
        console.warn("[lumen-shell] close guard failed:", error);
        allow = true;
      } finally {
        this.#guardRunning = false;
      }
      if (!allow) return false;
      this.#guardPassed = true;
    }

    this.destroy();
    return true;
  }

  /** Destroy the window immediately, bypassing the guard. */
  destroy(): void {
    if (this.#destroyed) return;
    const handle = this.#native.windowPointer;
    this.#destroyed = true;
    this.#clearRevealTimer();
    this.#endpoint.close("Window was closed");
    this.#native.destroy();
    if (handle) platform().releaseWindow?.(handle);
    app.unregisterWindow(this as unknown as BrowserWindow<RPCSchema>);
    this.events.emit("closed");
  }

  /** Make the window visible (see the `show` option). */
  show(): void {
    this.#clearRevealTimer();
    if (this.#destroyed || this.#shown) return;
    this.#shown = true;
    platform().revealWindow?.(this.handle);
  }

  minimize(): void {
    platform().minimize(this.handle);
  }

  maximize(): void {
    if (!platform().isMaximized(this.handle)) platform().toggleMaximize(this.handle);
  }

  unmaximize(): void {
    if (platform().isMaximized(this.handle)) platform().toggleMaximize(this.handle);
  }

  toggleMaximize(): void {
    platform().toggleMaximize(this.handle);
  }

  isMaximized(): boolean {
    return platform().isMaximized(this.handle);
  }

  focus(): void {
    platform().focus(this.handle);
  }

  on<K extends keyof WindowEvents>(event: K, listener: (...args: WindowEvents[K]) => void): () => void {
    return this.events.on(event, listener);
  }

  #hooks() {
    const self = this;
    return {
      hasCloseGuard: () => !!self.#guard && !self.#guardPassed,
      onClose: () => {
        void self.requestClose();
      },
      onDestroyed: () => {
        // The OS destroyed the window (user clicked the frame button); the
        // webview engine already posted a quit message, so do not call
        // webview_destroy() again here.
        if (self.#destroyed) return;
        self.#destroyed = true;
        self.#endpoint.close("Window was closed");
        app.unregisterWindow(self as unknown as BrowserWindow<RPCSchema>);
        self.events.emit("closed");
      },
      onMenuAction: (action: string) => {
        self.events.emit("menu-action", action);
      },
      onStateChange: (state: WindowState) => {
        if (state === self.#state) return;
        const wasMaximized = self.#state === "maximized";
        const wasMinimized = self.#state === "minimized";
        self.#state = state;
        // A minimized window lets WebView2 give memory back until it is shown again.
        if (state === "minimized") self.#native.setMemoryUsageTargetLevel("low");
        else if (wasMinimized) self.#native.setMemoryUsageTargetLevel("normal");
        if (state === "maximized") self.events.emit("maximize");
        else if (wasMaximized && state === "normal") self.events.emit("unmaximize");
        self.#pushWindowState();
      },
      onMaximizeButtonState: ({ hover, pressed }: { hover: boolean; pressed: boolean }) => {
        if (!self.#ready || self.#destroyed) return;
        self.#native.eval(`window.__lumen && window.__lumen.setMaximizeButtonState(${hover}, ${pressed})`);
      },
    };
  }

  #clearRevealTimer(): void {
    if (this.#revealTimer) clearTimeout(this.#revealTimer);
    this.#revealTimer = null;
  }

  /** Mirror the window state into the page (`html.lumen-maximized`, `lumen:window-state`). */
  #pushWindowState(): void {
    if (!this.#ready || this.#destroyed) return;
    this.#native.eval(`window.__lumen && window.__lumen.setWindowState(${JSON.stringify(this.#state)})`);
  }

  #handleWindowControl(action: string): void {
    const platformApi = platform();
    if (action === "drag") platformApi.startDrag?.(this.handle);
    else if (action.startsWith("resize:")) {
      const edge = action.slice("resize:".length) as ResizeEdge;
      if (edge === "top" || edge === "top-left" || edge === "top-right") platformApi.startResize?.(this.handle, edge);
    } else if (action === "minimize") this.minimize();
    else if (action === "toggle-maximize") this.toggleMaximize();
    else if (action === "close") void this.requestClose();
    else if (action.startsWith("snap:")) {
      const values = action.slice("snap:".length).split(",").map(Number);
      const rect: PageRect | null =
        values.length === 6 && values.every(Number.isFinite)
          ? {
              x: values[0],
              y: values[1],
              width: values[2],
              height: values[3],
              viewportWidth: values[4],
              viewportHeight: values[5],
            }
          : null;
      // Creates a native child window: do it outside the webview's message
      // callback (nested window creation inside it crashes the process).
      setImmediate(() => {
        if (!this.#destroyed) platformApi.setMaximizeButtonRegion?.(this.handle, rect);
      });
    }
  }

  #handleBridge(args: unknown[]): unknown {
    // Only the prelude of the app's own page knows the token (see prelude()).
    if (args[2] !== this.#bridgeToken) return null;
    const channel = typeof args[0] === "string" ? (args[0] as string) : "";
    const data = typeof args[1] === "string" ? (args[1] as string) : "";

    if (channel === "__lumen:ready") {
      this.#markReady();
      this.#pushWindowState();
      return null;
    }
    if (channel === "__lumen:show") {
      if (!this.#readyToShow) {
        this.#readyToShow = true;
        this.events.emit("ready-to-show");
      }
      if (this.#autoShow) this.show();
      return null;
    }
    if (channel === "__lumen:window") {
      this.#handleWindowControl(data);
      return null;
    }
    if (channel === "__lumen:menu") {
      const action = typeof args[1] === "string" ? (args[1] as string) : "";
      if (action) this.events.emit("menu-action", action);
      return null;
    }
    if (channel === "__lumen:ipc") {
      return this.#endpoint.receive(data);
    }
    return null;
  }

  #markReady(): void {
    if (this.#ready) return;
    this.#ready = true;
    const queued = this.#outbox;
    this.#outbox = [];
    for (const envelope of queued) this.postToView(envelope);
    this.events.emit("ready");
  }
}

/** `#rrggbb` → the `AARRGGBB` form WebView2 reads from its environment. */
function webView2Color(value: string | undefined): string | null {
  const match = value ? /^#?([0-9a-f]{6})$/i.exec(value.trim()) : null;
  return match ? `FF${match[1].toUpperCase()}` : null;
}
