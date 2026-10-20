# Lumen

**A fast, luminous code editor** — a Zed-inspired desktop editor built with
[Lumen Shell](./packages/lumen-shell) (our own lightweight, Electron-style
desktop shell), **Node.js**, and **TypeScript**.

No Electron, no bundled browser: Lumen Shell drives the operating system's
WebView (WebView2 / WKWebView / WebKitGTK) with its own event loop, typed IPC,
frameless windows, native dialogs and a close guard.

## Features

**Workbench (VS Code style)**

- Custom title bar + menu bar (File / Edit / Selection / View / Go / Terminal / Help, Alt+letter access, check marks), Windows 11 snap layouts, no white flash on startup
- Command palette (`Ctrl+Shift+P` / `F1`) and Quick Open (`Ctrl+P`) with fuzzy matching and modes: `>` commands, `:` line, `@` symbols, `?` help
- One command registry for the palette, menus and keybindings — chords (`Ctrl+K …`), user-editable **Keyboard Shortcuts** editor
- **Settings** editor (`Ctrl+,`): font, tab size, word wrap, minimap, indent guides, whitespace, auto save, format on save, …
- Tabs: preview tabs, drag to reorder, context menu (close others / to the right / saved / all, copy path, reveal), `Ctrl+Tab` editor switcher, reopen closed (`Ctrl+Shift+T`)
- Untitled files (`Ctrl+N`), Save As, Save All, Revert, auto save (after delay / on focus change)
- Restores the last folder and its open editors; Open Recent (`Ctrl+R`); welcome page
- Per-project layout: editor groups and their tabs, sidebar (visible / width / view), panel (visible / size / position / tab) and terminals (panel splits, terminals docked in the editor area, shell, folder, name) are saved for each folder and restored when it opens again — stored outside the project in `%APPDATA%\Lumen\workspaceStorage` (`~/Library/Application Support/Lumen/…` on macOS, `~/.config/Lumen/…` on Linux)
- Explorer: file-type icons, git and problem decorations, auto reveal, collapse all, keyboard navigation (arrows, Enter, F2, Delete)
- Search & replace in files: match case, whole word, regex (with `$1` previews), include / exclude globs
- **Source Control**: branch in the status bar, stage / unstage / discard, commit, inline diff against HEAD, gutter change markers
- Outline view, breadcrumbs, Problems / References / Terminal panel, Zen mode (`Ctrl+K Z`)
- Status bar: cursor & selection, indentation, EOL (LF/CRLF, preserved on save), language mode picker
- Files changed on disk are reloaded (or flagged when you have unsaved edits)

**Editor**

- CodeMirror 6 with multi-language highlighting, minimap, indentation guides, multi-cursor
- Per-tab undo history, selection and scroll position
- TypeScript language service: completions, hover, diagnostics, go to definition, **find references** (`Shift+F12`), **rename symbol** (`F2`, across files), **format document** (`Shift+Alt+F`), document symbols
- Back / Forward navigation (`Alt+Left` / `Alt+Right`), go to line, go to symbol, go to bracket
- Line commands: copy / move / delete / duplicate, sort, join, change case, trim whitespace, fold / unfold all

**Extensions**

