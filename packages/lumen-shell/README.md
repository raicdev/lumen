# Lumen Shell

A tiny, self-contained "Electron replacement" for Node.js: it opens a **native OS
window** with the **system WebView** (WebView2 / WKWebView / WebKitGTK), owns the
**event loop itself**, and gives you **typed IPC** — without bundling Chromium and
without a giant framework.

```
┌─────────────────────────── Node main process ────────────────────────────┐
│  app / BrowserWindow / Menu / dialog / shell      ← Lumen Shell API       │
│  own message loop (PeekMessage ⇄ await)           ← keeps IPC async       │
│  RpcEndpoint (typed, schema-driven)                                       │
└───────────────┬──────────────────────────────────────────────────────────┘
                │ loopback HTTP (assets) + native bind/eval (IPC)
┌───────────────▼──────────────────────────────────────────────────────────┐
│  system WebView: prelude (window.__lumen) + your React/TS app            │
└──────────────────────────────────────────────────────────────────────────┘
```

## Design decisions

| Concern           | Decision                                                                                                                                                                                                                                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Window + webview  | the small `webview` C library (prebuilt binaries vendored in `native/`), loaded through our own [koffi](https://koffi.dev) FFI bindings                                                                                                                                                                                           |
| Event loop        | **ours**: the Win32 message queue (CoreFoundation / GLib elsewhere) is pumped in an `await`able loop, so async handlers resolve while the window stays responsive. `webview_run()` is deliberately never called.                                                                                                                  |
| IPC               | JSON envelopes over a single native binding (`__lumen_invoke`) + `eval` for the other direction; requests, responses and messages share one protocol                                                                                                                                                                              |
| Assets            | served from `127.0.0.1` by `node:http` (a real origin is required for bindings, `localStorage`, `fetch`)                                                                                                                                                                                                                          |
| Native dialogs    | WinForms via PowerShell (`FolderBrowserDialog`, `OpenFileDialog`, `MessageBox`) — no C# compilation needed                                                                                                                                                                                                                        |
| Menus             | real Win32 menu bar (FFI) on Windows, in-page menu bar elsewhere; items dispatch `menu-action` events                                                                                                                                                                                                                             |
| Close guard       | the window is subclassed so `WM_CLOSE` can be intercepted and an async guard (unsaved changes) runs first                                                                                                                                                                                                                         |
| Frameless windows | `frame: false` drops only the caption in `WM_NCCALCSIZE` (side/bottom resize borders, shadow and snapping stay native); `[data-lumen-drag-region]` drags via `WM_NCLBUTTONDOWN`, the prelude adds the top resize edge                                                                                                             |
| Snap layouts      | the page marks its maximize button with `data-lumen-maximize-button`; a transparent child window over it answers `WM_NCHITTEST` with `HTMAXBUTTON` (as Windows Terminal does), so Windows 11 shows the snap layouts flyout                                                                                                        |
| Stable origin     | the asset server prefers a port derived from the app identifier, so `localStorage` survives restarts                                                                                                                                                                                                                              |
| No startup flash  | the window is DWM-cloaked until the page reports its first painted frame; `backgroundColor` also feeds WebView2's default background and the window class brush                                                                                                                                                                   |
| Bundling          | esbuild for the view and the main process; in dev the main process runs from source (Node type stripping)                                                                                                                                                                                                                         |
| Packaging         | `lumen-shell package` bundles both sides, builds a Node [single executable](https://nodejs.org/api/single-executable-applications.html) launcher and copies the native libraries/addons next to it; on Windows the executable gets the `package.icon`, version info and the GUI subsystem (no console window)                     |
| Installer         | `lumen-shell installer` wraps the packaged app in a per-user NSIS setup (Start menu shortcut, uninstaller, installed apps entry); it waits for the running app to exit, and `/S /RELAUNCH` installs silently (`/UPDATE` shows only its progress) and starts the app again                                                                                             |
| Updates           | `autoUpdater` checks the latest GitHub release (tag `v<semver>`; with `autoUpdater.channel = "beta"` the newest release, pre-releases included), downloads its `<App>-<version>-win32-<arch>-setup.exe`, verifies the SHA-256 digest GitHub publishes for the asset and runs it over the installation, showing only its progress, when the app exits |

## API

Main process:

```ts
import { app, autoUpdater, BrowserWindow, Menu, dialog, shell, defineMainRPC } from "@lumen/shell/main";
import type { AppRPC } from "./shared/types";

const rpc = defineMainRPC<AppRPC>({
  handlers: {
    requests: { readFile: async ({ path }) => readTextFile(path) },
    messages: { log: ({ msg }) => console.log("[view]", msg) },
  },
});

app.configure({ name: "Lumen", version: "0.1.0" });

app.on("ready", () => {
  const win = new BrowserWindow<AppRPC>({
    title: "Lumen",
    width: 1280,
    height: 800,
    url: app.assetUrl("index.html"),   // serves the built assets
    rpc,
    frame: false,                       // draw your own title bar (Windows)
    backgroundColor: "#1e1e1e",         // painted until the page's first frame
    closeGuard: async () => await askTheView(),
  });

  win.on("menu-action", (action) => win.webContents.send.menuAction({ action }));
  win.webContents.send.terminalData({ id, data });        // typed message
  const answer = await win.webContents.request.requestCloseCheck({}); // typed request
  Menu.setApplicationMenu([{ label: "File", submenu: [{ label: "Save", action: "save" }] }]);
  void dialog.showOpenDialog({ properties: ["openDirectory"] });
  shell.showItemInFolder("/tmp/file.ts");
});

autoUpdater.configure({ repository: "owner/repo", name: "Lumen", version: "0.1.0", identifier: "dev.lumen.editor" });
const update = await autoUpdater.check();           // a newer release, or null
if (update && autoUpdater.canInstall) {             // installed by the setup (not portable / dev)
  const file = await autoUpdater.download(update, (received, total) => {});
  if (await win.requestClose()) autoUpdater.install(file, { relaunch: true });
}

await app.run();
```

Renderer:

```ts
import { defineViewRPC } from "@lumen/shell/view";

export const rpc = defineViewRPC<AppRPC>({
  handlers: {
    requests: { requestCloseCheck: async () => ({ allow: true, dirtyCount: 0 }) },
    messages: { menuAction: ({ action }) => window.dispatchEvent(new CustomEvent("app:menu", { detail: { action } })) },
  },
});

const file = await rpc.request.readFile({ path });
rpc.send.log({ msg: "hello main" });
```

## CLI

```bash
lumen-shell dev [--watch]   # build the view, serve it, launch the app (--watch rebuilds + reloads)
lumen-shell build           # production bundles → .lumen/build
lumen-shell package         # standalone app → dist/<App>/<App>.exe
lumen-shell installer       # Windows setup → dist/<App>-<version>-win32-<arch>-setup.exe (needs NSIS)
```

Configured by `lumen.config.ts` in the project root (`app`, `main`, `view`).

## Platform notes

|                                          | Windows         | macOS             | Linux             |
| ---------------------------------------- | --------------- | ----------------- | ----------------- |
| Window, event loop, assets, IPC, dialogs | ✅              | ✅                | ✅                |
| Custom window chrome (min / max / …)     | ✅              | in-app            | in-app            |
| Frameless window (`frame: false`)        | ✅              | –                 | –                 |
| Snap layouts flyout                      | ✅ (Windows 11) | –                 | –                 |
| Hidden until first paint                 | ✅              | –                 | –                 |
| Native menu bar                          | ✅              | in-page (prelude) | in-page (prelude) |
| Close guard (`WM_CLOSE` interception)    | ✅              | –                 | –                 |

Native dialogs on Windows need `powershell.exe` + WinForms (present on every
Windows install); macOS/Linux use `osascript` / `zenity`.

## Requirements

- Node.js ≥ 24 (TypeScript sources run directly through type stripping)
- The prebuilt `webview` library in `native/` (MIT, see `native/LICENSE.webview`;
  `LUMEN_WEBVIEW_LIB` overrides the path)
- On Windows: the WebView2 runtime (preinstalled on Windows 11)
