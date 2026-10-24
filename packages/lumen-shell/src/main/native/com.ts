import koffi from "koffi";

/**
 * Calling COM objects through their vtables with koffi (Windows only): what
 * webview2.ts and file-dialog-win32.ts share. IUnknown takes slots 0–2.
 */

export type Pointer = bigint;

export const S_OK = 0;
export const E_NOINTERFACE = 0x80004002 | 0;

/** A GUID struct (Data1–3 little-endian, Data4 as bytes) from its "xxxxxxxx-xxxx-…" form. */
export function guid(text: string): Buffer {
  const hex = text.replace(/-/g, "");
  const bytes = Buffer.alloc(16);
  bytes.writeUInt32LE(Number.parseInt(hex.slice(0, 8), 16), 0);
  bytes.writeUInt16LE(Number.parseInt(hex.slice(8, 12), 16), 4);
  bytes.writeUInt16LE(Number.parseInt(hex.slice(12, 16), 16), 6);
  Buffer.from(hex.slice(16), "hex").copy(bytes, 8);
  return bytes;
}

export const IID_IUNKNOWN = guid("00000000-0000-0000-C000-000000000046");

export const QueryInterface = koffi.proto("int32_t __stdcall LumenComQueryInterface(void *self, const void *iid, _Out_ void **out)");
export const Release = koffi.proto("uint32_t __stdcall LumenComRelease(void *self)");
export const GetPointer = koffi.proto("int32_t __stdcall LumenComGetPointer(void *self, _Out_ void **out)");
export const GetUInt32 = koffi.proto("int32_t __stdcall LumenComGetUInt32(void *self, _Out_ uint32_t *out)");
export const GetAt = koffi.proto("int32_t __stdcall LumenComGetAt(void *self, uint32_t index, _Out_ void **out)");
export const PutInt = koffi.proto("int32_t __stdcall LumenComPutInt(void *self, int value)");
export const PassPointer = koffi.proto("int32_t __stdcall LumenComPassPointer(void *self, void *value)");

const ole32 = process.platform === "win32" ? koffi.load("ole32.dll") : null;
export const CoTaskMemFree = ole32?.func("void __stdcall CoTaskMemFree(void *memory)");
export const CoCreateInstance = ole32?.func(
  "int32_t __stdcall CoCreateInstance(const void *clsid, void *outer, uint32_t context, const void *iid, _Out_ void **out)",
);
export const CoInitializeEx = ole32?.func("int32_t __stdcall CoInitializeEx(void *reserved, uint32_t flags)");

export function asPointer(value: unknown): Pointer {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  return 0n;
}

/** Call slot `index` of a COM object's vtable. */
export function call(object: Pointer, index: number, proto: ReturnType<typeof koffi.proto>, ...args: unknown[]): number {
  const vtable = new BigUint64Array(koffi.view(object, 8))[0]!;
  const fn = new BigUint64Array(koffi.view(vtable, (index + 1) * 8))[index]!;
  return (koffi.decode(fn, proto) as (...args: unknown[]) => number)(object, ...args);
}

export function release(object: Pointer): void {
  if (object) call(object, 2, Release);
}

/** A pointer-valued property (`get_X(T **)`); 0n on failure. */
export function getPointer(object: Pointer, index: number): Pointer {
  const out: unknown[] = [null];
  return call(object, index, GetPointer, out) === S_OK ? asPointer(out[0]) : 0n;
}

export function getUInt32(object: Pointer, index: number): number | null {
  const out = [0];
  return call(object, index, GetUInt32, out) === S_OK ? out[0]! : null;
}

export function queryInterface(object: Pointer, iid: Buffer): Pointer {
  const out: unknown[] = [null];
  return call(object, 0, QueryInterface, iid, out) === S_OK ? asPointer(out[0]) : 0n;
}

/** Take ownership of an LPWSTR the callee allocated (CoTaskMemFree). */
export function takeString(text: Pointer): string {
  if (!text) return "";
  try {
    return koffi.decode(text, "char16_t", -1) as string;
  } finally {
    CoTaskMemFree?.(text);
  }
}

/** A string property (LPWSTR the caller frees with CoTaskMemFree). */
export function getString(object: Pointer, index: number): string {
  return takeString(getPointer(object, index));
}
