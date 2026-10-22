import { app, autoUpdater, BrowserWindow, defineMainRPC, dialog, shell } from "@lumen/shell/main";
import { tsServerPluginsOf } from "./menus-walkthroughs-ts-plugins.ts";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "fs";
import { basename, isAbsolute, join, relative, resolve } from "path";
import { randomUUID } from "crypto";
import { homedir } from "os";
import type { LumenRPC, WindowInit } from "../shared/types.ts";
import { readDirTree, readTextFile, writeTextFile, createFile, createDirectory, deletePath, renamePath } from "./fs.ts";
import { gitCommit, gitDiscard, gitShowHead, gitStage, gitStatus, gitUnstage } from "./git.ts";
import { WorkspaceWatcher } from "./watcher.ts";
import { detectLanguage, jsonSchemaAssociations, setContributedLanguages } from "./language.ts";
import { createLspWorker, fsWorker, type LspWorker } from "./workers.ts";
import { WorkspaceStateStore } from "./workspace-state.ts";
import { contributedThemes, loadColorTheme } from "./themes.ts";
import { TerminalManager, terminalProfiles } from "./terminal.ts";
import { killProcess, listProcesses } from "./process-explorer.ts";
import { forwardToRunningInstance, instanceSocketPath, serveInstance } from "./single-instance.ts";
import { UpdateService } from "./updates.ts";
import { CompatCache, ExtensionManager, analyzeVsix, compareVersions, userDataDir } from "./extensions/manager.ts";
import { ExtensionHostClient, openExternal } from "./extensions/host-client.ts";
import { downloadFromMarketplace, latestVersion, marketplaceDetails, searchMarketplace } from "./extensions/marketplace.ts";
import { WebviewResourceServer } from "./extensions/webview-server.ts";
import type { ExtensionGrammar, ExtensionInstallResult } from "../shared/types.ts";
import type { ExtensionDescription } from "../shared/extensions.ts";
import type { MarketplaceExtension } from "../shared/extensions.ts";
import { showFatalError } from "./crash-log.ts";
import { BackupStore } from "./backups.ts";
import { WindowSessionStore, type WindowEntry } from "./window-sessions.ts";

const APP_VERSION = "0.2.2-beta.5";
const APP_NAME = "Lumen";
const APP_IDENTIFIER = "dev.lumen.editor";

/* ── extensions ───────────────────────────────────────────────────────── */

const extensionManager = new ExtensionManager();
/** Compatibility of Open VSX packages checked before install. */
const compatCache = new CompatCache();

/** lumen:// URIs this process was started with (the OS protocol handler passes them as arguments); the first window takes them. */
const launchUris = process.argv.filter((arg) => arg.startsWith("lumen://"));

/** Webview pages of every window's extensions (one origin per extension, so their storage is shared). */
const webviewServer = new WebviewResourceServer();

/** File associations (contributes.languages) and JSON schemas (contributes.jsonValidation) of the enabled extensions. */
function refreshContributedLanguages() {
  const enabled = extensionManager.enabled();
  setContributedLanguages(enabled.flatMap((extension) => extension.manifest.contributes?.languages ?? []));
  for (const appWindow of windows.values()) configureLanguageService(appWindow.lsp);
}

/** Give a window's language service the enabled extensions' JSON schemas and TypeScript plugins. */
function configureLanguageService(lsp: LspWorker) {
  const enabled = extensionManager.enabled();
  lsp.configure("setJsonSchemas", enabled.flatMap(jsonSchemaAssociations));
  lsp.configure("setTsPlugins", tsServerPluginsOf(enabled));
}

type RawGrammarContribution = {
  language?: unknown;
  scopeName?: unknown;
  path?: unknown;
  embeddedLanguages?: unknown;
  injectTo?: unknown;
  tokenTypes?: unknown;
};

