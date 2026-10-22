import koffi from "koffi";
import type { NativeHandle } from "./webview.ts";
import { capture, launch } from "./process.ts";
import type { MenuGroup, MessageBoxOptions, OpenDialogOptions, Platform, SaveDialogOptions, WindowHooks } from "./platform.ts";

/**
 * POSIX backends (macOS / Linux).
 *
 * The message loop is pumped through the platform toolkit (CoreFoundation /
 * GLib) instead of `webview_run`, for the same reason as on Windows: the Node
 * event loop must stay alive so async IPC handlers can resolve.
 *
 * Window chrome (minimize / maximize / native menus) is a Windows feature of
 * Lumen Shell today; on macOS and Linux those calls are no-ops, so use in-app
 * UI for those controls.
 */

const noop = () => {};

const K_CF_STRING_ENCODING_UTF8 = 0x08000100;

type CoreFoundation = {
  runLoopTick: () => void;
};

let coreFoundation: CoreFoundation | null = null;

function loadCoreFoundation(): CoreFoundation {
  const lib = koffi.load("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation");
  const CFRunLoopRunInMode = lib.func("int32_t CFRunLoopRunInMode(void *mode, double seconds, uint8_t returnAfterSourceHandled)");
  const CFStringCreateWithCString = lib.func("void *CFStringCreateWithCString(void *alloc, const char *str, uint32_t encoding)");

  // CFRunLoop compares modes by value, so an equal CFString works in place of
  // the exported `kCFRunLoopDefaultMode` constant.
  const mode = CFStringCreateWithCString(null, "kCFRunLoopDefaultMode", K_CF_STRING_ENCODING_UTF8);

  return {
    runLoopTick: () => {
      CFRunLoopRunInMode(mode, 0.002, 0);
    },
  };
}

type Glib = { iteration: (context: NativeHandle | null, mayBlock: number) => number };

let glib: Glib | null = null;

function loadGlib(): Glib {
  for (const candidate of ["libglib-2.0.so.0", "libglib-2.0.so"]) {
    try {
      const lib = koffi.load(candidate);
      const iterate = lib.func("int g_main_context_iteration(void *context, int mayBlock)");
      return { iteration: (context, mayBlock) => iterate(context, mayBlock) };
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error("Lumen Shell: could not load GLib (required for the Linux message loop)");
}

async function runMessageLoop(options: { shouldContinue: () => boolean }): Promise<void> {
  const isDarwin = process.platform === "darwin";
  while (options.shouldContinue()) {
    if (isDarwin) {
      coreFoundation ??= loadCoreFoundation();
      coreFoundation.runLoopTick();
    } else {
      glib ??= loadGlib();
      while (glib.iteration(null, 0)) {
        /* drain the pending main-context events */
      }
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function subclassWindow(_handle: NativeHandle, _hooks: WindowHooks): void {
  console.warn("[lumen-shell] close guards are not implemented on this platform");
}

function setMenu(_handle: NativeHandle, menu: MenuGroup[] | null): void {
  if (menu && menu.length) {
    console.warn("[lumen-shell] native menus are not implemented on this platform; render them in-app");
  }
}

function setTitle(_handle: NativeHandle, _title: string): void {
  // Handled by the webview library (NSWindow / GtkWindow) — nothing to do here.
}

async function spawnCapture(command: string[]): Promise<string> {
  const [file, ...args] = command;
  const result = await capture(file, args);
  return result.stdout.trim();
}

async function showOpenDialog(options: OpenDialogOptions): Promise<string[]> {
  const directory = options.properties?.includes("openDirectory");

  if (process.platform === "darwin") {
    const prompt = options.title ?? (directory ? "Select a folder" : "Open file");
    const script = directory
      ? `POSIX path of (choose folder with prompt "${prompt}")`
      : `set theFiles to (choose file with prompt "${prompt}"${options.properties?.includes("multiSelections") ? " with multiple selections allowed" : ""})
set theOutput to ""
repeat with f in theFiles
  set theOutput to theOutput & POSIX path of f & linefeed
end repeat
return theOutput`;
    const stdout = await spawnCapture(["osascript", "-e", script]);
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  const args = ["zenity", "--file-selection", `--title=${options.title ?? "Open"}`];
  if (directory) args.push("--directory");
  if (options.properties?.includes("multiSelections")) args.push("--multiple", "--separator=\n");
  const stdout = await spawnCapture(args);
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function showSaveDialog(options: SaveDialogOptions): Promise<string | null> {
  const defaultPath = options.defaultPath ?? "";
  if (process.platform === "darwin") {
    const name = defaultPath.split("/").pop() ?? "";
    const script = `POSIX path of (choose file name with prompt "${options.title ?? "Save As"}"${name ? ` default name "${name.replace(/"/g, '\\"')}"` : ""})`;
    return (await spawnCapture(["osascript", "-e", script])) || null;
  }
  const args = ["zenity", "--file-selection", "--save", "--confirm-overwrite", `--title=${options.title ?? "Save As"}`];
  if (defaultPath) args.push(`--filename=${defaultPath}`);
  return (await spawnCapture(args)) || null;
}

async function showMessageBox(options: MessageBoxOptions): Promise<{ response: number }> {
  const buttons = options.buttons ?? ["OK"];
  const text = options.detail ? `${options.message}\n\n${options.detail}` : options.message;

  if (process.platform === "darwin") {
    const buttonList = buttons.map((button) => `"${button}"`).join(", ");
    const script = `display dialog "${text.replace(/"/g, '\\"')}" buttons {${buttonList}} default button ${
      (options.defaultId ?? 0) + 1
    } with title "${options.title ?? "Lumen"}"`;
    const stdout = await spawnCapture(["osascript", "-e", script]);
    const match = /button returned:(.*)$/m.exec(stdout);
    const index = match ? buttons.findIndex((button) => button === match[1].trim()) : 0;
    return { response: index < 0 ? 0 : index };
  }

  await spawnCapture([
    "zenity",
    "--question",
    `--title=${options.title ?? "Lumen"}`,
    `--text=${text}`,
    `--ok-label=${buttons[0] ?? "OK"}`,
    `--cancel-label=${buttons[1] ?? "Cancel"}`,
  ]);
  return { response: 0 };
}

function showItemInFolder(path: string): void {
  if (process.platform === "darwin") {
    launch("open", ["-R", path]);
    return;
  }
  launch("xdg-open", [path.replace(/[/\\][^/\\]*$/, "")]);
}

function openPath(path: string): void {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  launch(command, [path]);
}

export const posixPlatform: Platform = {
  name: process.platform === "darwin" ? "darwin" : "linux",
  runMessageLoop,
  subclassWindow,
  setMenu,
  setTitle,
  moveResize: noop,
  center: noop,
  focus: noop,
  minimize: noop,
  toggleMaximize: noop,
  isMaximized: () => false,
  showOpenDialog,
  showSaveDialog,
  showMessageBox,
  showItemInFolder,
  openPath,
};
