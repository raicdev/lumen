import { Worker } from "worker_threads";
import type { lsp } from "./lsp.ts";
import type * as fsTasks from "./fs.ts";

/**
 * Heavy, synchronous work (the TypeScript language service, workspace-wide
 * search) runs in worker threads. The main thread also pumps the native
 * window's message loop, so blocking it freezes the whole window — building
 * the TypeScript program for a medium project alone takes seconds.
 */

type Service = Record<string, (...args: never[]) => unknown>;
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export type WorkerKind = "lsp" | "fs" | "exthost";

/**
 * Entry file for workers: the dispatcher in dev (sources), the bundle's entry
 * when packaged. This module may sit in a shared chunk next to it, so the
 * entry is named rather than taken from import.meta.url.
 */
export function workerEntry(): URL {
  return import.meta.url.endsWith(".ts") ? new URL("./index.ts", import.meta.url) : new URL("./main.mjs", import.meta.url);
}

class WorkerClient<S extends Service> {
  #kind: WorkerKind;
  #worker: Worker | null = null;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  /** Fire-and-forget calls replayed after a crash restart (e.g. workspace root). */
  #replay = new Map<string, unknown[]>();

  constructor(kind: WorkerKind) {
    this.#kind = kind;
  }

  #ensure(): Worker {
    if (this.#worker) return this.#worker;
    const worker = new Worker(workerEntry(), { workerData: { lumenWorker: this.#kind } });
    worker.unref();
    worker.on("message", (message: { id: number; result?: unknown; error?: string }) => {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error !== undefined) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
    });
    const fail = (error: Error) => {
      console.error(`[worker:${this.#kind}]`, error);
      if (this.#worker !== worker) return;
      this.#worker = null;
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    };
    worker.on("error", fail);
    worker.on("exit", (code) => {
      if (code !== 0) fail(new Error(`worker exited with code ${code}`));
      else if (this.#worker === worker) this.#worker = null;
    });
    this.#worker = worker;
    for (const [method, args] of this.#replay) worker.postMessage({ id: 0, method, args });
    return worker;
  }

  /** Call a service method in the worker and await its result. */
  call<K extends keyof S & string>(method: K, ...args: Parameters<S[K]>): Promise<Awaited<ReturnType<S[K]>>> {
    const worker = this.#ensure();
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      worker.postMessage({ id, method, args });
    });
  }

  /** Call without waiting for the result (messages keep their order). */
  notify<K extends keyof S & string>(method: K, ...args: Parameters<S[K]>): void {
    this.#ensure().postMessage({ id: 0, method, args });
  }

  /** Bytes of JavaScript heap in use, or null while the worker is not running. */
  async heapUsed(): Promise<number | null> {
    const stats = await this.#worker?.getHeapStatistics().catch(() => null);
    return stats ? stats.used_heap_size : null;
  }

  /** Notify only a running worker: a stopped one holds no state the message could update. */
  notifyIfRunning<K extends keyof S & string>(method: K, ...args: Parameters<S[K]>): void {
    this.#worker?.postMessage({ id: 0, method, args });
  }

  /**
   * Settings the worker needs, replayed whenever it starts. They do not start
   * it: the worker (and the code it loads) waits for its first real call.
   */
  configure<K extends keyof S & string>(method: K, ...args: Parameters<S[K]>): void {
    this.#replay.set(method, args);
    this.notifyIfRunning(method, ...args);
  }
}

type LspService = {
  [K in keyof typeof lsp as (typeof lsp)[K] extends (...args: never[]) => unknown ? K : never]: (typeof lsp)[K];
};

type FsService = Pick<typeof fsTasks, "searchInFiles" | "replaceInFiles" | "listWorkspaceFiles" | "searchFilesByName">;

export const lspWorker = new WorkerClient<LspService & Service>("lsp");
export const fsWorker = new WorkerClient<FsService & Service>("fs");

/** Worker side: serve calls for the requested service. */
export async function runWorker(kind: WorkerKind): Promise<void> {
  const { parentPort } = await import("worker_threads");
  if (!parentPort) return;
  if (kind === "exthost") {
    // The extension host has its own protocol (see exthost/host.ts).
    const { runExtensionHost } = await import("./exthost/host.ts");
    await runExtensionHost();
    return;
  }
  let service: Record<string, (...args: unknown[]) => unknown>;
  if (kind === "lsp") {
    const { lsp: hub } = await import("./lsp.ts");
    service = new Proxy({} as Record<string, (...args: unknown[]) => unknown>, {
      get: (_target, name: string) => {
        const member = (hub as unknown as Record<string, unknown>)[name];
        return typeof member === "function" ? (member as (...args: unknown[]) => unknown).bind(hub) : undefined;
      },
    });
  } else {
    const fs = await import("./fs.ts");
    service = {
      searchInFiles: fs.searchInFiles as never,
      replaceInFiles: fs.replaceInFiles as never,
      listWorkspaceFiles: fs.listWorkspaceFiles as never,
      searchFilesByName: fs.searchFilesByName as never,
    };
  }

  parentPort.on("message", async (message: { id: number; method: string; args: unknown[] }) => {
    try {
      const handler = service[message.method];
      if (!handler) throw new Error(`unknown method ${message.method}`);
      const result = await handler(...message.args);
      if (message.id) parentPort.postMessage({ id: message.id, result });
    } catch (error) {
      if (message.id) parentPort.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) });
      else console.error(`[worker:${kind}] ${message.method} failed:`, error);
    }
  });
}
