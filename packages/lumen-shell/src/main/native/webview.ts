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
  webview_get_native_handle: lib.func("void *webview_get_native_handle(void *w, int kind)"),
};

/* ── WebView2 COM (Windows) ───────────────────────────────────────────── */

/** WEBVIEW_NATIVE_HANDLE_KIND_BROWSER_CONTROLLER: the ICoreWebView2Controller. */
const NATIVE_HANDLE_BROWSER_CONTROLLER = 2;
// vtable slots, counted in the WebView2 SDK's WebView2.h (IUnknown takes 0–2).
const QUERY_INTERFACE = 0;
const RELEASE = 2;
const CONTROLLER_GET_CORE_WEBVIEW2 = 25;
const WEBVIEW2_19_PUT_MEMORY_USAGE_TARGET_LEVEL = 120;
/** A GUID struct (Data1–3 little-endian, Data4 as bytes) from its "xxxxxxxx-xxxx-…" form. */
function guid(text: string): Buffer {
  const hex = text.replace(/-/g, "");
  const bytes = Buffer.alloc(16);
  bytes.writeUInt32LE(Number.parseInt(hex.slice(0, 8), 16), 0);
  bytes.writeUInt16LE(Number.parseInt(hex.slice(8, 12), 16), 4);
  bytes.writeUInt16LE(Number.parseInt(hex.slice(12, 16), 16), 6);
  Buffer.from(hex.slice(16), "hex").copy(bytes, 8);
  return bytes;
}

const IID_ICOREWEBVIEW2_19 = guid("6921F954-79B0-437F-A997-C85811897C68");

const ComQueryInterface = koffi.proto("int32_t __stdcall LumenComQueryInterface(void *self, const void *iid, _Out_ void **out)");
const ComRelease = koffi.proto("uint32_t __stdcall LumenComRelease(void *self)");
const ComGetPointer = koffi.proto("int32_t __stdcall LumenComGetPointer(void *self, _Out_ void **out)");
const ComPutInt = koffi.proto("int32_t __stdcall LumenComPutInt(void *self, int value)");

/** The function in slot `index` of a COM object's vtable. */
function comMethod(object: NativeHandle, index: number, proto: ReturnType<typeof koffi.proto>): (...args: unknown[]) => unknown {
  const vtable = new BigUint64Array(koffi.view(object, 8))[0]!;
  const fn = new BigUint64Array(koffi.view(vtable, (index + 1) * 8))[index]!;
  return koffi.decode(fn, proto) as (...args: unknown[]) => unknown;
}

export type MemoryUsageTargetLevel = "normal" | "low";

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

  /**
   * WebView2 (Windows): "low" asks the browser to give back memory (drop
   * caches, collect garbage, trim working sets) while the app is in the
   * background; "normal" restores the default. Returns false where unsupported
   * (other platforms, or a WebView2 runtime older than ICoreWebView2_19).
   */
  setMemoryUsageTargetLevel(level: MemoryUsageTargetLevel): boolean {
    if (process.platform !== "win32" || !this.#handle) return false;
    const controller = asPointer(symbols.webview_get_native_handle(this.#handle, NATIVE_HANDLE_BROWSER_CONTROLLER));
    if (!controller) return false;
    const core: unknown[] = [null];
    if (comMethod(controller, CONTROLLER_GET_CORE_WEBVIEW2, ComGetPointer)(controller, core) !== 0) return false;
    const webview = asPointer(core[0]);
    if (!webview) return false;
    const queried: unknown[] = [null];
    try {
      if (comMethod(webview, QUERY_INTERFACE, ComQueryInterface)(webview, IID_ICOREWEBVIEW2_19, queried) !== 0) return false;
      const webview19 = asPointer(queried[0]);
      if (!webview19) return false;
      try {
        const value = level === "low" ? 1 : 0; // COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW / _NORMAL
        return comMethod(webview19, WEBVIEW2_19_PUT_MEMORY_USAGE_TARGET_LEVEL, ComPutInt)(webview19, value) === 0;
      } finally {
        comMethod(webview19, RELEASE, ComRelease)(webview19);
      }
    } finally {
      comMethod(webview, RELEASE, ComRelease)(webview);
    }
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
