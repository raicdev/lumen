import koffi from "koffi";
import { setTimeout as sleep } from "timers/promises";
import { asPointer, type NativeHandle } from "./webview.ts";
import { capture, launch, type CaptureResult } from "./process.ts";
import type {
  MenuGroup,
  MessageBoxOptions,
  OpenDialogOptions,
  PageRect,
  Platform,
  SaveDialogOptions,
  ResizeEdge,
  WindowHooks,
  WindowState,
  WindowStyle,
} from "./platform.ts";

/**
 * Win32 backend: message loop, window control, native menu bar and dialogs.
 *
 * This is what makes Lumen Shell a real desktop shell without bundling a
 * browser: WebView2 renders the UI, Win32 owns the window, and this module owns
 * the event loop so Node's async event loop keeps running between messages.
 */

const WndProcProto = koffi.proto(
  "intptr_t __stdcall LumenWndProc(void *hwnd, uint32_t msg, uintptr_t wParam, intptr_t lParam)",
);

function loadUser32() {
  const user32 = koffi.load("user32.dll");
  return {
    PeekMessageW: user32.func(
      "int __stdcall PeekMessageW(void *msg, void *hwnd, uint32_t min, uint32_t max, uint32_t remove)",
    ),
    TranslateMessage: user32.func("int __stdcall TranslateMessage(void *msg)"),
    DispatchMessageW: user32.func("intptr_t __stdcall DispatchMessageW(void *msg)"),
    SetWindowTextW: user32.func("int __stdcall SetWindowTextW(void *hwnd, const char16_t *text)"),
    SetWindowPos: user32.func(
      "int __stdcall SetWindowPos(void *hwnd, void *after, int x, int y, int cx, int cy, uint32_t flags)",
    ),
    GetSystemMetrics: user32.func("int __stdcall GetSystemMetrics(int index)"),
    ShowWindow: user32.func("int __stdcall ShowWindow(void *hwnd, int cmd)"),
    IsZoomed: user32.func("int __stdcall IsZoomed(void *hwnd)"),
    SetForegroundWindow: user32.func("int __stdcall SetForegroundWindow(void *hwnd)"),
    SetFocus: user32.func("void *__stdcall SetFocus(void *hwnd)"),
    SetWindowLongPtrW: user32.func("intptr_t __stdcall SetWindowLongPtrW(void *hwnd, int index, intptr_t value)"),
    CallWindowProcW: user32.func(
      "intptr_t __stdcall CallWindowProcW(void *proc, void *hwnd, uint32_t msg, uintptr_t wParam, intptr_t lParam)",
    ),
    CreateMenu: user32.func("void *__stdcall CreateMenu()"),
    CreatePopupMenu: user32.func("void *__stdcall CreatePopupMenu()"),
    AppendMenuW: user32.func(
      "int __stdcall AppendMenuW(void *menu, uint32_t flags, uintptr_t id, const char16_t *label)",
    ),
    SetMenu: user32.func("int __stdcall SetMenu(void *hwnd, void *menu)"),
    DrawMenuBar: user32.func("int __stdcall DrawMenuBar(void *hwnd)"),
    IsWindowVisible: user32.func("int __stdcall IsWindowVisible(void *hwnd)"),
    GetWindow: user32.func("void *__stdcall GetWindow(void *hwnd, uint32_t cmd)"),
    ReleaseCapture: user32.func("int __stdcall ReleaseCapture()"),
    GetCursorPos: user32.func("int __stdcall GetCursorPos(void *point)"),
    PostMessageW: user32.func(
      "int __stdcall PostMessageW(void *hwnd, uint32_t msg, uintptr_t wParam, intptr_t lParam)",
    ),
    SetClassLongPtrW: user32.func("uintptr_t __stdcall SetClassLongPtrW(void *hwnd, int index, intptr_t value)"),
    GetClientRect: user32.func("int __stdcall GetClientRect(void *hwnd, void *rect)"),
    RegisterClassExW: user32.func("uint16_t __stdcall RegisterClassExW(const LumenWndClassEx *wc)"),
    CreateWindowExW: user32.func(
      "void *__stdcall CreateWindowExW(uint32_t exStyle, const char16_t *cls, const char16_t *name, uint32_t style, int x, int y, int w, int h, void *parent, void *menu, void *instance, void *param)",
    ),
    DefWindowProcW: user32.func(
      "intptr_t __stdcall DefWindowProcW(void *hwnd, uint32_t msg, uintptr_t wParam, intptr_t lParam)",
    ),
    SetLayeredWindowAttributes: user32.func(
      "int __stdcall SetLayeredWindowAttributes(void *hwnd, uint32_t key, uint8_t alpha, uint32_t flags)",
    ),
    TrackMouseEvent: user32.func("int __stdcall TrackMouseEvent(void *event)"),
    LoadCursorW: user32.func("void *__stdcall LoadCursorW(void *instance, uintptr_t name)"),
  };
}

