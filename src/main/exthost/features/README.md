# Feature plug-ins (host + window)

Each area (`tasks`, `scm`, `testing`, `notebooks`, `authentication`, `comments`,
`chat-lm`, `terminal`, `languages-extra`, `workspace-misc`, `icon-themes`,
`theming-contribs`, `issue-reporter`, `ports`, `timeline`, `menus-walkthroughs`) plugs into Lumen through files it owns.
Everything shared (api.ts, host.ts, App.tsx, Panel.tsx, StatusBar.tsx, editor.ts,
lib/extensions.ts, shared/extensions.ts, shared/extension-api.ts, index.html,
lumen.config.ts, package.json) is already wired: **do not edit shared files**.
If you need something they do not offer, put it in "followups" in your answer.

## Files of an area `<area>` (e.g. `chat-lm`)

| File | What |
| --- | --- |
| `src/main/exthost/features/<area>.ts` | `export const <camelArea>Feature: HostFeature` (extension host worker) |
| `src/mainview/features/<area>.tsx` | `export const <camelArea>View: ViewFeature` (window, React) |
| `src/mainview/features/feature-<area>.css` | styles; linked from index.html and copied by the build. **Do not `import` css from a .tsx** (esbuild would emit `index.css`, which the build overwrites) |
| `src/shared/extension-support/<area>.ts` | `export const <camelArea>Support: AreaSupport`: the support table changes (see below) |
| `test/<area>.test.ts` | your tests (`pnpm test` runs `test/*.test.ts`) |

You may add more files: `src/main/exthost/features/<area>/*.ts`,
`src/mainview/features/<area>/*.tsx`, `src/shared/feature-<area>.ts` (types shared by
host and window), `test/fixtures/<area>/...`. Never create files other areas might need.
Host files are run by Node directly: relative imports end in `.ts`, `import type`
for types, no enums / namespaces / parameter properties (type stripping only).
Window files are bundled by esbuild: imports without extension.

Modules you may import from freely: `../types.ts` (Uri, Position, Range, EventEmitter,
Disposable, ...), `../compat-types.ts`, `../wire.ts` (`toWire`), `../documents.ts`,
`../workspace-edit.ts`. Types of `ExtensionHost` / `ExtensionRuntime` come from `../host.ts`
(`import type` only).

## Host side: `HostFeature` (features/contract.ts, aggregated in registry.ts)

```ts
import type { HostFeature } from "./contract.ts";
import { NOT_HANDLED } from "./contract.ts";

export const tasksFeature: HostFeature = {
  area: "tasks",
  // Members merged into namespaces of the API object, once per extension. Same-name members
  // OVERRIDE existing ones (including window.createTerminal, workspace.saveAs, ...). Namespaces:
  // window workspace languages env debug commands extensions l10n tasks scm tests notebooks
  // authentication comments chat lm.  Unlisted members of a namespace still get the graceful
  // fallbacks (events never fire, register* accepted, create* throws). Getters stay getters.
  api: ({ host, runtime, extensionId, notSupported }) => ({
    tasks: { registerTaskProvider: (type, provider) => new Disposable(() => {}) },
    window: { createTerminal: (...args) => ... },
  }),
  // Top-level exports of the module (classes, enums); override compat stand-ins of the same name
  // (compat-types.ts) and everything in api.ts `exportedTypes`.
  types: { Task: Task, TaskScope: { Global: 1, Workspace: 2 } },
  // Built-in command ids executeCommand handles. The window learns them (palette/keybinding
  // routing sends them to the host).
  commands: ["workbench.action.tasks.runTask"],
  // Host started (after `ready` was posted to the window): subscribe to host events here.
  init: (host) => {},
  // { type: "feature", area, payload } from the window (api.sendToHost). Ordered with
  // document edits. Payload is plain JSON (Uris are not revived: use T.Uri.revive).
  onViewMessage: (host, payload) => {},
  // api.requestHost(method, args) from the window. Return a JSON-like value (toWire is applied).
  onViewRequest: async (host, method, args) => ...,
  // Commands no extension registered; runs BEFORE the built-in switch in host.executeCommand
  // (so you can override vscode.* ids) and after extension-registered commands. Return NOT_HANDLED to pass.
  executeCommand: async (host, command, args) => (command === "x" ? doIt(args) : NOT_HANDLED),
  // Tab.input of an editor tab a view feature renders (window.tabGroups): return e.g. new TabInputNotebook(...)
  tabInput: ({ openerId, uri, label }) => undefined,
};
```