/** A string-valued map from a manifest (`embeddedLanguages`, `tokenTypes`). */
function stringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** Whether `file` is inside `folder` (both resolved against the working directory). */
function insideFolder(folder: string, file: string): boolean {
  const relativePath = relative(resolve(folder), resolve(file));
  return !!relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

/** Grammars of the enabled extensions, with package-relative paths made absolute. */
function contributedGrammars(): ExtensionGrammar[] {
  const grammars: ExtensionGrammar[] = [];
  for (const extension of extensionManager.enabled()) {
    const contributions = extension.manifest.contributes?.grammars;
    if (!Array.isArray(contributions)) continue;
    for (const raw of contributions as RawGrammarContribution[]) {
      if (!raw || typeof raw !== "object") continue;
      const { language, scopeName, path } = raw;
      if (typeof language !== "string" || typeof scopeName !== "string" || typeof path !== "string") continue;
      const grammarPath = resolve(extension.location, path);
      if (!insideFolder(extension.location, grammarPath)) continue;
      grammars.push({
        extensionId: extension.id,
        language,
        scopeName,
        path: grammarPath,
        embeddedLanguages: stringMap(raw.embeddedLanguages),
        injectTo: Array.isArray(raw.injectTo) ? raw.injectTo.filter((scope): scope is string => typeof scope === "string") : undefined,
        tokenTypes: stringMap(raw.tokenTypes),
      });
    }
  }
  return grammars;
}

/** An extension's name for people: its displayName unless that is an unresolved %nls.key%. */
function extensionDisplayName(extension: ExtensionDescription): string {
  const displayName = extension.manifest.displayName;
  return typeof displayName === "string" && displayName && !/^%.+%$/.test(displayName) ? displayName : extension.id;
}

/** Install, then restart the extension hosts so the new code is loaded. */
async function installExtension(run: () => Promise<ExtensionInstallResult["extension"]>): Promise<ExtensionInstallResult> {
  try {
    const extension = await run();
    refreshContributedLanguages();
    await restartExtensionHosts();
    return { extension };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Every window runs the enabled extensions again (after installs, uninstalls, enable / disable). */
async function restartExtensionHosts(): Promise<void> {
  await Promise.all([...windows.values()].filter((appWindow) => appWindow.extensionHostStarted).map((appWindow) => appWindow.extensionHost.restart()));
}

/** Per-project layout (editors, panels, terminals) — see workspace-state.ts. */
const workspaceState = new WorkspaceStateStore(APP_NAME);
const backups = new BackupStore(userDataDir(APP_NAME));
const windowSessions = new WindowSessionStore(userDataDir(APP_NAME), app.packaged ? "windows.json" : "windows.dev.json");

/* ── updates ──────────────────────────────────────────────────────────── */

autoUpdater.configure({ repository: "raicdev/lumen", name: APP_NAME, version: APP_VERSION, identifier: APP_IDENTIFIER });

const updates = new UpdateService({
  publish: (state) => {
    for (const appWindow of windows.values()) appWindow.window.webContents.send.updateState({ state });
  },
  quit: async () => await quit(),
});

/* ── windows ──────────────────────────────────────────────────────────── */

/** Open windows, oldest first. */
const windows = new Map<string, AppWindow>();
/** The window used last (launch URIs go there). */
let lastFocused: AppWindow | null = null;
/** Set while quit() closes the windows: they stay in the saved session. */
let quitting = false;

const sameFolder = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

/** The window that shows `folder`, if any. */
function windowOf(folder: string): AppWindow | undefined {
  return [...windows.values()].find((appWindow) => appWindow.sessionWorkspace !== null && sameFolder(appWindow.sessionWorkspace, folder));
}

/** Remember the open windows (and their folders) for the next launch. */
function saveWindowSession() {
  windowSessions.save([...windows.values()].map((appWindow): WindowEntry => ({ id: appWindow.id, workspace: appWindow.sessionWorkspace })));
}

/**
 * One window: its page, and what belongs to its folder — the language service,
 * the file watcher, the terminals and the extension host (extensions see one
 * workspace, as in VS Code). Settings, installed extensions and updates are
 * the app's.
 */
class AppWindow {
  readonly id: string;
  readonly init: WindowInit;
  /** Owns hot-exit backups written before windows had ids (the first launch after updating). */
  readonly legacyBackups: boolean;
  readonly lsp = createLspWorker();
  readonly watcher = new WorkspaceWatcher();
  readonly terminals = new TerminalManager();
  readonly extensionHost: ExtensionHostClient;
  readonly window: BrowserWindow<LumenRPC>;
  root: string | null = null;
  dirty = false;
  extensionHostStarted = false;
  /** lumen:// URIs for the extension host, until it runs. */
  launchUris: string[] = [];
  #workspaceSet = false;

  /** The folder to reopen next time: the one it shows, or (while the view is still starting) the one it opens. */
  get sessionWorkspace(): string | null {
    return this.#workspaceSet ? this.root : this.init.workspace;
  }

  constructor(options: { id?: string; workspace: string | null; restoreLastWorkspace?: boolean; position: number }) {
    this.id = options.id ?? randomUUID();
    this.init = { id: this.id, workspace: options.workspace, restoreLastWorkspace: !!options.restoreLastWorkspace };
    this.legacyBackups = !!options.restoreLastWorkspace;
    configureLanguageService(this.lsp);
    this.extensionHost = new ExtensionHostClient({
      appName: APP_NAME,
      appVersion: APP_VERSION,
      manager: extensionManager,
      toView: (message) => this.window.webContents.send.extHost({ message }),
      webviews: webviewServer,
      onStateChanged: (file, key) => {
        for (const other of windows.values()) if (other !== this) other.extensionHost.stateChanged(file, key);
      },
      dialogs: {
        showOpenDialog: (dialogOptions) =>
          dialog.showOpenDialog({
            title: dialogOptions.title,
            defaultPath: dialogOptions.defaultPath ?? this.root ?? homedir(),
            properties: [dialogOptions.folders ? "openDirectory" : "openFile", ...(dialogOptions.many ? (["multiSelections"] as const) : [])],
          }),
        showSaveDialog: (dialogOptions) =>
          dialog.showSaveDialog({ title: dialogOptions.title, defaultPath: dialogOptions.defaultPath ?? this.root ?? homedir() }),
      },
    });
    // Stream shell I/O into the webview
    this.terminals.setHandlers(
      (id, data) => this.window.webContents.send.terminalData({ id, data }),
      (id, code) => this.window.webContents.send.terminalExit({ id, code }),
    );
    windows.set(this.id, this);
    lastFocused = this;
    // New windows step down and right from the first one.
    const offset = (options.position % 8) * 30;
    this.window = new BrowserWindow<LumenRPC>({
      title: APP_NAME,
      width: 1280,
      height: 800,
      x: 80 + offset,
      y: 60 + offset,
      url: app.assetUrl("index.html"),
      rpc: windowRpc(this),
      // The view draws its own title bar + menu bar (see TitleBar.tsx).
      frame: false,
      // Matches --bg in styles/core/tokens.css so the window never flashes white on open.
      backgroundColor: "#111113",
      // Unsaved-changes protection: the shell asks before the window goes away.
      closeGuard: async () => {
        if (!this.dirty) return true;
        try {
          const result = await this.window.webContents.request.requestCloseCheck({});
          return result?.allow ?? true;
        } catch {
          const { response } = await dialog.showMessageBox({
            type: "warning",
            title: "Unsaved changes",
            message: "You have unsaved changes.",
            detail: "Close anyway and discard changes?",
            buttons: ["Close", "Cancel"],
            defaultId: 1,
            cancelId: 1,
          });
          return response === 0;
        }
      },
    });
    this.window.on("closed", () => this.#closed());
  }

  /** Point the language service, the file watcher and the extension host at a (new) workspace. */
  setWorkspace(path: string | null) {
    if (path === this.root && path !== null) return;
    this.root = path;
    this.#workspaceSet = true;
    this.lsp.configure("setWorkspaceRoot", path);
    this.extensionHost.postFromView({ type: "workspace", root: path });
    this.watcher.watch(path, ({ paths, git, typePaths, typesOverflow }) => {
      if (paths.length || git) {
        this.window.webContents.send.workspaceChanged({ paths, git });
        this.extensionHost.filesChanged(paths);
      }
      // The language service also hears of type files in node_modules / build output.
      if (typesOverflow) this.lsp.notifyIfRunning("projectChanged");
      else if (paths.length || typePaths.length) this.lsp.notifyIfRunning("filesChanged", [...paths, ...typePaths]);
    });
    saveWindowSession();
  }

  /** lumen://<extension id>/... URIs go to the extension's URI handler. */
  handleLaunchUris(uris: string[]): void {
    if (!this.extensionHostStarted) {
      this.launchUris.push(...uris);
      return;
    }
    for (const uri of uris) this.extensionHost.postFromView({ type: "executeCommand", command: "lumen.handleUri", args: [uri] });
  }

  /** `name`, or "name (folder)" when there are several windows (Process Explorer). */
  label(name: string): string {
    if (windows.size < 2) return name;
    return `${name} (${this.root ? basename(this.root) || this.root : "Empty Window"})`;
  }

  #closed() {
    windows.delete(this.id);
    if (lastFocused === this) lastFocused = [...windows.values()].at(-1) ?? null;
    void stopExtensionHost(this);
    workspaceState.flush();
    this.terminals.killAll();
    this.watcher.dispose();
    this.lsp.dispose();
    // A window closed while others stay open is not reopened; the last one (or all, on quit) is.
    if (!quitting && windows.size) saveWindowSession();
  }
}

/** Open a window (empty, or for a folder). */
function openWindow(options: { id?: string; workspace: string | null; restoreLastWorkspace?: boolean }): AppWindow {
  const appWindow = new AppWindow({ ...options, position: windows.size });
  saveWindowSession();
  return appWindow;
}

/** Close every window (each asks about its unsaved changes); false when one of them stayed open. */
async function quit(): Promise<boolean> {
  quitting = true;
  try {
    await app.quit();
  } finally {
    quitting = false;
  }
  const done = app.windows.length === 0;
  // Cancelled: the windows that did close are not reopened next time.
  if (!done) saveWindowSession();
  return done;
}

/** The handlers of one window's page: requests act on that window and its folder. */
function windowRpc(w: AppWindow) {
  return defineMainRPC<LumenRPC>({
    handlers: {
      requests: {
        openFolder: async () => {
          const chosen = await dialog.showOpenDialog({
            title: "Open Folder",
            defaultPath: w.root ?? join(homedir(), "Desktop"),
            properties: ["openDirectory"],
          });
          // The view opens it (or brings the window that shows it to the front).
          return { path: chosen[0] ?? null };
        },

        openFileDialog: async () => {
          const chosen = await dialog.showOpenDialog({
            title: "Open File",
            defaultPath: w.root ?? join(homedir(), "Desktop"),
            properties: ["openFile", "multiSelections"],
          });
          return { paths: chosen };
        },

        readDir: ({ path, depth }) => {
          try {
            return { entries: readDirTree(path, depth ?? 3) };
          } catch (e) {
            return {
              entries: [],
              error: e instanceof Error ? e.message : "Failed to read directory",
            };
          }
        },

        readFile: async ({ path, encoding }) => await readTextFile(path, encoding),

        writeFile: async ({ path, content, encoding, expectedVersion }) => {
          const result = await writeTextFile(path, content, { encoding, expectedVersion });
          if (result.success) w.lsp.notifyIfRunning("change", path, content);
          return result;
        },

        createFile: async ({ path, content }) => await createFile(path, content ?? ""),

        createDir: ({ path }) => createDirectory(path),

        deletePath: ({ path }) => {
          w.lsp.notifyIfRunning("close", path);
          return deletePath(path);
        },

        renamePath: ({ oldPath, newPath }) => {
          w.lsp.notifyIfRunning("close", oldPath);
          return renamePath(oldPath, newPath);
        },

        listWorkspaceFiles: async ({ root }) => ({
          files: await fsWorker.call("listWorkspaceFiles", root),
        }),

        searchInFiles: async ({ root, query, ...options }) => await fsWorker.call("searchInFiles", root, query, options),

        replaceInFiles: async ({ root, query, replacement, ...options }) => await fsWorker.call("replaceInFiles", root, query, replacement, options),

        searchFilesByName: async ({ root, query, maxResults }) => ({
          files: await fsWorker.call("searchFilesByName", root, query, maxResults ?? 100),
        }),

        detectLanguage: ({ path }) => ({
          language: detectLanguage(path),
        }),

        lspOpen: ({ path, content, language }) => {
          w.lsp.notify("open", path, content, language);
          return { ok: true };
        },

        lspChange: ({ path, content }) => {
          w.lsp.notifyIfRunning("change", path, content);
          return { ok: true };
        },

        lspClose: ({ path }) => {
          w.lsp.notifyIfRunning("close", path);
          return { ok: true };
        },

        lspCompletions: async ({ path, line, character }) => ({
          items: await w.lsp.call("getCompletions", path, line, character),
        }),

        lspHover: async ({ path, line, character }) => ({
          hover: await w.lsp.call("getHover", path, line, character),
        }),

        lspDefinition: async ({ path, line, character }) => ({
          location: await w.lsp.call("getDefinition", path, line, character),
        }),

        lspDiagnostics: async ({ path }) => ({
          diagnostics: await w.lsp.call("getDiagnostics", path),
        }),

        lspReferences: async ({ path, line, character }) => ({
          locations: await w.lsp.call("getReferences", path, line, character),
        }),

        lspRename: async ({ path, line, character, newName }) => await w.lsp.call("getRenameEdits", path, line, character, newName),

        lspFormat: async ({ path, tabSize, insertSpaces }) => ({
          edits: await w.lsp.call("getFormatEdits", path, tabSize, insertSpaces),
        }),

        lspSymbols: async ({ path }) => ({ symbols: await w.lsp.call("getSymbols", path) }),

        workspaceStateGet: ({ root }) => ({ state: workspaceState.get(root) }),

        workspaceStateSet: ({ root, state }) => {
          workspaceState.set(root, state);
          return { ok: true };
        },

        setWorkspace: ({ path }) => {
          w.setWorkspace(path);
          return { ok: true };
        },

        setWindowTitle: ({ title }) => {
          w.window.setTitle(title);
          return { ok: true };
        },

        windowInit: () => w.init,

        newWindow: ({ path }) => {
          const shown = path ? windowOf(path) : undefined;
          if (shown) shown.window.focus();
          else openWindow({ workspace: path ?? null });
          return { ok: true };
        },

        focusWorkspaceWindow: ({ path }) => {
          const shown = windowOf(path);
          if (!shown || shown === w) return { focused: false };
          shown.window.focus();
          return { focused: true };
        },

        showSaveDialog: async ({ defaultPath }) => ({
          path: await dialog.showSaveDialog({
            title: "Save As",
            defaultPath: defaultPath ?? w.root ?? join(homedir(), "Desktop"),
          }),
        }),

        gitStatus: async ({ root }) => await gitStatus(root),
        gitStage: async ({ root, paths }) => await gitStage(root, paths),
        gitUnstage: async ({ root, paths }) => await gitUnstage(root, paths),
        gitDiscard: async ({ root, files }) => await gitDiscard(root, files),
        gitCommit: async ({ root, message, stageAll }) => await gitCommit(root, message, stageAll),
        gitShowHead: async ({ root, path }) => ({ content: await gitShowHead(root, path) }),

        // The close guard (unsaved changes) lives in the shell; this request is
        // used by in-app UI that wants to close the window.
        windowClose: async () => {
          await w.window.requestClose();
          return { ok: true };
        },

        windowMinimize: () => {
          w.window.minimize();
          return { ok: true };
        },

        windowMaximize: () => {
          w.window.toggleMaximize();
          return { ok: true };
        },

        windowIsMaximized: () => ({
          maximized: w.window.isMaximized(),
        }),

        showInFolder: ({ path }) => {
          shell.showItemInFolder(path);
          return { ok: true };
        },

        getAppInfo: () => ({
          name: APP_NAME,
          version: APP_VERSION,
          platform: process.platform,
        }),

        processList: async () => ({
          rows: await listProcesses({
            threads: [
              ...[...windows.values()].flatMap((appWindow) => [
                { label: appWindow.label("Extension host"), heapUsed: () => appWindow.extensionHost.heapUsed() },
                { label: appWindow.label("Language service"), heapUsed: () => appWindow.lsp.heapUsed() },
              ]),
              { label: "File search", heapUsed: () => fsWorker.heapUsed() },
            ],
            terminals: [...windows.values()].flatMap((appWindow) => appWindow.terminals.processes()),
            extensions: extensionManager.list().map((extension) => ({ id: extension.id, name: extensionDisplayName(extension) })),
            extensionProcesses: (alive) => new Map([...windows.values()].flatMap((appWindow) => [...appWindow.extensionHost.childProcessOwners(alive)])),
            // WebView2 lists the processes of every window's page.
            webviewFrames: async () => await w.window.native.processFrames(),
          }),
        }),

        processKill: ({ pid }) => killProcess(pid),

        confirmClose: ({ allow }) => {
          if (allow) void w.window.requestClose();
          return { ok: true };
        },

        setDirtyState: ({ dirty }) => {
          w.dirty = dirty;
          return { ok: true };
        },

        quitApp: async () => {
          await quit();
          return { ok: true };
        },

        terminalCreate: async ({ cwd, cols, rows, profile }) => {
          const dir = cwd || w.root || process.cwd();
          return await w.terminals.create(dir, { cols, rows }, profile);
        },

        terminalProfiles: () => ({
          profiles: terminalProfiles().map(({ id, name }) => ({ id, name })),
        }),

        terminalWrite: ({ id, data }) => w.terminals.write(id, data),

        terminalResize: ({ id, cols, rows }) => w.terminals.resize(id, cols, rows),

        terminalKill: ({ id }) => w.terminals.kill(id),

        terminalReset: () => ({ killed: w.terminals.killAll() }),

        extensionsList: () => ({ extensions: extensionManager.list({ icons: true }), dir: extensionManager.dir }),

        extensionGrammars: () => ({ grammars: contributedGrammars() }),

        extensionThemes: () => ({ themes: contributedThemes(extensionManager.enabled()) }),

        extensionColorTheme: async ({ id }) => {
          const enabled = extensionManager.enabled();
          const theme = contributedThemes(enabled).find((candidate) => candidate.id === id || candidate.label === id);
          if (!theme) return { theme: null, error: `no color theme '${id}'` };
          try {
            const extension = enabled.find((candidate) => candidate.id === theme.extensionId)!;
            return { theme: await loadColorTheme(theme, extension.location) };
          } catch (error) {
            return { theme: null, error: error instanceof Error ? error.message : String(error) };
          }
        },

        extensionGrammarFile: ({ path }) => {
          try {
            const target = resolve(path);
            if (!extensionManager.list().some((extension) => insideFolder(extension.location, target))) {
              return { content: null, error: "the file is not inside an installed extension" };
            }
            if (statSync(target).size > 32 * 1024 * 1024) return { content: null, error: "the grammar file is too large" };
            return { content: readFileSync(target, "utf8") };
          } catch (error) {
            return { content: null, error: error instanceof Error ? error.message : String(error) };
          }
        },

        extensionsInstallVsix: async ({ path }) => {
          const file =
            path ??
            (
              await dialog.showOpenDialog({
                title: "Install from VSIX",
                defaultPath: join(homedir(), "Downloads"),
                properties: ["openFile"],
                filters: [{ name: "VSIX Extension", extensions: ["vsix"] }],
              })
            )[0];
          if (!file) return { cancelled: true };
          return await installExtension(async () => extensionManager.installVsix(readFileSync(file), { type: "vsix", file }));
        },

        extensionsInstallFolder: async ({ path, copy }) => {
          const folder =
            path ??
            (await dialog.showOpenDialog({ title: "Install Extension from Location", defaultPath: w.root ?? homedir(), properties: ["openDirectory"] }))[0];
          if (!folder) return { cancelled: true };
          return await installExtension(async () => extensionManager.installFolder(folder, { copy }));
        },

        extensionsInstallMarketplace: async ({ namespace, name, version }) =>
          await installExtension(async () => {
            const { vsix } = await downloadFromMarketplace(namespace, name, version);
            return extensionManager.installVsix(vsix, { type: "openvsx", namespace, name });
          }),

        extensionsUninstall: async ({ id }) => {
          // Stop the extension's code first (in every window), so its files are not in use.
          await Promise.all([...windows.values()].map((appWindow) => appWindow.extensionHost.stop()));
          const ok = extensionManager.uninstall(id);
          refreshContributedLanguages();
          await restartExtensionHosts();
          return { ok };
        },

        extensionsSetEnabled: async ({ id, enabled }) => {
          const ok = extensionManager.setEnabled(id, enabled);
          refreshContributedLanguages();
          if (ok) await restartExtensionHosts();
          return { ok };
        },

        extensionsSearch: async ({ query, sortBy }) => {
          try {
            return await searchMarketplace(query, { sortBy });
          } catch (error) {
            return { extensions: [], total: 0, error: error instanceof Error ? error.message : String(error) };
          }
        },

        extensionsCheckUpdates: async () => {
          const candidates = extensionManager.list({ icons: true }).filter((extension) => !extension.development && extension.source?.type === "openvsx");
          const updates = await Promise.all(
            candidates.map(async (extension): Promise<MarketplaceExtension | null> => {
              if (extension.source?.type !== "openvsx") return null;
              const { namespace, name } = extension.source;
              const latest = await latestVersion(namespace, name);
              if (!latest || compareVersions(latest, extension.manifest.version) <= 0) return null;
              const manifest = extension.manifest;
              return {
                namespace,
                name,
                version: latest,
                displayName: manifest.displayName,
                description: manifest.description,
                publisher: manifest.publisher,
                iconUrl: extension.iconUrl,
              };
            }),
          );
          return { updates: updates.filter((entry) => entry !== null) };
        },

        extensionsMarketplaceDetails: async ({ namespace, name, version }) => {
          try {
            return await marketplaceDetails(namespace, name, version);
          } catch (error) {
            return { readme: null, error: error instanceof Error ? error.message : String(error) };
          }
        },

        extensionsMarketplaceCompat: async ({ namespace, name, version, mode }) => {
          const key = version ? CompatCache.key(namespace, name, version) : null;
          const cached = key && mode !== "refresh" ? compatCache.get(key) : null;
          if (cached || mode === "cached") return cached ?? {};
          try {
            const { vsix, version: resolved } = await downloadFromMarketplace(namespace, name, version);
            const { result, manifest } = analyzeVsix(vsix);
            compatCache.set(key ?? CompatCache.key(namespace, name, resolved), result, manifest);
            return result;
          } catch (error) {
            return { error: error instanceof Error ? error.message : String(error) };
          }
        },

        extensionsChangelog: ({ id }) => {
          const extension = extensionManager.get(id);
          if (!extension) return { markdown: null };
          const file = readdirSync(extension.location).find((name) => /^change(log|s)(\.md)?$/i.test(name));
          const path = file ? join(extension.location, file) : null;
          return { markdown: path && existsSync(path) ? readFileSync(path, "utf8") : null };
        },

        extensionsReadme: ({ id }) => {
          const extension = extensionManager.get(id);
          if (!extension) return { markdown: null };
          const file = readdirSync(extension.location).find((name) => /^readme(.md)?$/i.test(name));
          const path = file ? join(extension.location, file) : null;
          return { markdown: path && existsSync(path) ? readFileSync(path, "utf8") : null };
        },

        extensionsStart: async ({ config, workspace }) => {
          const count = await w.extensionHost.start(config, workspace ?? w.root);
          // lumen://<extension id>/... URIs given on the command line (or by later launches) go to the extension's URI handler (once).
          w.extensionHostStarted = true;
          w.handleLaunchUris(w.launchUris.splice(0));
          return { count };
        },

        extensionsRestart: async () => ({ count: await w.extensionHost.restart() }),

        extHostCall: async ({ method, args }) => {
          try {
            return { result: await w.extensionHost.call(method, args as never) };
          } catch (error) {
            return { error: error instanceof Error ? error.message : String(error) };
          }
        },

        openExternal: ({ url }) => ({ ok: openExternal(url) }),

        backupWrite: (backup) => {
          try {
            backups.write(w.id, backup);
            return { success: true };
          } catch (error) {
            console.warn("[backups] cannot write a backup:", error);
            return { success: false };
          }
        },
        backupDelete: ({ path }) => {
          try {
            backups.delete(w.id, path, w.legacyBackups);
            return { success: true };
          } catch {
            return { success: false };
          }
        },
        backupList: () => ({ backups: backups.list(w.id, w.legacyBackups) }),

        updateConfigure: ({ mode, channel }) => {
          // A beta build keeps getting betas unless the user chose a channel.
          updates.configure(mode, channel ?? (APP_VERSION.includes("-") ? "beta" : "stable"));
          return { state: updates.state };
        },

        updateCheck: () => {
          void updates.check(true);
          return { state: updates.state };
        },

        updateInstall: async () => await updates.install(),
      },
      messages: {
        log: ({ msg }) => {
          console.log("[view]", msg);
        },
        extHostPost: ({ message }) => w.extensionHost.postFromView(message),
        windowFocused: () => {
          lastFocused = w;
        },
      },
    },
  });
}

app.configure({
  name: APP_NAME,
  version: APP_VERSION,
  identifier: APP_IDENTIFIER,
});

/** Reopen the windows of the last session (or one window on the first launch). */
function restoreWindows() {
  const saved = windowSessions.load();
  // No session yet: the window reopens the folder the previous version showed last.
  if (saved === null) return [openWindow({ workspace: null, restoreLastWorkspace: true })];
  const seen = new Set<string>();
  const entries = saved.filter((entry) => {
    if (entry.workspace === null) return true;
    const key = process.platform === "win32" ? entry.workspace.toLowerCase() : entry.workspace;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!entries.length) return [openWindow({ workspace: null })];
  return entries.map((entry) => openWindow({ id: entry.id, workspace: entry.workspace }));
}

app.on("ready", () => {
  try {
    const opened = restoreWindows();
    // lumen:// URIs from the command line go to the window in front (the last one opened).
    opened.at(-1)?.handleLaunchUris(launchUris.splice(0));
  } catch (error) {
    // webview_create fails without the WebView2 runtime: say so instead of exiting silently.
    showFatalError(
      "Lumen could not open its window.",
      `Lumen needs the Microsoft Edge WebView2 Runtime, which Windows 10 and 11 normally include. Install it from https://developer.microsoft.com/microsoft-edge/webview2/ and start Lumen again.

(${error instanceof Error ? error.message : String(error)})`,
    );
    process.exit(1);
  }
});

app.on("before-quit", () => {
  for (const appWindow of windows.values()) {
    void stopExtensionHost(appWindow);
    appWindow.terminals.killAll();
  }
  workspaceState.flush();
});

/** Extension hosts on their way down (extensions deactivate, their processes end). */
const extensionHostsStopping = new Map<AppWindow, Promise<void>>();
/** Once per window; the process waits for it before it exits. */
function stopExtensionHost(appWindow: AppWindow): Promise<void> {
  let stopping = extensionHostsStopping.get(appWindow);
  if (!stopping) {
    stopping = appWindow.extensionHost.stop();
    extensionHostsStopping.set(appWindow, stopping);
  }
  return stopping;
}
app.onShutdown(async () => await Promise.all([...windows.values(), ...extensionHostsStopping.keys()].map(stopExtensionHost)));

// Last chance for queued layout writes (e.g. the process is asked to exit).
process.on("exit", () => workspaceState.flush());

/**
 * A launch while Lumen runs hands its lumen:// URIs (if any) to the running Lumen and exits;
 * like VS Code, a plain launch opens a new window there, and URIs go to the window used last.
 * Otherwise this instance starts and receives later launches.
 * Development runs (pnpm dev) only forward URIs, so they can run beside an installed Lumen.
 */
async function start(): Promise<void> {
  const socket = instanceSocketPath(APP_IDENTIFIER);
  const forward = launchUris.length > 0 || !process.env.LUMEN_DEV;
  if (forward && (await forwardToRunningInstance(socket, launchUris))) {
    process.exit(0);
  }
  // A socket file nobody listens on is left over from a crash.
  if (process.platform !== "win32" && existsSync(socket) && !(await forwardToRunningInstance(socket, []))) rmSync(socket, { force: true });
  void serveInstance(socket, (uris) => {
    if (!uris.length) {
      openWindow({ workspace: null });
      return;
    }
    const target = lastFocused ?? openWindow({ workspace: null });
    target.handleLaunchUris(uris);
    target.window.focus();
  });
  void app.run();
}

void start();