koffi.struct("LumenWndClassEx", {
  cbSize: "uint32_t",
  style: "uint32_t",
  lpfnWndProc: "void *",
  cbClsExtra: "int",
  cbWndExtra: "int",
  hInstance: "void *",
  hIcon: "void *",
  hCursor: "void *",
  hbrBackground: "void *",
  lpszMenuName: "const char16_t *",
  lpszClassName: "const char16_t *",
  hIconSm: "void *",
});

function loadKernel32() {
  const kernel32 = koffi.load("kernel32.dll");
  return {
    GetModuleHandleW: kernel32.func("void *__stdcall GetModuleHandleW(const char16_t *name)"),
  };
}

function loadGdiDwm() {
  const gdi32 = koffi.load("gdi32.dll");
  const dwmapi = koffi.load("dwmapi.dll");
  return {
    CreateSolidBrush: gdi32.func("void *__stdcall CreateSolidBrush(uint32_t color)"),
    DwmSetWindowAttribute: dwmapi.func(
      "int32_t __stdcall DwmSetWindowAttribute(void *hwnd, uint32_t attribute, void *value, uint32_t size)",
    ),
  };
}

let gdiDwm: ReturnType<typeof loadGdiDwm> | null = null;

function graphics(): ReturnType<typeof loadGdiDwm> {
  return (gdiDwm ??= loadGdiDwm());
}

// Loaded lazily so that importing this module never touches user32.dll.
let user32: ReturnType<typeof loadUser32> | null = null;

function symbols(): ReturnType<typeof loadUser32> {
  return (user32 ??= loadUser32());
}

const PM_REMOVE = 0x0001;
const WM_DESTROY = 0x0002;
const WM_SIZE = 0x0005;
const WM_CLOSE = 0x0010;
const WM_QUIT = 0x0012;
const WM_COMMAND = 0x0111;
const WM_NCCALCSIZE = 0x0083;
const WM_NCACTIVATE = 0x0086;
const WM_NCLBUTTONDOWN = 0x00a1;
const WM_NCHITTEST = 0x0084;
const WM_NCMOUSEMOVE = 0x00a0;
const WM_NCLBUTTONUP = 0x00a2;
const WM_NCLBUTTONDBLCLK = 0x00a3;
const WM_NCMOUSELEAVE = 0x02a2;

const SIZE_RESTORED = 0;
const SIZE_MINIMIZED = 1;
const SIZE_MAXIMIZED = 2;

const HTCAPTION = 2;
const HTMAXBUTTON = 9;
const HTTOP = 12;
const HTTOPLEFT = 13;
const HTTOPRIGHT = 14;

const GCLP_HBRBACKGROUND = -10;
const GW_CHILD = 5;

const DWMWA_CLOAK = 13;
const DWMWA_USE_IMMERSIVE_DARK_MODE = 20;

const GWLP_WNDPROC = -4;

const SW_MINIMIZE = 6;
const SW_MAXIMIZE = 3;
const SW_RESTORE = 9;
const SW_SHOW = 5;
const SW_HIDE = 0;

const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_FRAMECHANGED = 0x0020;
const SWP_SHOWWINDOW = 0x0040;

