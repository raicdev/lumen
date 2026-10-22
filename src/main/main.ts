import { app, autoUpdater, BrowserWindow, defineMainRPC, dialog, shell } from "@lumen/shell/main";
import { tsServerPluginsOf } from "./menus-walkthroughs-ts-plugins.ts";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "fs";
import { isAbsolute, join, relative, resolve } from "path";
import { homedir } from "os";
import type { LumenRPC } from "../shared/types.ts";
import {
  readDirTree,
  readTextFile,
  writeTextFile,
  createFile,
  createDirectory,
  deletePath,
  renamePath,
} from "./fs.ts";
import { gitCommit, gitDiscard, gitShowHead, gitStage, gitStatus, gitUnstage } from "./git.ts";
import { watchWorkspace } from "./watcher.ts";
import { detectLanguage, jsonSchemaAssociations, setContributedLanguages } from "./language.ts";
import { fsWorker, lspWorker } from "./workers.ts";
import { WorkspaceStateStore } from "./workspace-state.ts";
import { contributedThemes, loadColorTheme } from "./themes.ts";
import { terminalProfiles, terminals } from "./terminal.ts";
import { killProcess, listProcesses } from "./process-explorer.ts";
import { forwardToRunningInstance, instanceSocketPath, serveInstance } from "./single-instance.ts";
import { UpdateService } from "./updates.ts";
import { CompatCache, ExtensionManager, analyzeVsix, compareVersions } from "./extensions/manager.ts";
import { ExtensionHostClient, openExternal } from "./extensions/host-client.ts";
import { downloadFromMarketplace, latestVersion, marketplaceDetails, searchMarketplace } from "./extensions/marketplace.ts";
import { WebviewResourceServer } from "./extensions/webview-server.ts";
import type { ExtensionGrammar, ExtensionInstallResult } from "../shared/types.ts";
import type { ExtensionDescription } from "../shared/extensions.ts";
import type { MarketplaceExtension } from "../shared/extensions.ts";

const APP_VERSION = "0.2.0";
const APP_NAME = "Lumen";
const APP_IDENTIFIER = "dev.lumen.editor";

let mainWindow: BrowserWindow<LumenRPC> | null = null;
let workspaceRoot: string | null = null;
let hasDirtyDocs = false;

/** Point the language service, the file watcher and the extension host at a (new) workspace. */
function setWorkspace(path: string | null) {
  if (path === workspaceRoot && path !== null) return;
  workspaceRoot = path;
  lspWorker.configure("setWorkspaceRoot", path);
  extensionHost.postFromView({ type: "workspace", root: path });
  watchWorkspace(path, (paths, git) => {
    mainWindow?.webContents.send.workspaceChanged({ paths, git });
    extensionHost.filesChanged(paths);
  });
}

/* ── extensions ───────────────────────────────────────────────────────── */

const extensionManager = new ExtensionManager();
/** Compatibility of Open VSX packages checked before install. */
const compatCache = new CompatCache();

/** lumen:// URIs this process was started with (the OS protocol handler passes them as arguments), until the extension host runs. */
const launchUris = process.argv.filter((arg) => arg.startsWith("lumen://"));
let extensionHostStarted = false;

/** lumen://<extension id>/... URIs go to the extension's URI handler. */
function handleLaunchUris(uris: string[]): void {
  if (!extensionHostStarted) {
    launchUris.push(...uris);
    return;
  }
  for (const uri of uris) extensionHost.postFromView({ type: "executeCommand", command: "lumen.handleUri", args: [uri] });
}

const extensionHost = new ExtensionHostClient({
  appName: APP_NAME,
  appVersion: APP_VERSION,
  manager: extensionManager,
  toView: (message) => mainWindow?.webContents.send.extHost({ message }),
  webviews: new WebviewResourceServer(),
  dialogs: {
    showOpenDialog: (options) =>
      dialog.showOpenDialog({
        title: options.title,
        defaultPath: options.defaultPath ?? workspaceRoot ?? homedir(),
        properties: [options.folders ? "openDirectory" : "openFile", ...(options.many ? (["multiSelections"] as const) : [])],
      }),
    showSaveDialog: (options) => dialog.showSaveDialog({ title: options.title, defaultPath: options.defaultPath ?? workspaceRoot ?? homedir() }),
  },
});

