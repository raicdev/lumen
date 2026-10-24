import koffi from "koffi";
import {
  E_NOINTERFACE,
  GetAt,
  IID_IUNKNOWN,
  PassPointer,
  PutInt,
  S_OK,
  asPointer,
  call,
  getPointer,
  getString,
  getUInt32,
  guid,
  queryInterface,
  release,
  type Pointer,
} from "./com.ts";

/**
 * WebView2 features the `webview` C library does not wrap, called through COM
 * on its ICoreWebView2Controller (Windows only). vtable slots and IIDs come
 * from the WebView2 SDK's WebView2.h (IUnknown takes slots 0–2).
 */

const CONTROLLER_GET_CORE_WEBVIEW2 = 25;
const WEBVIEW2_2_GET_ENVIRONMENT = 67;
const WEBVIEW2_19_PUT_MEMORY_USAGE_TARGET_LEVEL = 120;
const ENVIRONMENT13_GET_PROCESS_EXTENDED_INFOS = 25;
const COLLECTION_GET_COUNT = 3;
const COLLECTION_GET_VALUE_AT_INDEX = 4;
const EXTENDED_INFO_GET_PROCESS_INFO = 3;
const EXTENDED_INFO_GET_ASSOCIATED_FRAME_INFOS = 4;
const PROCESS_INFO_GET_PROCESS_ID = 3;
const PROCESS_INFO_GET_KIND = 4;
const FRAMES_GET_ITERATOR = 3;
const ITERATOR_GET_HAS_CURRENT = 3;
const ITERATOR_GET_CURRENT = 4;
const ITERATOR_MOVE_NEXT = 5;
const FRAME_GET_NAME = 3;
const FRAME_GET_SOURCE = 4;

const IID_ICOREWEBVIEW2_2 = guid("9E8F0CF8-E670-4B5E-B2BC-73E061E3184C");
const IID_ICOREWEBVIEW2_19 = guid("6921F954-79B0-437F-A997-C85811897C68");
const IID_ENVIRONMENT13 = guid("AF641F58-72B2-11EE-B962-0242AC120002");
const IID_PROCESS_INFOS_COMPLETED_HANDLER = guid("F45E55AA-3BC2-11EE-BE56-0242AC120002");

// Our own COM object (the completion handler): raw pointers, written by hand.
const HandlerQueryInterface = koffi.proto("int32_t __stdcall LumenHandlerQueryInterface(void *self, void *iid, void *out)");
const HandlerRefCount = koffi.proto("uint32_t __stdcall LumenHandlerRefCount(void *self)");
const HandlerInvoke = koffi.proto("int32_t __stdcall LumenHandlerInvoke(void *self, int32_t error, void *result)");

/** Run `use` with the controller's ICoreWebView2 queried for `iid`, releasing everything after. */
function withWebview<T>(controller: Pointer, iid: Buffer, use: (webview: Pointer) => T): T | null {
  const core = getPointer(controller, CONTROLLER_GET_CORE_WEBVIEW2);
  if (!core) return null;
  try {
    const webview = queryInterface(core, iid);
    if (!webview) return null;
    try {
      return use(webview);
    } finally {
      release(webview);
    }
  } finally {
    release(core);
  }
}

export type MemoryUsageTargetLevel = "normal" | "low";

/** ICoreWebView2_19.MemoryUsageTargetLevel; false where the runtime is too old. */
export function setMemoryUsageTargetLevel(controller: Pointer, level: MemoryUsageTargetLevel): boolean {
  const value = level === "low" ? 1 : 0; // COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW / _NORMAL
  return withWebview(controller, IID_ICOREWEBVIEW2_19, (webview) => call(webview, WEBVIEW2_19_PUT_MEMORY_USAGE_TARGET_LEVEL, PutInt, value) === S_OK) ?? false;
}

/* ── process → frames ─────────────────────────────────────────────────── */

/** A WebView2 process and the frames it renders (renderers only have frames). */
export type WebviewProcessFrames = { pid: number; kind: number; frames: { name: string; source: string }[] };

let pending: { resolve: (value: WebviewProcessFrames[] | null) => void }[] = [];
let handler: { object: Buffer; vtable: Buffer; callbacks: unknown[] } | null = null;