const WS_CHILD = 0x40000000;
const WS_EX_LAYERED = 0x00080000;
const WS_EX_NOREDIRECTIONBITMAP = 0x00200000;
const LWA_ALPHA = 0x2;
const TME_LEAVE = 0x2;
const TME_NONCLIENT = 0x10;
const IDC_ARROW = 32512;

const SM_CXSCREEN = 0;
const SM_CYSCREEN = 1;

const MF_STRING = 0x00000000;
const MF_POPUP = 0x00000010;
const MF_SEPARATOR = 0x00000800;
const MF_GRAYED = 0x00000001;

const MENU_ID_BASE = 0x8000;

type WindowEntry = {
  hooks: WindowHooks;
  originalProc: bigint;
  callback: bigint;
  frameless: boolean;
  cloaked: boolean;
  /** Invisible child window over the page's maximize button (snap layouts). */
  snapOverlay: bigint | null;
};

type SnapOverlay = {
  owner: NativeHandle;
  hover: boolean;
  pressed: boolean;
};

const snapOverlays = new Map<string, SnapOverlay>();

const windows = new Map<string, WindowEntry>();
const menuActions = new Map<number, string>();
let nextMenuId = MENU_ID_BASE;

function key(handle: NativeHandle): string {
  return String(handle);
}

/** Room for a `MSG` structure (48 bytes on x64). */
const messageBuffer = Buffer.alloc(64);

export async function runMessageLoop(options: { shouldContinue: () => boolean }): Promise<void> {
  const api = symbols();
  let pumping = true;
  while (pumping && options.shouldContinue()) {
    let pumped = 0;
    while (api.PeekMessageW(messageBuffer, null, 0, 0, PM_REMOVE)) {
      const message = messageBuffer.readUInt32LE(8);
      if (message === WM_QUIT) {
        pumping = false;
        break;
      }
      api.TranslateMessage(messageBuffer);
      api.DispatchMessageW(messageBuffer);
      if (++pumped >= 256) break;
    }
    // Yield to the Node event loop so async IPC handlers can resolve. When there
    // was work we yield immediately; when idle we sleep briefly to avoid a busy
    // loop while still keeping the window responsive.
    if (pumped > 0) await new Promise<void>((resolve) => setImmediate(resolve));
    else await sleep(2);
  }
}

function wndProc(
  handle: NativeHandle | null,
  message: number,
  wParam: number | bigint,
  lParam: number | bigint,
): number | bigint {
  const entry = handle ? windows.get(key(handle)) : undefined;
  if (!entry) return 0;

  if (message === WM_NCCALCSIZE && entry.frameless && BigInt(wParam) !== 0n) {
    return calcFramelessClientArea(entry, handle!, wParam, lParam);
  } else if (message === WM_NCACTIVATE && entry.frameless) {
    // lParam = -1 stops DefWindowProc from repainting the (removed) caption.
    return symbols().CallWindowProcW(entry.originalProc, handle, message, wParam, -1);
  } else if (message === WM_SIZE) {
    const result = symbols().CallWindowProcW(entry.originalProc, handle, message, wParam, lParam);
    const state = sizeState(Number(wParam));
    if (state) {
      try {
        entry.hooks.onStateChange?.(state);
      } catch {
        /* ignore */
      }
    }
    return result;
  } else if (message === WM_CLOSE) {
    if (entry.hooks.hasCloseGuard()) {
      try {
        entry.hooks.onClose();
      } catch {
        /* ignore */
      }
      return 0; // keep the window alive until the guard resolves
    }
  } else if (message === WM_COMMAND) {
    const id = Number(BigInt(wParam) & 0xffffn);
    const action = menuActions.get(id);
    if (action) {
      entry.hooks.onMenuAction(action);
      return 0;
    }
  } else if (message === WM_DESTROY) {
    if (entry.snapOverlay) snapOverlays.delete(key(entry.snapOverlay));
    try {
      entry.hooks.onDestroyed();
    } catch {
      /* ignore */
    }
  }

  return symbols().CallWindowProcW(entry.originalProc, handle, message, wParam, lParam);
}

