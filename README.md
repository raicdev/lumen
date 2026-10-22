# Lumen

**A lightweight VS Code alternative.** Lumen looks and works like VS Code and runs VS Code extensions, but it is not Electron:
it draws its window with the system WebView through [Lumen Shell](./packages/lumen-shell), our own small desktop shell on Node.js.

## Download

Get the Windows x64 installer or the portable zip from [Releases](https://github.com/raicdev/lumen/releases). Installed copies
update themselves. Lumen needs the WebView2 runtime, which Windows 10 and 11 already have.

## Features

- **Familiar workbench**: command palette, Quick Open, VS Code keybindings, Settings and Keyboard Shortcuts editors, split
  editor groups, a movable panel and per-folder layouts.
- **VS Code extensions**: install from [Open VSX](https://open-vsx.org) or a `.vsix`. Extensions are converted on install and
  rated for compatibility, and they run in a separate extension host so they never freeze the window.
- **Built in**: integrated terminals, source control, search and replace across files, and TypeScript language features.
- **Light**: no bundled browser, and a Process Explorer that shows what each part of the app uses.

## Development

Requires [Node.js](https://nodejs.org) 24 or later and [pnpm](https://pnpm.io). Runs on Windows, macOS and Linux.

```bash
pnpm install
pnpm dev            # run with live reload
```

| Script                            | What it does                                                  |
| --------------------------------- | ------------------------------------------------------------- |
| `pnpm start` / `pnpm dev`         | Run the app (`dev` rebuilds and reloads on change)            |
| `pnpm test`                       | Run the tests                                                 |
| `pnpm typecheck`                  | Type-check with `tsc`                                         |
| `pnpm lint` / `pnpm format`       | Lint with oxlint / format with oxfmt                          |
| `pnpm package` / `pnpm installer` | Build `dist/Lumen/Lumen.exe` / the Windows setup (needs NSIS) |

```
src/main/        main process: files, terminals, language service, extension host
src/mainview/    the window (React, CodeMirror, xterm)
src/shared/      types shared by both sides
packages/        Lumen Shell, the desktop shell
```

## Writing extensions

A Lumen extension is a VS Code style extension that imports `lumen` instead of `vscode`; VS Code extensions work unchanged.
See [`examples/extensions/hello-lumen`](./examples/extensions/hello-lumen), and
[`src/shared/extension-api.ts`](./src/shared/extension-api.ts) for how complete each API is.

Extensions run with the same rights as Lumen, as in VS Code: install only extensions you trust.

## License

MIT, see [LICENSE](./LICENSE).
