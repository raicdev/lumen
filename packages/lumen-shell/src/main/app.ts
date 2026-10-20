import { Emitter } from "../shared/emitter.ts";
import type { RPCSchema } from "../shared/protocol.ts";
import type { BrowserWindow } from "./window.ts";
import { platform } from "./native/index.ts";
import { setTimeout as sleep } from "timers/promises";
import { assetRoot, assetUrl, stablePort, startAssetServer } from "./assets.ts";

export type AppEvents = {
  ready: [];
  "window-all-closed": [];
  "before-quit": [];
  quit: [];
};

export type AppConfig = {
  name?: string;
  version?: string;
  identifier?: string;
  /** Directory served to windows when not using an absolute URL. */
  assetsDir?: string;
};

class LumenApp {
  readonly events = new Emitter<AppEvents>();

  #windows = new Set<BrowserWindow<RPCSchema>>();
  #order: BrowserWindow<RPCSchema>[] = [];
  #config: Required<AppConfig> = {
    name: "Lumen",
    version: "0.1.0",
    identifier: "dev.lumen.app",
    assetsDir: "",
  };
  #quitRequested = false;
  #running = false;
  #exitOnLastWindowClosed = true;

  configure(config: AppConfig): void {
    Object.assign(this.#config, config);
  }

  get name(): string {
    return this.#config.name;
  }

  get version(): string {
    return this.#config.version;
  }

  get identifier(): string {
    return this.#config.identifier;
  }

  /** True for packaged builds (no dev server / asset watcher). */
  get packaged(): boolean {
    return !process.env.LUMEN_DEV;
  }

  get running(): boolean {
    return this.#running;
  }

  get windows(): BrowserWindow<RPCSchema>[] {
    return [...this.#windows];
  }

  /** Most recently created window — handy for dialogs and menu ownership. */
  get lastWindow(): BrowserWindow<RPCSchema> | null {
    return this.#order[this.#order.length - 1] ?? null;
  }

  /** @internal */
  registerWindow(window: BrowserWindow<RPCSchema>): void {
    this.#windows.add(window);
    this.#order.push(window);
  }

  /** @internal */
  unregisterWindow(window: BrowserWindow<RPCSchema>): void {
    if (!this.#windows.delete(window)) return;
    this.#order = this.#order.filter((entry) => entry !== window);
    if (this.#windows.size === 0 && this.#running) this.events.emit("window-all-closed");
  }

  /**
   * Whether closing the last window terminates the process (default `true`,
   * like Electron). Disable it for apps that keep running in the background
   * (e.g. a macOS-style app that reopens a window from the dock).
   */
  setExitOnLastWindowClosed(enabled: boolean): void {
    this.#exitOnLastWindowClosed = enabled;
  }

  on<K extends keyof AppEvents>(event: K, listener: (...args: AppEvents[K]) => void): () => void {
    return this.events.on(event, listener);
  }

  once<K extends keyof AppEvents>(event: K, listener: (...args: AppEvents[K]) => void): () => void {
    return this.events.once(event, listener);
  }

  /** Resolve a URL for a file inside the assets directory (available from `ready` on). */
  assetUrl(relative: string): string {
    return assetUrl(relative);
  }

  reloadAllWindows(): void {
    for (const window of this.windows) {
      if (!window.destroyed) window.webContents.reload();
    }
  }

  /** Ask every window to close (running its close guard) and stop the loop. */
  async quit(): Promise<void> {
    if (this.#quitRequested) return;
    this.events.emit("before-quit");
    for (const window of this.windows) {
      const closed = await window.requestClose();
      if (!closed) return; // user cancelled (unsaved changes)
    }
    this.#quitRequested = true;
  }

  /** Terminate immediately (no guards). */
  exit(): void {
    this.#quitRequested = true;
  }

  /**
   * Emit `ready` (create your windows here) and then run the native event loop
   * until every window is gone or `quit()`/`exit()` was called.
   */
  async run(): Promise<void> {
    if (this.#running) return;
    this.#running = true;

    // Windows load their pages from the asset server, so it must listen first.
    await startAssetServer(this.#config.assetsDir || assetRoot(), stablePort(this.#config.identifier));

    this.events.emit("ready");
    await platform().runMessageLoop({
      shouldContinue: () => !this.#quitRequested && this.#windows.size > 0,
    });
    this.#running = false;
    this.events.emit("quit");

    if (this.#exitOnLastWindowClosed) {
      // Give `quit` listeners a chance to flush (kill PTYs, close handles…).
      await sleep(50);
      process.exit(0);
    }
  }
}

export const app = new LumenApp();