function sizeState(kind: number): WindowState | null {
  if (kind === SIZE_MAXIMIZED) return "maximized";
  if (kind === SIZE_MINIMIZED) return "minimized";
  if (kind === SIZE_RESTORED) return "normal";
  return null;
}

/**
 * Frameless windows keep the standard frame on the left, right and bottom (on
 * Windows 10/11 those are the invisible resize borders, so snapping, shadows
 * and resizing stay native) and only drop the caption at the top.
 */
function calcFramelessClientArea(
  entry: WindowEntry,
  handle: NativeHandle,
  wParam: number | bigint,
  lParam: number | bigint,
): number | bigint {
  // NCCALCSIZE_PARAMS.rgrc[0]: the proposed window rect, rewritten in place
  // into the client rect.
  const rect = new Int32Array(koffi.view(BigInt(lParam), 16));
  const top = rect[1];
  const bottom = rect[3];
  const result = symbols().CallWindowProcW(entry.originalProc, handle, WM_NCCALCSIZE, wParam, lParam);
  // A maximized window hangs over the monitor edges by the frame thickness;
  // keep the client area on screen by insetting the top by the same amount.
  rect[1] = isMaximized(handle) ? top + (bottom - rect[3]) : top;
  return result;
}

function parseColor(value: string | undefined): { r: number; g: number; b: number } | null {
  const match = value ? /^#?([0-9a-f]{6})$/i.exec(value.trim()) : null;
  if (!match) return null;
  const rgb = Number.parseInt(match[1], 16);
  return { r: (rgb >> 16) & 0xff, g: (rgb >> 8) & 0xff, b: rgb & 0xff };
}

function setDwmFlag(handle: NativeHandle, attribute: number, enabled: boolean): void {
  const value = Buffer.alloc(4);
  value.writeInt32LE(enabled ? 1 : 0);
  graphics().DwmSetWindowAttribute(handle, attribute, value, 4);
}

function applyWindowStyle(handle: NativeHandle, entry: WindowEntry, style: WindowStyle): void {
  const color = parseColor(style.backgroundColor);
  if (color) {
    const brush = graphics().CreateSolidBrush(color.r | (color.g << 8) | (color.b << 16));
    symbols().SetClassLongPtrW(handle, GCLP_HBRBACKGROUND, asPointer(brush));
    // The webview host widget is briefly exposed while resizing.
    const widget = asPointer(symbols().GetWindow(handle, GW_CHILD));
    if (widget) symbols().SetClassLongPtrW(widget, GCLP_HBRBACKGROUND, asPointer(brush));
    const luma = 0.299 * color.r + 0.587 * color.g + 0.114 * color.b;
    if (luma < 128) setDwmFlag(handle, DWMWA_USE_IMMERSIVE_DARK_MODE, true);
  }

  if (style.hidden && !symbols().IsWindowVisible(handle)) {
    // Cloaked windows are "shown" to the OS (layout, activation, WebView2
    // rendering) but DWM does not compose them until revealWindow().
    setDwmFlag(handle, DWMWA_CLOAK, true);
    entry.cloaked = true;
  }

  if (entry.frameless) {
    symbols().SetWindowPos(
      handle,
      null,
      0,
      0,
      0,
      0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
    );
  }
}

function subclassWindow(handle: NativeHandle, hooks: WindowHooks, style: WindowStyle = {}): void {
  const id = key(handle);
  if (windows.has(id)) {
    windows.get(id)!.hooks = hooks;
    return;
  }

  const callback = koffi.register(wndProc, koffi.pointer(WndProcProto));
  const entry: WindowEntry = {
    hooks,
    originalProc: 0n,
    callback,
    frameless: style.frameless ?? false,
    cloaked: false,
    snapOverlay: null,
  };
  windows.set(id, entry);
  entry.originalProc = asPointer(symbols().SetWindowLongPtrW(handle, GWLP_WNDPROC, callback));
  applyWindowStyle(handle, entry, style);
}

