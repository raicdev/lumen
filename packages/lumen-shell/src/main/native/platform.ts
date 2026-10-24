import type { MenuGroup } from "../../shared/menu.ts";
import type { NativeHandle } from "./webview.ts";

export type { MenuEntry, MenuGroup } from "../../shared/menu.ts";

export type WindowHooks = {
  /** True while a close guard (unsaved changes) is armed. */
  hasCloseGuard: () => boolean;
  /** The user tried to close a guarded window. */
  onClose: () => void;
  onDestroyed: () => void;
  onMenuAction: (action: string) => void;
  /** The window was maximized, restored or minimized. */
  onStateChange?: (state: WindowState) => void;
  /** The window became the foreground window, or another one did. */
  onActiveChange?: (active: boolean) => void;
  /** Hover / press state of the snap-layout maximize button region changed. */
  onMaximizeButtonState?: (state: { hover: boolean; pressed: boolean }) => void;
};

/** A page element's box, in CSS pixels, plus the viewport size used to scale it. */
export type PageRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
};

export type WindowState = "normal" | "maximized" | "minimized";

/** Native window styling applied before the window is first shown. */
export type WindowStyle = {
  /** Remove the OS title bar; the page draws its own (resize borders stay native). */
  frameless?: boolean;
  /** Window / webview background (`#rrggbb`), painted before the page has rendered. */
  backgroundColor?: string;
  /** Keep the window invisible until `revealWindow()` (avoids a blank first frame). */
  hidden?: boolean;
};

/** Edges the page can start a resize from when the window is frameless. */
export type ResizeEdge = "top" | "top-left" | "top-right";

export type OpenDialogOptions = {
  title?: string;
  defaultPath?: string;
  /** "openFile" | "openDirectory" | "multiSelections" */
  properties?: string[];
  filters?: { name: string; extensions: string[] }[];
};

export type SaveDialogOptions = {
  title?: string;
  /** Directory or full file path to start from. */
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
};

export type MessageBoxOptions = {
  type?: "none" | "info" | "warning" | "error" | "question";
  title?: string;
  message: string;
  detail?: string;
  buttons?: string[];
  defaultId?: number;
  cancelId?: number;
};

export type Platform = {
  readonly name: "win32" | "darwin" | "linux";
  runMessageLoop(options: { shouldContinue: () => boolean }): Promise<void>;
  subclassWindow(handle: NativeHandle, hooks: WindowHooks, style?: WindowStyle): void;
  /** Show a window that was created with `hidden: true`. */
  revealWindow?(handle: NativeHandle): void;
  /** Start an OS window move (title bar drag) with the mouse button held down. */
  startDrag?(handle: NativeHandle): void;
  /** Start an OS window resize from the given edge. */
  startResize?(handle: NativeHandle, edge: ResizeEdge): void;
  /**
   * Where the page draws its maximize button (frameless windows). The OS then
   * treats that area as the real maximize button, which enables the Windows 11
   * snap layouts flyout. `null` removes the region.
   */
  setMaximizeButtonRegion?(handle: NativeHandle, rect: PageRect | null): void;
  setMenu(handle: NativeHandle, menu: MenuGroup[] | null): void;
  setTitle(handle: NativeHandle, title: string): void;
  moveResize(handle: NativeHandle, bounds: { x?: number; y?: number; width?: number; height?: number }): void;
  center(handle: NativeHandle, width: number, height: number): void;
  focus(handle: NativeHandle): void;
  minimize(handle: NativeHandle): void;
  toggleMaximize(handle: NativeHandle): void;
  isMaximized(handle: NativeHandle): boolean;
  /** Called when the window is destroyed programmatically (not from a window message). */
  releaseWindow?(handle: NativeHandle): void;
  showOpenDialog(options: OpenDialogOptions, owner?: NativeHandle): Promise<string[]>;
  /** Resolves with the chosen path, or `null` when cancelled. */
  showSaveDialog(options: SaveDialogOptions, owner?: NativeHandle): Promise<string | null>;
  showMessageBox(options: MessageBoxOptions, owner?: NativeHandle): Promise<{ response: number }>;
  showItemInFolder(path: string): void;
  openPath(path: string): void;
};
