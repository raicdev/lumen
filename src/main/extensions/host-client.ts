import { Worker } from "worker_threads";
import { spawn } from "child_process";
import { dirname } from "path";
import { fileURLToPath } from "url";
import type { ConfigSnapshot, HostMethods, HostToView, MainMethods, ViewToHost } from "../../shared/extensions.ts";
import type { HostInit, HostToMain, MainToHost } from "../exthost/protocol.ts";
import { workerEntry } from "../workers.ts";
import { languageIds } from "../language.ts";
import { killTree } from "../tasks/process.ts";
import { ExtensionManager, getDisplayLanguage, userDataDir } from "./manager.ts";
import type { WebviewResourceServer } from "./webview-server.ts";

/**
 * Main-thread side of the extension host: starts the worker, relays messages
 * between it and the view, answers its dialog / OS requests, and restarts it
 * (after installs, or when it crashed).
 */

/** Heap limit of the extension host worker (all extensions together). */
const HOST_HEAP_MB = 4096;

type Dialogs = {
  showOpenDialog: (options: { title?: string; defaultPath?: string; folders?: boolean; many?: boolean }) => Promise<string[]>;
  showSaveDialog: (options: { title?: string; defaultPath?: string }) => Promise<string | null>;
};

type Options = {
  appName: string;
  appVersion: string;
  manager: ExtensionManager;
  toView: (message: HostToView) => void;
  dialogs: Dialogs;
  /** Shared by every window's host: each forgets only its own webviews. */
  webviews: WebviewResourceServer;
  /** An extension wrote a memento file (globalState, secrets…): other windows' hosts reload it. */
  onStateChanged?: (file: string, key: string) => void;
};

/** Open a web link in the default browser (no shell involved, so the URL cannot inject commands). */
export function openExternal(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!["http:", "https:", "mailto:"].includes(parsed.protocol)) return false;
  const href = parsed.href;
  const [command, args] =
    process.platform === "win32"
      ? ["rundll32.exe", ["url.dll,FileProtocolHandler", href]]
      : process.platform === "darwin"
        ? ["open", [href]]
        : ["xdg-open", [href]];
  try {
    spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return true;
  } catch {
    return false;
  }
}

export class ExtensionHostClient {
  #options: Options;
  #worker: Worker | null = null;
  #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  #seq = 0;
  #config: ConfigSnapshot = { lumen: {}, user: {} };
  #workspace: string | null = null;
  #generation = 0;
  /** Webviews this host made (the webview server is shared with other windows). */
  #webviewIds = new Set<string>();

  constructor(options: Options) {
    this.#options = options;
  }

  get running(): boolean {
    return !!this.#worker;
  }

  /** pid → id of the extension that started the process. */
  #childProcesses = new Map<number, string>();