function revealWindow(handle: NativeHandle): void {
  const entry = windows.get(key(handle));
  if (entry?.cloaked) {
    setDwmFlag(handle, DWMWA_CLOAK, false);
    entry.cloaked = false;
  }
  if (!symbols().IsWindowVisible(handle)) symbols().ShowWindow(handle, SW_SHOW);
}

function postNonClientDown(handle: NativeHandle, hitTest: number): void {
  const api = symbols();
  const point = Buffer.alloc(8);
  api.GetCursorPos(point);
  const x = point.readInt32LE(0);
  const y = point.readInt32LE(4);
  // Hand the pressed mouse button over to the OS move/size loop.
  api.ReleaseCapture();
  api.PostMessageW(handle, WM_NCLBUTTONDOWN, hitTest, (((y & 0xffff) << 16) | (x & 0xffff)) >>> 0);
}

function startDrag(handle: NativeHandle): void {
  postNonClientDown(handle, HTCAPTION);
}

const RESIZE_HIT_TESTS: Record<ResizeEdge, number> = {
  top: HTTOP,
  "top-left": HTTOPLEFT,
  "top-right": HTTOPRIGHT,
};

function startResize(handle: NativeHandle, edge: ResizeEdge): void {
  if (isMaximized(handle)) return;
  postNonClientDown(handle, RESIZE_HIT_TESTS[edge]);
}

/* ------------------------------------------------------------ snap layouts */

// Windows 11 opens the snap layouts flyout when the window under the cursor
// answers WM_NCHITTEST with HTMAXBUTTON. The page (WebView2) covers the whole
// client area, so a transparent child window is placed over the page's
// maximize button to answer for it — the approach Windows Terminal uses.

const SNAP_OVERLAY_CLASS = "LumenSnapOverlay";
let snapOverlayClass: { instance: NativeHandle; callback: bigint } | null = null;

function overlayClass(): { instance: NativeHandle; callback: bigint } {
  if (snapOverlayClass) return snapOverlayClass;
  const instance = asPointer(loadKernel32().GetModuleHandleW(null));
  const callback = koffi.register(snapOverlayProc, koffi.pointer(WndProcProto));
  symbols().RegisterClassExW({
    cbSize: 80,
    style: 0,
    lpfnWndProc: callback,
    cbClsExtra: 0,
    cbWndExtra: 0,
    hInstance: instance,
    hIcon: null,
    hCursor: symbols().LoadCursorW(null, IDC_ARROW),
    hbrBackground: null,
    lpszMenuName: null,
    lpszClassName: SNAP_OVERLAY_CLASS,
    hIconSm: null,
  });
  snapOverlayClass = { instance, callback };
  return snapOverlayClass;
}

function setOverlayState(overlay: SnapOverlay, hover: boolean, pressed: boolean): void {
  if (overlay.hover === hover && overlay.pressed === pressed) return;
  overlay.hover = hover;
  overlay.pressed = pressed;
  try {
    windows.get(key(overlay.owner))?.hooks.onMaximizeButtonState?.({ hover, pressed });
  } catch {
    /* ignore */
  }
}

function snapOverlayProc(
  handle: NativeHandle | null,
  message: number,
  wParam: number | bigint,
  lParam: number | bigint,
): number | bigint {
  const overlay = handle ? snapOverlays.get(key(handle)) : undefined;
  if (overlay) {
    switch (message) {
      case WM_NCHITTEST:
        return HTMAXBUTTON;
      case WM_NCMOUSEMOVE:
        if (!overlay.hover) {
          // Ask for WM_NCMOUSELEAVE so the hover state can be cleared.
          const track = Buffer.alloc(24);
          track.writeUInt32LE(24, 0);
          track.writeUInt32LE(TME_LEAVE | TME_NONCLIENT, 4);
          track.writeBigUInt64LE(BigInt(handle!), 8);
          symbols().TrackMouseEvent(track);
        }
        setOverlayState(overlay, true, overlay.pressed);
        return 0;
      case WM_NCMOUSELEAVE:
        setOverlayState(overlay, false, false);
        return 0;
      case WM_NCLBUTTONDOWN:
      case WM_NCLBUTTONDBLCLK:
        setOverlayState(overlay, true, true);
        return 0;
      case WM_NCLBUTTONUP:
        if (overlay.pressed) {
          setOverlayState(overlay, overlay.hover, false);
          toggleMaximize(overlay.owner);
        }
        return 0;
    }
  }
  return symbols().DefWindowProcW(handle, message, wParam, lParam);
}