function readCollection(collection: Pointer): WebviewProcessFrames[] {
  const result: WebviewProcessFrames[] = [];
  const count = getUInt32(collection, COLLECTION_GET_COUNT) ?? 0;
  for (let index = 0; index < count; index++) {
    const out: unknown[] = [null];
    if (call(collection, COLLECTION_GET_VALUE_AT_INDEX, GetAt, index, out) !== S_OK) continue;
    const info = asPointer(out[0]);
    if (!info) continue;
    try {
      const processInfo = getPointer(info, EXTENDED_INFO_GET_PROCESS_INFO);
      if (!processInfo) continue;
      const entry: WebviewProcessFrames = {
        pid: getUInt32(processInfo, PROCESS_INFO_GET_PROCESS_ID) ?? 0,
        kind: getUInt32(processInfo, PROCESS_INFO_GET_KIND) ?? -1,
        frames: [],
      };
      release(processInfo);
      const frames = getPointer(info, EXTENDED_INFO_GET_ASSOCIATED_FRAME_INFOS);
      const iterator = frames ? getPointer(frames, FRAMES_GET_ITERATOR) : 0n;
      if (iterator) {
        while (getUInt32(iterator, ITERATOR_GET_HAS_CURRENT)) {
          const frame = getPointer(iterator, ITERATOR_GET_CURRENT);
          if (frame) {
            entry.frames.push({ name: getString(frame, FRAME_GET_NAME), source: getString(frame, FRAME_GET_SOURCE) });
            release(frame);
          }
          if (!getUInt32(iterator, ITERATOR_MOVE_NEXT)) break;
        }
      }
      release(iterator);
      release(frames);
      result.push(entry);
    } finally {
      release(info);
    }
  }
  return result;
}

/**
 * ICoreWebView2GetProcessExtendedInfosCompletedHandler, built by hand: one
 * object for the app's lifetime (WebView2 may release it after the call
 * returns), answering the oldest pending request on each Invoke.
 */
function completionHandler(): Pointer {
  if (!handler) {
    const object = Buffer.alloc(8);
    const vtable = Buffer.alloc(32);
    const self = koffi.address(object);
    const queryInterface = koffi.register((_self: unknown, iid: unknown, out: unknown) => {
      const requested = Buffer.from(koffi.view(asPointer(iid), 16));
      const known = requested.equals(IID_IUNKNOWN) || requested.equals(IID_PROCESS_INFOS_COMPLETED_HANDLER);
      new BigUint64Array(koffi.view(asPointer(out), 8))[0] = known ? self : 0n;
      return known ? S_OK : E_NOINTERFACE;
    }, koffi.pointer(HandlerQueryInterface));
    // Static object: reference counting has nothing to free.
    const refCount = koffi.register(() => 1, koffi.pointer(HandlerRefCount));
    const invoke = koffi.register((_self: unknown, error: number, result: unknown) => {
      const next = pending.shift();
      try {
        next?.resolve(error === S_OK && result ? readCollection(asPointer(result)) : null);
      } catch {
        next?.resolve(null);
      }
      return S_OK;
    }, koffi.pointer(HandlerInvoke));
    [queryInterface, refCount, refCount, invoke].forEach((fn, slot) => vtable.writeBigUInt64LE(asPointer(fn), slot * 8));
    object.writeBigUInt64LE(koffi.address(vtable));
    handler = { object, vtable, callbacks: [queryInterface, refCount, invoke] };
  }
  return koffi.address(handler.object);
}

/**
 * Every process of the controller's WebView2 environment with the frames each
 * renderer shows (ICoreWebView2Environment13.GetProcessExtendedInfos); null
 * where unsupported. Completes through the message loop, which must be running.
 */
export function processFrames(controller: Pointer, timeoutMs = 3000): Promise<WebviewProcessFrames[] | null> {
  const environment = withWebview(controller, IID_ICOREWEBVIEW2_2, (webview) => getPointer(webview, WEBVIEW2_2_GET_ENVIRONMENT));
  if (!environment) return Promise.resolve(null);
  try {
    const environment13 = queryInterface(environment, IID_ENVIRONMENT13);
    if (!environment13) return Promise.resolve(null);
    try {
      return new Promise((resolve) => {
        // A late answer still takes this entry off the queue (resolving twice is a no-op),
        // so answers keep matching their requests.
        const request = { resolve };
        pending.push(request);
        if (call(environment13, ENVIRONMENT13_GET_PROCESS_EXTENDED_INFOS, PassPointer, completionHandler()) !== S_OK) {
          pending = pending.filter((entry) => entry !== request);
          resolve(null);
          return;
        }
        setTimeout(() => resolve(null), timeoutMs);
      });
    } finally {
      release(environment13);
    }
  } finally {
    release(environment);
  }
}