Host helpers (on `ExtensionHost`):

- `host.postFeature(area, payload)`: message to your `ViewFeature.onHostMessage`.
- `host.requestFeatureView(area, method, args?)`: `Promise` of what your `ViewFeature.onHostRequest` returns (rejects on error).
- Existing: `host.post(msg)`, `host.requestView(method, ...)` (typed `ViewMethods`: showQuickPick, showInputBox, showTextDocument, createTerminal, terminalSendText, ...), `host.requestMain(...)`, `host.log(level, msg, extensionId?)`, `host.executeCommand(id, args)`, `host.documents`, `host.workspace`, `host.config`, `host.commands`, `host.runtimes`, `host.terminals`, `host.debug`, `host.tabGroups`, `host.onDid*` emitters, `host.activateByEvent("onCommand:x")`.
- To be called by the window for built-ins, register command ids in `commands`; the window runs them with `api.executeCommand(id, ...args)` (it routes ids it does not know to the host).
- Per-extension state: build it inside `api(ctx)` (one call per extension); shared state: module-level or on a `WeakMap<ExtensionHost, ...>` / created in `init`.
- Keep payloads small and JSON-only; use ids/handles instead of objects.

## Window side: `ViewFeature` (mainview/features/types.ts)

```tsx
import { ListChecks } from "lucide-react";
import type { ViewFeature } from "./types";
import { createStore, useStore } from "./store";

export const tasksView: ViewFeature = {
  area: "tasks",
  init: (api) => {},                    // once, at window start (App effect)
  onHostReady: (api) => {},             // extension host (re)started and the extension list arrived
  onHostMessage: (payload, api) => {},  // host.postFeature(area, payload)
  onHostRequest: async (method, args, api) => ...,   // host.requestFeatureView(area, method, args)
  commands: [{ id: "workbench.action.tasks.show", title: "Show Tasks", category: "Tasks", run: (api) => ..., enabled?, checked? }],
  sidebarViews: [{ id: "tasks", title: "Tasks", icon: ListChecks /* lucide component or codicon id string */, render: () => <TasksPanel />, badge: () => count }],
  panelTabs: [{ id: "tasks.terminal", title: "Tasks", render: () => <X />, badge?: () => 0 }],
  editorOpeners: [{ id: "notebooks.editor", match: (path) => path.endsWith(".ipynb"), render: (path, api) => <Notebook path={path} api={api} />, title?: (path) => ..., save?: async (path, api) => true }],
  editorExtensions: (path, languageId, api) => [/* CodeMirror 6 Extension[] */],
  statusBarItems: [{ id: "tasks.running", side: "left", priority: 10, text: () => "$(sync~spin) 2 tasks", tooltip?, command?: "workbench.action.tasks.show", color?: () => "#fff" }],
};
```

Surfaces and ids:

- Sidebar view `id` -> activity bar button + sidebar panel (kept mounted, hidden when inactive) + palette command `workbench.view.feature.<id>` ("View: Show <title>"). `api.revealSidebarView(id)` shows it. Ids are global: prefix with your area.
- Panel tab `id` -> tab next to Problems/Output/Terminal (+ command `workbench.panel.feature.<id>`). `api.revealPanelTab(id)`.
- `commands` -> palette, keybindings, extensions' `executeCommand`, menus. Ids are global.
- Editor opener: opening a file where `match(path)` is true makes a tab `feature-editor:<openerId>:<path>` rendering `render(path, api)` instead of a text editor (replaces an already open plain tab of the file; restored sessions reopen the file through the opener; the tab unmounts when another tab is active, so keep state in a store keyed by path). `api.setEditorDirty(path, dirty)` shows the dirty dot and makes closing prompt; the prompt calls `save(path, api)`; Ctrl+S too. Window tabGroups report `kind: "feature"` (host `tabInput` turns it into a Tab input). Opening with `viewType: "default"` bypasses openers.
- `editorExtensions` are added when a document's editor state is created (per document); use CodeMirror `StateField` / `ViewPlugin` (read your store / `api.requestHost` inside).
- Status bar items: functions are re-evaluated when `refreshFeatures()` / `api.refresh()` is called. Text may use `$(codicon)`; unknown codicons are dropped (see components/Codicon.tsx ICONS), so check there or use lucide for sidebar icons.
- Re-render: `createStore(initial)` + `useStore(store)` (features/store.ts) for React state shared across surfaces; `refreshFeatures()` for badge / status / panel tab functions.
- Styles: put them in `feature-<area>.css`; use the app's CSS variables (`--bg`, `--text`, `--text-muted`, `--vscode-*` theme variables).