function setMaximizeButtonRegion(handle: NativeHandle, rect: PageRect | null): void {
  const entry = windows.get(key(handle));
  if (!entry) return;
  const api = symbols();

  if (!rect || rect.width <= 0 || rect.height <= 0 || rect.viewportWidth <= 0) {
    if (entry.snapOverlay) api.ShowWindow(entry.snapOverlay, SW_HIDE);
    return;
  }

  if (!entry.snapOverlay) {
    const { instance } = overlayClass();
    const overlay = asPointer(
      api.CreateWindowExW(
        WS_EX_LAYERED | WS_EX_NOREDIRECTIONBITMAP,
        SNAP_OVERLAY_CLASS,
        "",
        WS_CHILD,
        0,
        0,
        0,
        0,
        handle,
        null,
        instance,
        null,
      ),
    );
    if (!overlay) return;
    // Fully opaque, but with no redirection bitmap nothing is ever drawn: the
    // page shows through while the window still receives mouse input.
    api.SetLayeredWindowAttributes(overlay, 0, 255, LWA_ALPHA);
    entry.snapOverlay = overlay;
    snapOverlays.set(key(overlay), { owner: handle, hover: false, pressed: false });
  }

  // Page CSS pixels → client pixels (covers DPI scaling and page zoom).
  const client = Buffer.alloc(16);
  api.GetClientRect(handle, client);
  const scale = client.readInt32LE(8) / rect.viewportWidth;
  const left = Math.round(rect.x * scale);
  const top = Math.round(rect.y * scale);
  api.SetWindowPos(
    entry.snapOverlay,
    null, // HWND_TOP: above the webview widget
    left,
    top,
    Math.round((rect.x + rect.width) * scale) - left,
    Math.round((rect.y + rect.height) * scale) - top,
    SWP_NOACTIVATE | SWP_SHOWWINDOW,
  );
}

export function releaseWindow(handle: NativeHandle): void {
  const entry = windows.get(key(handle));
  if (!entry) return;
  if (entry.snapOverlay) snapOverlays.delete(key(entry.snapOverlay));
  windows.delete(key(handle));
  koffi.unregister(entry.callback);
}

function appendEntries(menu: NativeHandle, entries: MenuGroup["submenu"]): void {
  for (const entry of entries) {
    if (entry.type === "separator") {
      symbols().AppendMenuW(menu, MF_SEPARATOR, 0, null);
      continue;
    }

    const label = entry.accelerator ? `${entry.label}\t${entry.accelerator}` : (entry.label ?? "");
    const action = entry.action ?? (entry.role ? `role:${entry.role}` : undefined);
    const id = action ? nextMenuId++ : 0;
    if (action) menuActions.set(id, action);

    const flags = MF_STRING | (entry.enabled === false ? MF_GRAYED : 0);
    symbols().AppendMenuW(menu, flags, id, label);
  }
}

function setMenu(handle: NativeHandle, menu: MenuGroup[] | null): void {
  const api = symbols();
  if (!menu || menu.length === 0) {
    api.SetMenu(handle, null);
    api.DrawMenuBar(handle);
    return;
  }

  const bar = asPointer(api.CreateMenu());
  for (const group of menu) {
    const popup = asPointer(api.CreatePopupMenu());
    appendEntries(popup, group.submenu);
    api.AppendMenuW(bar, MF_POPUP | MF_STRING, popup, group.label);
  }
  api.SetMenu(handle, bar);
  api.DrawMenuBar(handle);
}

function setTitle(handle: NativeHandle, title: string): void {
  symbols().SetWindowTextW(handle, title);
}