- **Extensions view** (`Ctrl+Shift+X`): installed extensions (enable / disable / uninstall, details with README, contributed features and runtime status), search and install from [Open VSX](https://open-vsx.org), *Install from VSIX…*, *Install Extension from Location…* for development
- Extensions run in an **extension host** (a worker thread, so a busy extension never freezes the window) and use the `lumen` module — an API modelled on VS Code's `vscode` module
- **VS Code extensions** are converted by the **transpiler** when they are installed: `require("vscode")` → `require("lumen")` (also inside bundled libraries such as vscode-languageclient), a Lumen engine in the manifest, and a **compatibility report** (Details → Compatibility) listing every API the code uses and whether Lumen supports it
- Contributions: commands (palette), keybindings with `when` clauses, settings (Settings editor), snippets, language file associations; runtime: status bar items, output channels (Output panel, `Ctrl+Shift+U`), notifications, quick picks / input boxes, diagnostics, decorations, completions, hovers, signature help, go to definition / type definition / implementation / declaration, references, rename, document highlights, code actions (`Ctrl+.`), code lenses, inlay hints, semantic tokens, folding and selection ranges, document links, colors, on-type formatting, inline completions, linked editing, workspace symbols (`Ctrl+T`), language configurations, formatting, document symbols, terminals, file decorations, virtual documents, `window.tabGroups`, file operation and will-save events
- **Webviews**: panels in editor tabs (`createWebviewPanel`, restored after a restart by `registerWebviewPanelSerializer`) and webview views in contributed view containers — activity bar, panel, or the Explorer (`registerWebviewViewProvider`); `acquireVsCodeApi()`, VS Code theme variables, `asWebviewUri` / `cspSource`
- **File system providers** (`registerFileSystemProvider`): `workspace.fs` and editors open, edit and save documents of the extension's scheme (e.g. `memfs:/notes.md`)

**Shell**

- Native desktop window through **Lumen Shell** + the system WebView, close guard for unsaved changes
- Integrated terminals (`node-pty` → ConPTY on Windows): multiple terminals, split groups (`Ctrl+Shift+5`), shell profiles (PowerShell 7 / Windows PowerShell / cmd / Git Bash / WSL …), rename, relaunch, terminals as editor tabs
- Movable panel: dock it bottom / left / right by dragging its header (or *View: Move Panel …*), drag terminals into the editor area and back
- Split editor groups: drag a tab, an explorer file or a terminal to an edge of any editor group to dock it there (center = move into that group, Ctrl = copy); `Ctrl+\` splits, `Ctrl+1…4` focuses groups, `Ctrl+Alt+←/→` moves editors between groups; the same file open twice stays in sync

## Requirements

- [Node.js](https://nodejs.org) ≥ 24 (runs the TypeScript sources directly via type stripping)
- [pnpm](https://pnpm.io) ≥ 10
- Windows, macOS, or Linux

## Quick start

```bash
pnpm install
pnpm start          # or: pnpm dev   (rebuild + reload on change)
```

| Script | Description |
| --- | --- |
| `pnpm start` | Build the view, launch the app |
| `pnpm dev` | Dev with view watching (`src/`, `packages/`) and live reload |
| `pnpm build` | Production bundles into `.lumen/build` |
| `pnpm package` | Standalone app (`dist/Lumen/Lumen.exe`, a Node single executable) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | Extension tests (transpiler, VSIX reader, API surface, extension host end to end) |
| `pnpm ext:transpile <file.vsix \| folder> [--out dir]` | Convert a VS Code extension to a Lumen extension and print its compatibility report |

## Keyboard shortcuts

Defaults follow VS Code; change them in *Preferences: Keyboard Shortcuts* (`Ctrl+K Ctrl+S`).

| Shortcut | Action |
| --- | --- |
| `Ctrl+Shift+P` / `F1` | Command palette |
| `Ctrl+P` | Quick Open (go to file) |
| `Ctrl+G` / `Ctrl+Shift+O` | Go to line / symbol |
| `Ctrl+O` / `Ctrl+K Ctrl+O` | Open file / folder |
| `Ctrl+R` | Open recent folder |
| `Ctrl+N` | New untitled file |
| `Ctrl+S` / `Ctrl+Shift+S` / `Ctrl+K S` | Save / Save As / Save All |
| `Ctrl+W` / `Ctrl+Shift+T` | Close editor / reopen closed editor |
| `Ctrl+Tab`, `Ctrl+PageUp/PageDown`, `Alt+1…9` | Switch editors |
| `Ctrl+B` / `Ctrl+J` / ``Ctrl+` `` | Toggle sidebar / panel / terminal |
| ``Ctrl+Shift+` `` / `Ctrl+Shift+5` | New terminal / split terminal |
| `Ctrl+Shift+E` / `F` / `H` / `G` / `M` | Explorer / Search / Replace / Source Control / Problems |
| `Ctrl+F` / `Ctrl+H` | Find / replace in file |
| `F12` / `Shift+F12` / `F2` | Go to definition / references / rename symbol |
| `Shift+Alt+F` | Format document |
| `Alt+Left` / `Alt+Right` | Go back / forward |
| `Alt+Z` | Toggle word wrap |
| `Ctrl+Shift+X` / `Ctrl+Shift+U` | Extensions / Output panel |
| `Ctrl+,` | Settings |
| `Ctrl+K Z` | Zen mode (`Esc Esc` to leave) |

## Extensions

### Installing

- **Open VSX**: search in the Extensions view and click *Install*. VS Code extensions are transpiled on the way in; check *Details → Compatibility* afterwards.
- **VSIX**: *Extensions: Install from VSIX…* (or the ⋯ menu of the Extensions view).
- **Development**: *Developer: Install Extension from Location…* registers a folder in place. VS Code extension folders are not modified: they run through the compatibility layer (`require("vscode")` resolves to the Lumen API).

Extensions live in `~/.lumen/extensions` (override with `LUMEN_EXTENSIONS_DIR`); their storage (`globalState`, `workspaceState`, `globalStorageUri`, `secrets`, logs) in the app data folder (`%APPDATA%\Lumen\…`). Installing, enabling or disabling an extension restarts the extension host. Its log is the *Extension Host* channel of the Output panel.

> Extensions run with the same rights as Lumen — like in VS Code. Install only extensions you trust. `context.secrets` is stored unencrypted in the app data folder.

### Writing a Lumen extension

A Lumen extension is a folder with a VS Code style `package.json` (`engines.lumen`, `main`, `activationEvents`, `contributes`) and code that imports `lumen` (CommonJS or ES modules):

```js
const lumen = require("lumen"); // or: import * as lumen from "lumen"

exports.activate = (context) => {
  context.subscriptions.push(
    lumen.commands.registerCommand("hello.sayHello", () => lumen.window.showInformationMessage("Hello!")),
  );
};
```

See [`examples/extensions/hello-lumen`](./examples/extensions/hello-lumen) (commands, keybinding, settings, status bar, diagnostics, decorations, completions, hovers, snippets, a webview view in its own activity bar container, a webview panel with a serializer, an in-memory file system) and [`examples/extensions/vscode-word-tools`](./examples/extensions/vscode-word-tools) (an unmodified VS Code extension). The API follows VS Code's names and semantics; [`src/shared/extension-api.ts`](./src/shared/extension-api.ts) lists every member and how complete it is.

### VS Code compatibility

| Works | Accepted but inactive / limited | Not available |
| --- | --- | --- |
| commands, messages, quick picks, input boxes, status bar, output channels, progress, configuration, text documents & editors, edits, workspace files (`fs`, `findFiles`, watchers), diagnostics, decorations, completion / hover / definition / references / formatting / symbol providers, snippets, terminals (`sendText`), clipboard, `openExternal`, `globalState` / `workspaceState` / `secrets`, webview panels & views, panel serializers, file system providers | code actions, code lenses, signature help, rename, inlay hints, semantic tokens and other providers (registered, never called); notebook / task / debug classes (data only) | tree views, custom editors, webviews of custom editors / notebooks, debugging, tasks, SCM, notebooks, color / icon themes, TextMate grammars |

Webviews are sandboxed iframes served from their extension's own origin (`http://<id>.localhost:<port>`): isolated from the window, its bridge and other extensions, with working `localStorage` / IndexedDB that persist across restarts (the port is stable). Pages and local files are served only with a per-session token, and files only below the webview's `localResourceRoots` (by default the extension's folder and the workspace). Their pages stay loaded while hidden. Documents of extension file systems are not shown in the Explorer.

Unknown API members do not crash an extension: events never fire, `register…` returns a disposable and `create…` throws a clear "not supported by Lumen yet" error, which is logged.

## Architecture

```
src/
  main/                # Main process — FS, dialogs, language service, PTY, window
    extensions/        # Extension manager, VS Code → Lumen transpiler, VSIX reader, Open VSX, host client
    exthost/           # Extension host (worker thread): module loader, the `lumen` API, documents
  mainview/            # React renderer — App, components, CodeMirror, xterm
  shared/              # Typed RPC schema (main ↔ webview), extension protocol & API table
packages/
  lumen-shell/         # The desktop shell itself (window, event loop, IPC, menus…)
```

The extension host talks to the view through the main process: the view mirrors open documents into the host (incremental edits) and answers the host's UI requests (messages, pickers, edits, terminals).

The renderer never touches Node APIs: everything goes through the typed RPC
channels defined in `src/shared/types.ts` (`defineMainRPC` / `defineViewRPC`).

See [`packages/lumen-shell/README.md`](./packages/lumen-shell/README.md) for the
shell's design notes, API and platform support matrix.

## License

MIT — see [LICENSE](./LICENSE).
