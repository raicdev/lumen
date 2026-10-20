import koffi from "koffi";
import { resolveNativeLibrary } from "./library.ts";

/**
 * Minimal FFI binding for the `webview` C library (through koffi).
 *
 * This is deliberately thinner than any existing binding: Lumen Shell owns the
 * message loop (see the platform modules), so we only expose the raw entry
 * points and never call `webview_run`, which would block the Node event loop
 * and make async IPC impossible.
 */

const lib = koffi.load(resolveNativeLibrary());

const BindCallbackProto = koffi.proto("void LumenBindCallback(const char *seq, const char *req, void *arg)");

const symbols = {
  webview_create: lib.func("void *webview_create(int debug, void *window)"),
  webview_destroy: lib.func("void webview_destroy(void *w)"),
  webview_terminate: lib.func("void webview_terminate(void *w)"),
  webview_get_window: lib.func("void *webview_get_window(void *w)"),
  webview_set_title: lib.func("void webview_set_title(void *w, const char *title)"),
  webview_set_size: lib.func("void webview_set_size(void *w, int width, int height, int hints)"),
  webview_navigate: lib.func("void webview_navigate(void *w, const char *url)"),
  webview_set_html: lib.func("void webview_set_html(void *w, const char *html)"),
  webview_init: lib.func("void webview_init(void *w, const char *js)"),
  webview_eval: lib.func("void webview_eval(void *w, const char *js)"),
  webview_bind: lib.func("void webview_bind(void *w, const char *name, LumenBindCallback *fn, void *arg)"),
  webview_unbind: lib.func("void webview_unbind(void *w, const char *name)"),
  webview_return: lib.func("void webview_return(void *w, const char *seq, int status, const char *result)"),
};

/** Window size hints (mirrors `webview_hint_t`). */
export const SizeHint = {
  None: 0,
  Min: 1,
  Max: 2,
  Fixed: 3,
} as const;

export type SizeHint = (typeof SizeHint)[keyof typeof SizeHint];

/** Native pointers are plain addresses (koffi represents them as BigInt). */
export type NativeHandle = bigint;

/** Normalize an FFI pointer result (`bigint | number | null`) to a `NativeHandle`. */
export function asPointer(value: unknown): NativeHandle {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  return 0n;
}

export type BindCallback = (seq: string, args: unknown[]) => unknown;

export class NativeWebview {
  #handle: NativeHandle | null = null;
  #callbacks = new Map<string, bigint>();

  constructor(options: { debug?: boolean } = {}) {
    const handle = asPointer(symbols.webview_create(options.debug ? 1 : 0, null));
    if (!handle) {
      throw new Error("Lumen Shell: webview_create failed (is the WebView2 runtime installed?)");
    }
    this.#handle = handle;
  }

  get handle(): NativeHandle {
    if (!this.#handle) throw new Error("Lumen Shell: webview already destroyed");
    return this.#handle;
  }

  get destroyed() {
    return this.#handle === null;
  }

  /** Native window handle (HWND / NSWindow* / GtkWindow*). */
  get windowHandle(): NativeHandle {
    return asPointer(symbols.webview_get_window(this.handle));
  }

  get windowPointer(): NativeHandle | null {
    if (!this.#handle) return null;
    return asPointer(symbols.webview_get_window(this.#handle));
  }

  setTitle(title: string): void {
    symbols.webview_set_title(this.handle, title);
  }

  setSize(width: number, height: number, hint: SizeHint = SizeHint.None): void {
    symbols.webview_set_size(this.handle, Math.round(width), Math.round(height), hint);
  }

  navigate(url: string): void {
    symbols.webview_navigate(this.handle, url);
  }

  setHtml(html: string): void {
    symbols.webview_set_html(this.handle, html);
  }

  /** Inject a script that runs before every page load. */
  initScript(source: string): void {
    symbols.webview_init(this.handle, source);
  }

  /** Evaluate JS; the result is ignored (use `bind` for request/response). */
  eval(source: string): void {
    if (!this.#handle) return;
    symbols.webview_eval(this.#handle, source);
  }

  /**
   * Expose `name` to the page as an async global function. The callback receives
   * the requested id plus the JSON-decoded argument list and may return a value
   * or a promise; the page's promise resolves with the JSON round-tripped value.
   */
  bind(name: string, callback: BindCallback): void {
    const pointer = koffi.register(
      (seqRaw: string | null, reqRaw: string | null) => {
        const seq = seqRaw ?? "";
        let args: unknown[] = [];
        try {
          const parsed = JSON.parse(reqRaw || "[]");
          args = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          args = [];
        }

        let result: unknown;
        try {
          result = callback(seq, args);
        } catch (error) {
          this.#respond(seq, 1, errorMessage(error));
          return;
        }

        if (result instanceof Promise) {
          result.then(
            (value) => this.#respond(seq, 0, value),
            (error: unknown) => this.#respond(seq, 1, errorMessage(error)),
          );
        } else {
          this.#respond(seq, 0, result);
        }
      },
      koffi.pointer(BindCallbackProto),
    );

    this.#callbacks.set(name, pointer);
    symbols.webview_bind(this.handle, name, pointer, null);
  }

  unbind(name: string): void {
    if (this.#handle) symbols.webview_unbind(this.#handle, name);
    const pointer = this.#callbacks.get(name);
    if (pointer !== undefined) koffi.unregister(pointer);
    this.#callbacks.delete(name);
  }

  /** Ask the webview to leave its event loop (posts a quit message). */
  terminate(): void {
    if (this.#handle) symbols.webview_terminate(this.#handle);
  }

  /** Destroy the window and free resources. */
  destroy(): void {
    if (!this.#handle) return;
    for (const name of [...this.#callbacks.keys()]) this.unbind(name);
    const handle = this.#handle;
    this.#handle = null;
    symbols.webview_terminate(handle);
    symbols.webview_destroy(handle);
  }

  #respond(seq: string, status: number, value: unknown): void {
    if (!this.#handle || !seq) return;
    let json: string;
    try {
      json = JSON.stringify(value ?? null);
    } catch {
      json = JSON.stringify({ error: "value is not serializable" });
      status = 1;
    }
    symbols.webview_return(this.#handle, seq, status, json);
  }
}

function errorMessage(error: unknown): { message: string } {
  if (error instanceof Error) return { message: error.message };
  return { message: typeof error === "string" ? error : String(error) };
}