function moveResize(
  handle: NativeHandle,
  bounds: { x?: number; y?: number; width?: number; height?: number },
): void {
  const flags =
    SWP_NOZORDER |
    SWP_NOACTIVATE |
    (bounds.width === undefined || bounds.height === undefined ? SWP_NOSIZE : 0) |
    (bounds.x === undefined || bounds.y === undefined ? SWP_NOMOVE : 0);
  symbols().SetWindowPos(
    handle,
    null,
    Math.round(bounds.x ?? 0),
    Math.round(bounds.y ?? 0),
    Math.round(bounds.width ?? 0),
    Math.round(bounds.height ?? 0),
    flags,
  );
}

function center(handle: NativeHandle, width: number, height: number): void {
  const screenWidth = symbols().GetSystemMetrics(SM_CXSCREEN);
  const screenHeight = symbols().GetSystemMetrics(SM_CYSCREEN);
  const x = Math.max(0, Math.round((screenWidth - width) / 2));
  const y = Math.max(0, Math.round((screenHeight - height) / 2));
  moveResize(handle, { x, y });
}

function focus(handle: NativeHandle): void {
  symbols().SetForegroundWindow(handle);
  symbols().SetFocus(handle);
}

function minimize(handle: NativeHandle): void {
  symbols().ShowWindow(handle, SW_MINIMIZE);
}

function toggleMaximize(handle: NativeHandle): void {
  symbols().ShowWindow(handle, isMaximized(handle) ? SW_RESTORE : SW_MAXIMIZE);
}

function isMaximized(handle: NativeHandle): boolean {
  return symbols().IsZoomed(handle) !== 0;
}

/* ------------------------------------------------------------------ dialogs */

/** Marker used by the PowerShell helper scripts to report failures. */
const ERROR_MARKER = "__LUMEN_ERROR__";

function powershell(script: string): Promise<CaptureResult> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return capture("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-STA",
    "-WindowStyle",
    "Hidden",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encoded,
  ]);
}

/** Turn helper-script failures into real errors instead of empty results. */
function assertDialogOk(result: CaptureResult): void {
  const marker = result.stdout.indexOf(ERROR_MARKER);
  if (marker >= 0) {
    const message = result.stdout.slice(marker + ERROR_MARKER.length).split(/\r?\n/)[0];
    throw new Error(`Native dialog failed: ${message.trim()}`);
  }
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(0, 4).join(" ");
    throw new Error(`Native dialog failed (exit ${result.code}): ${detail}`);
  }
}

/**
 * Shared prelude for the dialog scripts.
 *
 * NOTE: no `Add-Type -TypeDefinition` here — compiling C# requires the .NET
 * Framework compiler, which is not guaranteed to exist. Plain WinForms only.
 */
function dialogPrelude(): string {
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
`;
}

/** Wrap a body so failures are reported to the caller. */
function guarded(body: string): string {
  return `${dialogPrelude()}try {
${body}
} catch {
  [Console]::Out.WriteLine("${ERROR_MARKER}" + $_.Exception.Message)
  exit 1
}
`;
}

function psString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function showOpenDialog(options: OpenDialogOptions): Promise<string[]> {
  const directory = options.properties?.includes("openDirectory");

  if (directory) {
    const script = guarded(`
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = ${psString(options.title ?? "Select a folder")}
$dialog.ShowNewFolderButton = $true
${options.defaultPath ? `if (Test-Path ${psString(options.defaultPath)}) { $dialog.SelectedPath = ${psString(options.defaultPath)} }` : ""}
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.WriteLine($dialog.SelectedPath)
}`);
    const result = await powershell(script);
    assertDialogOk(result);
    return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }

  const multi = options.properties?.includes("multiSelections") ?? false;
  const script = guarded(`
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Multiselect = ${multi ? "$true" : "$false"}
$dialog.Title = ${psString(options.title ?? "Open file")}
$dialog.Filter = 'All files (*.*)|*.*'
$dialog.RestoreDirectory = $true
${options.defaultPath ? `if (Test-Path ${psString(options.defaultPath)}) { $dialog.InitialDirectory = ${psString(options.defaultPath)} }` : ""}
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  foreach ($file in $dialog.FileNames) { [Console]::Out.WriteLine($file) }
}`);
  const result = await powershell(script);
  assertDialogOk(result);
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function dialogFilter(filters: SaveDialogOptions["filters"]): string {
  const parts = (filters ?? []).map(
    (filter) => `${filter.name}|${filter.extensions.map((ext) => `*.${ext}`).join(";")}`,
  );
  parts.push("All files (*.*)|*.*");
  return parts.join("|");
}

async function showSaveDialog(options: SaveDialogOptions): Promise<string | null> {
  const defaultPath = options.defaultPath ?? "";
  const fileName = /[\\/]$/.test(defaultPath) ? "" : (defaultPath.split(/[\\/]/).pop() ?? "");
  const directory = fileName ? defaultPath.slice(0, defaultPath.length - fileName.length) : defaultPath;
  const script = guarded(`