`ViewFeatureApi` (second parameter of every hook; also `featureApi(area)` from registry.ts):

```ts
sendToHost(payload) / requestHost<T>(method, args?)              // to HostFeature of the same area
executeCommand(id, ...args)       // window command (features', built-ins), else the extension host
openFile(path, { line, character, preview, focus, beside })
showQuickPick(items: {label, description?, detail?, picked?}[], { title, placeholder, canPickMany, ... }) // -> indexes | null
showInputBox({ title, prompt, value, placeholder, password })   // -> string | null
showMessage("info" | "warning" | "error", message, actions?)    // -> action index | null
revealSidebarView(id) / revealPanelTab(id) / refresh() / setEditorDirty(path, dirty)
getExtensions()                   // enabled ExtensionDescription[] (manifest.contributes, location, id)
getSettings() / onSettingsChange(l) / getExtensionSetting(key)
readFile(path) / writeFile(path, content)
theme.color(id) / theme.isDark() / theme.onChange(l)
terminals                         // lib/terminals.ts terminalService (create, sendText, focus, setActive, ...)
```

Other window modules usable directly: `lib/extensions.ts` (`extensionService`: `call`, `post`, `getSnapshot`, `viewPath`), `lib/terminals.ts`, `lib/settings.ts`, `lib/theme.ts`, `lib/toast.ts`, `lib/dialog.ts`, `lib/context-menu.ts`, `lib/rpc.ts` (`api().request.*` main-process calls), `components/Codicon.tsx`, `components/FileIcon.tsx`.

## Protocol (already in shared/extensions.ts)

- window -> host: `{ type: "feature"; area; payload }` message; `HostMethods.feature(area, method, args)` call.
- host -> window: `{ type: "feature"; area; payload }` message; `ViewMethods.feature(area, method, args)` request.

## Support table (what the Extensions UI shows)

`src/shared/extension-api.ts` merges `src/shared/extension-support/<area>.ts` over its base table.
Your file exports `AreaSupport`:

```ts
export const tasksSupport: AreaSupport = {
  // Members; "supported" or ["partial", "short honest note"]. null removes an entry (do that for the
  // "tasks.*": "unsupported" wildcard and any stale "unsupported" members you now implement - just overwrite them).
  api: { "tasks.*": null, "tasks.registerTaskProvider": "supported", "tasks.fetchTasks": ["partial", "only shell tasks"] },
  // Classes / enums you now export: moved into API_TYPES, removed from API_TYPES_COMPAT / API_TYPES_MISSING.
  types: ["Task", "TaskScope"],
  // contributes.* points (CONTRIBUTION_SUPPORT)
  contributions: { taskDefinitions: "supported", problemMatchers: ["partial", "..."] },
};
```

Rules: no entry may stay "unsupported" for your area: implement it for real or mark it `partial` with an honest note.
`test/extensions.test.ts` ("every supported or partial API member exists") fails if a listed member is missing from the API
object and if a type in `API_TYPES_MISSING` is actually exported. Entries with the wildcard form `x.*` are not checked.
After an implementation, also grep the base table for members of your namespace (e.g. `window.onDidChangeActiveNotebookEditor`,
`workspace.registerTaskProvider`) and override them in `api`.

## Checks

`pnpm typecheck` and `pnpm test` (runs `test/*.test.ts`; `test/features.test.ts` shows how to register a throwaway
`HostFeature`, drive `host.handleView` / `host.methods.feature` and fake the window via `host.post`). Existing behavior
must not change.