  /** Extensions' processes among `alive` (entries for processes that are gone are dropped). */
  childProcessOwners(alive: Set<number>): Map<number, string> {
    for (const pid of this.#childProcesses.keys()) if (!alive.has(pid)) this.#childProcesses.delete(pid);
    return this.#childProcesses;
  }

  /** Bytes of JavaScript heap in use (all extensions together), or null while stopped. */
  async heapUsed(): Promise<number | null> {
    const stats = await this.#worker?.getHeapStatistics().catch(() => null);
    return stats ? stats.used_heap_size : null;
  }

  /** (Re)start with the enabled extensions. The view re-sends its documents when it sees "ready". */
  async start(config: ConfigSnapshot, workspace: string | null): Promise<number> {
    this.#config = config;
    this.#workspace = workspace;
    await this.stop();
    const webviewPort = await this.#options.webviews.start();
    this.#forgetWebviews();
    const generation = ++this.#generation;
    const extensions = this.#options.manager.enabled();
    // The heap cap makes an extension that runs out of memory end this worker (and the
    // view restarts it) instead of aborting the whole app with every unsaved editor.
    const worker = new Worker(workerEntry(), { workerData: { lumenWorker: "exthost" }, resourceLimits: { maxOldGenerationSizeMb: HOST_HEAP_MB } });
    worker.unref();
    this.#worker = worker;
    worker.on("message", (message: HostToMain) => this.#onMessage(message));
    const fail = (error: Error) => {
      if (this.#worker !== worker) return;
      console.error("[extensions] extension host terminated:", error);
      this.#worker = null;
      this.#rejectAll(error);
      this.#killChildProcesses();
      this.#options.toView({ type: "crashed", error: error.message });
    };
    worker.on("error", fail);
    worker.on("exit", (code) => {
      if (this.#worker === worker && generation === this.#generation) fail(new Error(`exited with code ${code}`));
    });
    const init: HostInit = {
      extensions,
      config,
      workspace,
      userData: userDataDir(this.#options.appName),
      appRoot: dirname(fileURLToPath(import.meta.url)),
      appName: this.#options.appName,
      appVersion: this.#options.appVersion,
      language: getDisplayLanguage(),
      languages: languageIds(),
      webviewPort,
      webviewToken: this.#options.webviews.token,
    };
    this.#post({ type: "init", init });
    return extensions.length;
  }

  async restart(): Promise<number> {
    return await this.start(this.#config, this.#workspace);
  }

  /** Let extensions deactivate (briefly), then end the worker. */
  async stop(): Promise<void> {
    const worker = this.#worker;
    if (!worker) return;
    this.#worker = null;
    this.#generation++;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2500);
      worker.on("message", (message: HostToMain) => {
        if (message.type === "shutdownDone") {
          clearTimeout(timer);
          resolve();
        }
      });
      worker.postMessage({ type: "shutdown" } satisfies MainToHost);
    });
    await worker.terminate().catch(() => 0);
    this.#rejectAll(new Error("extension host stopped"));
    this.#killChildProcesses();
    this.#forgetWebviews();
  }

  /** This host's webviews are gone (it restarted or stopped). */
  #forgetWebviews(): void {
    for (const id of this.#webviewIds) this.#options.webviews.forget(id);
    this.#webviewIds.clear();
  }

  /** Language servers and other helpers the extensions started do not outlive them. */
  #killChildProcesses(): void {
    for (const pid of this.#childProcesses.keys()) killTree(pid);
    this.#childProcesses.clear();
  }

  /** A notification from the view (documents, replies, events). */
  postFromView(message: ViewToHost): void {
    if (message.type === "configuration") this.#config = message.config;
    if (message.type === "workspace") this.#workspace = message.root;
    if (message.type === "webviewClosed") this.#forgetWebview(message.id);
    this.#post({ type: "view", message });
  }

  /** A view → host call with a result. */
  call<K extends keyof HostMethods>(method: K, args: Parameters<HostMethods[K]>): Promise<ReturnType<HostMethods[K]>> {
    if (!this.#worker) return Promise.reject(new Error("the extension host is not running"));
    const id = ++this.#seq;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.#post({ type: "call", id, method, args });
    });
  }

  filesChanged(paths: string[]): void {
    if (paths.length) this.#post({ type: "filesChanged", paths });
  }

  /** Another window's host wrote a memento file. */
  stateChanged(file: string, key: string): void {
    this.#post({ type: "stateChanged", file, key });
  }

  #forgetWebview(id: string): void {
    this.#webviewIds.delete(id);
    this.#options.webviews.forget(id);
  }

  #post(message: MainToHost): void {
    this.#worker?.postMessage(message);
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  #onMessage(message: HostToMain): void {
    // Extension code shares the worker: never let a stray message take the app down.
    if (!message || typeof message !== "object") {
      console.error("[extensions] ignored a malformed message from the extension host:", message);
      return;
    }
    switch (message.type) {
      case "view": {
        // Webview pages are served (from their extension's origin) rather than inlined.
        const inner = message.message;
        if (inner.type === "webviewCreate") {
          this.#webviewIds.add(inner.webview.id);
          inner.webview.url = this.#options.webviews.pageUrl(inner.webview.id, inner.webview.extensionId);
        } else if (inner.type === "webviewHtml") this.#options.webviews.setHtml(inner.id, inner.html);
        else if (inner.type === "webviewDispose") this.#forgetWebview(inner.id);
        this.#options.toView(inner);
        break;
      }
      case "callResult": {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        if (message.error !== undefined) pending.reject(new Error(message.error));
        else pending.resolve(message.result);
        break;
      }
      case "mainRequest":
        void this.#handleMain(message.method, message.args).then(
          (result) => this.#post({ type: "mainReply", id: message.id, result }),
          (error: unknown) => this.#post({ type: "mainReply", id: message.id, error: error instanceof Error ? error.message : String(error) }),
        );
        break;
      case "childProcess":
        this.#childProcesses.set(message.pid, message.extensionId);
        break;
      case "stateChanged":
        this.#options.onStateChanged?.(message.file, message.key);
        break;
      case "shutdownDone":
        break;
    }
  }

  async #handleMain(method: keyof MainMethods, args: unknown[]): Promise<unknown> {
    switch (method) {
      case "showOpenDialog":
        return await this.#options.dialogs.showOpenDialog(args[0] as Parameters<Dialogs["showOpenDialog"]>[0]);
      case "showSaveDialog":
        return await this.#options.dialogs.showSaveDialog(args[0] as Parameters<Dialogs["showSaveDialog"]>[0]);
      case "openExternal":
        return openExternal(String(args[0]));
      case "setWebviewRoots":
        this.#webviewIds.add(String(args[0]));
        this.#options.webviews.setRoots(String(args[0]), (args[1] as string[]) ?? []);
        return true;
    }
  }
}