$dialog = New-Object System.Windows.Forms.SaveFileDialog
$dialog.Title = ${psString(options.title ?? "Save As")}
$dialog.Filter = ${psString(dialogFilter(options.filters))}
$dialog.OverwritePrompt = $true
$dialog.RestoreDirectory = $true
${directory ? `if (Test-Path ${psString(directory)}) { $dialog.InitialDirectory = ${psString(directory)} }` : ""}
${fileName ? `$dialog.FileName = ${psString(fileName)}` : ""}
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.WriteLine($dialog.FileName)
}`);
  const result = await powershell(script);
  assertDialogOk(result);
  return result.stdout.trim() || null;
}

async function showMessageBox(options: MessageBoxOptions): Promise<{ response: number }> {
  const buttons = options.buttons ?? ["OK"];
  let buttonCode = 0; // OK
  if (buttons.length === 2) buttonCode = buttons.some((b) => /no/i.test(b)) ? 4 : 1;
  else if (buttons.length >= 3) buttonCode = 3; // YesNoCancel

  const iconCode =
    options.type === "error" ? 16 : options.type === "warning" ? 48 : options.type === "question" ? 32 : 64;

  const text = options.detail ? `${options.message}\n\n${options.detail}` : options.message;
  const defaultButton = (options.defaultId ?? 0) * 256;
  const cancelButton = options.cancelId ?? -1;

  const script = guarded(`
$text = ${psString(text)}
$title = ${psString(options.title ?? "Lumen")}
$result = [System.Windows.Forms.MessageBox]::Show($text, $title, [System.Windows.Forms.MessageBoxButtons]${buttonCode}, [System.Windows.Forms.MessageBoxIcon]${iconCode}, [System.Windows.Forms.MessageBoxDefaultButton]${defaultButton})
[Console]::Out.WriteLine([int]$result)`);

  const result = await powershell(script);
  assertDialogOk(result);
  const raw = Number.parseInt(result.stdout.trim(), 10);
  const response = Number.isNaN(raw) ? cancelButton : mapMessageBoxResponse(raw, buttons.length, options);
  return { response };
}

function mapMessageBoxResponse(
  raw: number,
  buttonCount: number,
  options: MessageBoxOptions,
): number {
  // WinForms DialogResult: OK=1, Cancel=2, Yes=6, No=7
  switch (raw) {
    case 6:
      return 0;
    case 7:
      return buttonCount > 2 ? 1 : buttonCount - 1;
    case 2:
      return options.cancelId ?? buttonCount - 1;
    case 1:
    default:
      return 0;
  }
}

function showItemInFolder(path: string): void {
  launch("explorer.exe", [`/select,${path}`]);
}

function openPath(path: string): void {
  launch("cmd.exe", ["/c", "start", "", path]);
}

export const win32Platform: Platform = {
  name: "win32",
  runMessageLoop,
  subclassWindow,
  releaseWindow,
  revealWindow,
  startDrag,
  startResize,
  setMaximizeButtonRegion,
  setMenu,
  setTitle,
  moveResize,
  center,
  focus,
  minimize,
  toggleMaximize,
  isMaximized,
  showOpenDialog,
  showSaveDialog,
  showMessageBox,
  showItemInFolder,
  openPath,
};