/** File associations (contributes.languages) and JSON schemas (contributes.jsonValidation) of the enabled extensions. */
function refreshContributedLanguages() {
  const enabled = extensionManager.enabled();
  setContributedLanguages(enabled.flatMap((extension) => extension.manifest.contributes?.languages ?? []));
  lspWorker.configure("setJsonSchemas", enabled.flatMap(jsonSchemaAssociations));
  lspWorker.configure("setTsPlugins", tsServerPluginsOf(enabled));
}
refreshContributedLanguages();

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

/** Install, then restart the extension host so the new code is loaded. */
async function installExtension(run: () => Promise<ExtensionInstallResult["extension"]>): Promise<ExtensionInstallResult> {
  try {
    const extension = await run();
    refreshContributedLanguages();
    if (extensionHost.running) await extensionHost.restart();
    return { extension };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Per-project layout (editors, panels, terminals) — see workspace-state.ts. */
const workspaceState = new WorkspaceStateStore(APP_NAME);

/* ── updates ──────────────────────────────────────────────────────────── */

autoUpdater.configure({ repository: "raicdev/lumen", name: APP_NAME, version: APP_VERSION, identifier: APP_IDENTIFIER });

const updates = new UpdateService({
  publish: (state) => mainWindow?.webContents.send.updateState({ state }),
  quit: async () => (mainWindow ? await mainWindow.requestClose() : true),
});

const rpc = defineMainRPC<LumenRPC>({
  handlers: {
    requests: {
      openFolder: async () => {
        const chosen = await dialog.showOpenDialog({
          title: "Open Folder",
          defaultPath: workspaceRoot ?? join(homedir(), "Desktop"),
          properties: ["openDirectory"],
        });
        const path = chosen[0] ?? null;
        if (path) setWorkspace(path);
        return { path };
      },

      openFileDialog: async () => {
        const chosen = await dialog.showOpenDialog({
          title: "Open File",
          defaultPath: workspaceRoot ?? join(homedir(), "Desktop"),
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

      readFile: async ({ path }) => await readTextFile(path),

      writeFile: async ({ path, content }) => {
        const result = await writeTextFile(path, content);
        if (result.success) lspWorker.notifyIfRunning("change", path, content);
        return result;
      },

      createFile: async ({ path, content }) => await createFile(path, content ?? ""),

      createDir: ({ path }) => createDirectory(path),

      deletePath: ({ path }) => {
        lspWorker.notifyIfRunning("close", path);
        return deletePath(path);
      },

      renamePath: ({ oldPath, newPath }) => {
        lspWorker.notifyIfRunning("close", oldPath);
        return renamePath(oldPath, newPath);
      },

      listWorkspaceFiles: async ({ root }) => ({
        files: await fsWorker.call("listWorkspaceFiles", root),
      }),

      searchInFiles: async ({ root, query, ...options }) => await fsWorker.call("searchInFiles", root, query, options),

      replaceInFiles: async ({ root, query, replacement, ...options }) =>
        await fsWorker.call("replaceInFiles", root, query, replacement, options),

      searchFilesByName: async ({ root, query, maxResults }) => ({
        files: await fsWorker.call("searchFilesByName", root, query, maxResults ?? 100),
      }),

      detectLanguage: ({ path }) => ({
        language: detectLanguage(path),
      }),

      lspOpen: ({ path, content, language }) => {
        lspWorker.notify("open", path, content, language);
        return { ok: true };
      },

      lspChange: ({ path, content }) => {
        lspWorker.notifyIfRunning("change", path, content);
        return { ok: true };
      },

      lspClose: ({ path }) => {
        lspWorker.notifyIfRunning("close", path);
        return { ok: true };
      },

      lspCompletions: async ({ path, line, character }) => ({
        items: await lspWorker.call("getCompletions", path, line, character),
      }),

      lspHover: async ({ path, line, character }) => ({
        hover: await lspWorker.call("getHover", path, line, character),
      }),

      lspDefinition: async ({ path, line, character }) => ({
        location: await lspWorker.call("getDefinition", path, line, character),
      }),

      lspDiagnostics: async ({ path }) => ({
        diagnostics: await lspWorker.call("getDiagnostics", path),
      }),

      lspReferences: async ({ path, line, character }) => ({
        locations: await lspWorker.call("getReferences", path, line, character),
      }),

      lspRename: async ({ path, line, character, newName }) =>
        await lspWorker.call("getRenameEdits", path, line, character, newName),

      lspFormat: async ({ path, tabSize, insertSpaces }) => ({
        edits: await lspWorker.call("getFormatEdits", path, tabSize, insertSpaces),
      }),

      lspSymbols: async ({ path }) => ({ symbols: await lspWorker.call("getSymbols", path) }),

      workspaceStateGet: ({ root }) => ({ state: workspaceState.get(root) }),

      workspaceStateSet: ({ root, state }) => {
        workspaceState.set(root, state);
        return { ok: true };
      },

      setWorkspace: ({ path }) => {
        setWorkspace(path);
        return { ok: true };
      },

      setWindowTitle: ({ title }) => {
        mainWindow?.setTitle(title);
        return { ok: true };
      },

      showSaveDialog: async ({ defaultPath }) => ({
        path: await dialog.showSaveDialog({
          title: "Save As",
          defaultPath: defaultPath ?? workspaceRoot ?? join(homedir(), "Desktop"),
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
        await mainWindow?.requestClose();
        return { ok: true };
      },

      windowMinimize: () => {
        mainWindow?.minimize();
        return { ok: true };
      },

      windowMaximize: () => {
        mainWindow?.toggleMaximize();
        return { ok: true };
      },

      windowIsMaximized: () => ({
        maximized: mainWindow?.isMaximized() ?? false,
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
            { label: "Extension host", heapUsed: () => extensionHost.heapUsed() },
            { label: "Language service", heapUsed: () => lspWorker.heapUsed() },
            { label: "File search", heapUsed: () => fsWorker.heapUsed() },
          ],
          terminals: terminals.processes(),
          extensions: extensionManager.list().map((extension) => ({ id: extension.id, name: extensionDisplayName(extension) })),
          extensionProcesses: (alive) => extensionHost.childProcessOwners(alive),
          webviewFrames: async () => (mainWindow ? await mainWindow.native.processFrames() : null),
        }),
      }),

      processKill: ({ pid }) => killProcess(pid),

      confirmClose: ({ allow }) => {
        if (allow) void mainWindow?.requestClose();
        return { ok: true };
      },

      setDirtyState: ({ dirty }) => {
        hasDirtyDocs = dirty;
        return { ok: true };
      },

      quitApp: async () => {
        await app.quit();
        return { ok: true };
      },

      terminalCreate: async ({ cwd, cols, rows, profile }) => {
        const dir = cwd || workspaceRoot || process.cwd();
        return await terminals.create(dir, { cols, rows }, profile);
      },

      terminalProfiles: () => ({
        profiles: terminalProfiles().map(({ id, name }) => ({ id, name })),
      }),

      terminalWrite: ({ id, data }) => terminals.write(id, data),

      terminalResize: ({ id, cols, rows }) => terminals.resize(id, cols, rows),

      terminalKill: ({ id }) => terminals.kill(id),

      terminalReset: () => ({ killed: terminals.killAll() }),

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
          path ?? (await dialog.showOpenDialog({ title: "Install Extension from Location", defaultPath: workspaceRoot ?? homedir(), properties: ["openDirectory"] }))[0];
        if (!folder) return { cancelled: true };
        return await installExtension(async () => extensionManager.installFolder(folder, { copy }));
      },

      extensionsInstallMarketplace: async ({ namespace, name, version }) =>
        await installExtension(async () => {
          const { vsix } = await downloadFromMarketplace(namespace, name, version);
          return extensionManager.installVsix(vsix, { type: "openvsx", namespace, name });
        }),

      extensionsUninstall: async ({ id }) => {
        // Stop the extension's code first, so its files are not in use.
        if (extensionHost.running) await extensionHost.stop();
        const ok = extensionManager.uninstall(id);
        refreshContributedLanguages();
        await extensionHost.restart();
        return { ok };
      },

      extensionsSetEnabled: async ({ id, enabled }) => {
        const ok = extensionManager.setEnabled(id, enabled);
        refreshContributedLanguages();
        if (ok) await extensionHost.restart();
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
            return { namespace, name, version: latest, displayName: manifest.displayName, description: manifest.description, publisher: manifest.publisher, iconUrl: extension.iconUrl };
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
        const count = await extensionHost.start(config, workspace ?? workspaceRoot);
        // lumen://<extension id>/... URIs given on the command line (or by later launches) go to the extension's URI handler (once).
        extensionHostStarted = true;
        handleLaunchUris(launchUris.splice(0));
        return { count };
      },

      extensionsRestart: async () => ({ count: await extensionHost.restart() }),

      extHostCall: async ({ method, args }) => {
        try {
          return { result: await extensionHost.call(method, args as never) };
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      },

      openExternal: ({ url }) => ({ ok: openExternal(url) }),

      updateConfigure: ({ mode }) => {
        updates.configure(mode);
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
      extHostPost: ({ message }) => extensionHost.postFromView(message),
    },
  },
});

app.configure({
  name: APP_NAME,
  version: APP_VERSION,
  identifier: APP_IDENTIFIER,
});

app.on("ready", () => {
  mainWindow = new BrowserWindow<LumenRPC>({
    title: APP_NAME,
    width: 1280,
    height: 800,
    x: 80,
    y: 60,
    url: app.assetUrl("index.html"),
    rpc,
    // The view draws its own title bar + menu bar (see TitleBar.tsx).
    frame: false,
    // Matches --bg in index.css so the window never flashes white on open.
    backgroundColor: "#111113",
    // Unsaved-changes protection: the shell asks before the window goes away.
    closeGuard: async () => {
      if (!hasDirtyDocs) return true;
      try {
        const result = await mainWindow?.webContents.request.requestCloseCheck({});
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

  const window = mainWindow;

  window.on("closed", () => {
    void extensionHost.stop();
    workspaceState.flush();
    terminals.killAll();
    mainWindow = null;
  });

  // Stream shell I/O into the webview
  terminals.setHandlers(
    (id, data) => {
      mainWindow?.webContents.send.terminalData({ id, data });
    },
    (id, code) => {
      mainWindow?.webContents.send.terminalExit({ id, code });
    },
  );
});

app.on("before-quit", () => {
  void extensionHost.stop();
  workspaceState.flush();
  terminals.killAll();
});

// Last chance for queued layout writes (e.g. the process is asked to exit).
process.on("exit", () => workspaceState.flush());

/**
 * A launch for lumen:// URIs (the OS protocol handler) hands them to a running Lumen and
 * exits; otherwise this instance starts and receives the URIs of such launches.
 */
async function start(): Promise<void> {
  const socket = instanceSocketPath(APP_IDENTIFIER);
  if (launchUris.length && (await forwardToRunningInstance(socket, launchUris))) {
    process.exit(0);
  }
  // A socket file nobody listens on is left over from a crash.
  if (process.platform !== "win32" && existsSync(socket) && !(await forwardToRunningInstance(socket, []))) rmSync(socket, { force: true });
  void serveInstance(socket, (uris) => {
    handleLaunchUris(uris);
    mainWindow?.focus();
  });
  void app.run();
}

void start();
