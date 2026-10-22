import type {
  ConfigSnapshot,
  ExtensionDescription,
  HostMethods,
  HostToView,
  MarketplaceCompat,
  MarketplaceDetails,
  MarketplaceExtension,
  ViewToHost,
} from "./extensions.ts";
import type { ColorThemeData, ExtensionColorTheme } from "./color-theme.ts";

export type FileEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  /** FilePermission.Readonly from a file system provider's stat (single read-only files). */
  readOnly?: boolean;
  children?: FileEntry[];
};

/** An unsaved editor kept on disk until it is saved or discarded (hot exit). */
export type DocumentBackup = {
  /** The file path, or `untitled:Untitled-1`. */
  path: string;
  content: string;
  language: string;
  eol: "LF" | "CRLF";
  encoding?: string;
  /** When the backup was written (ms since the epoch). */
  time: number;
};

export type OpenFileResult = {
  path: string;
  content: string;
  language: string;
  /** The file's encoding (VS Code ids: `utf8`, `utf8bom`, `shiftjis`, …). */
  encoding?: string;
  /** Changes when the file is written; a save passes it back to detect changes made by other programs. */
  version?: string;
};

export type Diagnostic = {
  path: string;
  message: string;
  severity: "error" | "warning" | "info" | "hint";
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  source?: string;
  code?: string | number;
};

export type CompletionItem = {
  label: string;
  kind: string;
  detail?: string;
  insertText: string;
  documentation?: string;
  /** insertText is a VS Code snippet. */
  snippet?: boolean;
  /** Text to match what was typed against (defaults to the label). */
  filterText?: string;
  /** The text the completion replaces (defaults to the word before the cursor). */
  range?: TextRange;
};

export type HoverInfo = {
  contents: string;
  range?: {
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
  };
};

export type DefinitionLocation = {
  path: string;
  line: number;
  character: number;
};

export type SearchMatch = {
  path: string;
  relativePath: string;
  line: number;
  column: number;
  /** Length of the match on that line (for highlighting). */
  length: number;
  preview: string;
};

export type SearchOptions = {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  /** Comma-separated globs, e.g. `src/**, *.ts`. */
  include?: string;
  exclude?: string;
};

/** A range in a document (0-based lines / characters). */
export type TextRange = {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
};

export type TextEdit = TextRange & {
  newText: string;
  /** newText is a VS Code snippet (SnippetTextEdit of a workspace edit). */
  snippet?: boolean;
};

export type FileEdits = {
  path: string;
  edits: TextEdit[];
  /** Change the document's line endings too (TextEdit.setEndOfLine). */
  eol?: "LF" | "CRLF";
};

export type ReferenceLocation = TextRange & {
  path: string;
  /** The full text of the referencing line. */
  preview: string;
};

export type DocumentSymbol = TextRange & {
  name: string;
  /** class | function | method | property | variable | constant | interface | type | enum | module | heading | … */
  kind: string;
  /** Where the name itself starts (jump target). */
  line: number;
  character: number;
  children?: DocumentSymbol[];
};

export type GitFileStatus = {
  path: string;
  relativePath: string;
  /** Porcelain X (index) and Y (worktree) codes: M A D R C U ? or space. */
  index: string;
  worktree: string;
};

export type GitStatus = {
  isRepo: boolean;
  root: string | null;
  branch: string | null;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
  error?: string;
};

export type ExtensionInstallResult = { extension?: ExtensionDescription; cancelled?: boolean; error?: string };

/** A TextMate grammar contributed by an extension (`contributes.grammars`). */
export type ExtensionGrammar = {
  extensionId: string;
  language: string;
  scopeName: string;
  /** Absolute path of the grammar file inside the extension's folder. */
  path: string;
  embeddedLanguages?: Record<string, string>;
  injectTo?: string[];
  tokenTypes?: Record<string, string>;
};

export type AppInfo = {
  name: string;
  version: string;
  platform: string;
};

/** `update.mode`: default checks at startup and every few hours and downloads in the background; manual only on Help > Check for Updates; none never. */
export type UpdateMode = "default" | "manual" | "none";

/** `update.channel`: stable releases only, or beta pre-releases as well. */
export type UpdateChannel = "stable" | "beta";

/** A newer Lumen release (GitHub Releases). */
export type UpdateRelease = {
  version: string;
  title: string;
  /** Release notes (Markdown). */
  notes: string;
  /** Release page. */
  url: string;
};

/**
 * Where the app's update stands. `manual` marks what Help > Check for Updates
 * started, so the view reports it; background checks stay quiet until an
 * update is ready.
 */
export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking"; manual: boolean }
  | { kind: "upToDate"; manual: boolean }
  /** This copy cannot install updates (portable or dev): the release page has the download. */
  | { kind: "available"; release: UpdateRelease; manual: boolean }
  | { kind: "downloading"; release: UpdateRelease; percent: number | null; manual: boolean }
  /** Downloaded and verified; installs on restart. */
  | { kind: "ready"; release: UpdateRelease; manual: boolean }
  | { kind: "error"; message: string; manual: boolean };

/** A row of the Process Explorer: a process of the app's tree, or a thread's JavaScript heap. */
export type ProcessRow = {
  id: string;
  /** Row id of the parent; null for the app itself. */
  parent: string | null;
  /** null for thread rows. */
  pid: number | null;
  /** What the process is for ("WebView2: GPU", "Terminal: PowerShell 7"…). */
  label: string;
  kind: "app" | "thread" | "webview" | "terminal" | "process";
  /** Display name of the extension the process works for (it started it, or it renders its webview). */
  extension: string | null;
  commandLine: string;
  /** Bytes: the private working set (Windows) / resident set, or the JS heap in use for threads. */
  memory: number;
  /** Share of all cores (0–100); null when not measured yet or for threads. */
  cpu: number | null;
};

/** Structural RPC schema for the Lumen Shell bridge (types only — no runtime import). */
export type LumenRPC = {
  main: {
    requests: {
      openFolder: {
        params: Record<string, never>;
        response: { path: string | null };
      };
      openFileDialog: {
        params: Record<string, never>;
        response: { paths: string[] };
      };
      readDir: {
        params: { path: string; depth?: number };
        response: { entries: FileEntry[]; error?: string };
      };
      readFile: {
        params: { path: string; encoding?: string };
        response: OpenFileResult | { error: string };
      };
      writeFile: {
        params: { path: string; content: string; encoding?: string; expectedVersion?: string };
        response: { success: boolean; error?: string; conflict?: boolean; version?: string };
      };
      createFile: {
        params: { path: string; content?: string };
        response: { success: boolean; error?: string };
      };
      createDir: {
        params: { path: string };
        response: { success: boolean; error?: string };
      };
      deletePath: {
        params: { path: string };
        response: { success: boolean; error?: string };
      };
      renamePath: {
        params: { oldPath: string; newPath: string };
        response: { success: boolean; error?: string };
      };
      listWorkspaceFiles: {
        params: { root: string };
        response: { files: string[] };
      };
      searchInFiles: {
        params: SearchOptions & {
          root: string;
          query: string;
          maxResults?: number;
        };
        response: {
          matches: SearchMatch[];
          truncated: boolean;
          filesScanned: number;
          error?: string;
        };
      };
      replaceInFiles: {
        params: SearchOptions & {
          root: string;
          query: string;
          replacement: string;
          /** Limit the replacement to these files. */
          paths?: string[];
        };
        /** `failed`: files that could not be written (read-only, locked). */
        response: { files: number; replacements: number; failed?: string[]; error?: string };
      };
      searchFilesByName: {
        params: { root: string; query: string; maxResults?: number };
        response: { files: string[] };
      };
      detectLanguage: {
        params: { path: string };
        response: { language: string };
      };
      lspOpen: {
        params: { path: string; content: string; language: string };
        response: { ok: boolean };
      };
      lspChange: {
        params: { path: string; content: string };
        response: { ok: boolean };
      };
      lspClose: {
        params: { path: string };
        response: { ok: boolean };
      };
      lspCompletions: {
        params: { path: string; line: number; character: number };
        response: { items: CompletionItem[] };
      };
      lspHover: {
        params: { path: string; line: number; character: number };
        response: { hover: HoverInfo | null };
      };
      lspDefinition: {
        params: { path: string; line: number; character: number };
        response: { location: DefinitionLocation | null };
      };
      lspDiagnostics: {
        params: { path: string };
        response: { diagnostics: Diagnostic[] };
      };
      lspReferences: {
        params: { path: string; line: number; character: number };
        response: { locations: ReferenceLocation[] };
      };
      lspRename: {
        params: { path: string; line: number; character: number; newName: string };
        response: { edits: FileEdits[]; error?: string };
      };
      lspFormat: {
        params: { path: string; tabSize: number; insertSpaces: boolean };
        response: { edits: TextEdit[] };
      };
      lspSymbols: {
        params: { path: string };
        response: { symbols: DocumentSymbol[] | null };
      };
      /** Per-project UI state (layout, editors, terminals); opaque to the main process. */
      workspaceStateGet: {
        params: { root: string };
        response: { state: unknown | null };
      };
      workspaceStateSet: {
        params: { root: string; state: unknown };
        response: { ok: boolean };
      };
      setWorkspace: {
        params: { path: string | null };
        response: { ok: boolean };
      };
      setWindowTitle: {
        params: { title: string };
        response: { ok: boolean };
      };
      showSaveDialog: {
        params: { defaultPath?: string };
        response: { path: string | null };
      };
      gitStatus: {
        params: { root: string };
        response: GitStatus;
      };
      gitStage: {
        params: { root: string; paths: string[] };
        response: { ok: boolean; error?: string };
      };
      gitUnstage: {
        params: { root: string; paths: string[] };
        response: { ok: boolean; error?: string };
      };
      gitDiscard: {
        params: { root: string; files: { path: string; untracked: boolean }[] };
        response: { ok: boolean; error?: string };
      };
      gitCommit: {
        params: { root: string; message: string; stageAll?: boolean };
        response: { ok: boolean; error?: string };
      };
      gitShowHead: {
        params: { root: string; path: string };
        response: { content: string | null };
      };
      windowClose: {
        params: Record<string, never>;
        response: { ok: boolean };
      };
      windowMinimize: {
        params: Record<string, never>;
        response: { ok: boolean };
      };
      windowMaximize: {
        params: Record<string, never>;
        response: { ok: boolean };
      };
      windowIsMaximized: {
        params: Record<string, never>;
        response: { maximized: boolean };
      };
      showInFolder: {
        params: { path: string };
        response: { ok: boolean };
      };
      getAppInfo: {
        params: Record<string, never>;
        response: AppInfo;
      };
      /** The app's processes (Process Explorer). CPU use is measured since the previous call. */
      processList: {
        params: Record<string, never>;
        response: { rows: ProcessRow[] };
      };
      /** End a process of the app's tree (with its children); never the app itself. */
      processKill: {
        params: { pid: number };
        response: { ok: boolean; error?: string };
      };
      confirmClose: {
        params: { allow: boolean };
        response: { ok: boolean };
      };
      setDirtyState: {
        params: { dirty: boolean };
        response: { ok: boolean };
      };
      quitApp: {
        params: Record<string, never>;
        response: { ok: boolean };
      };
      terminalCreate: {
        params: { cwd?: string; cols?: number; rows?: number; profile?: string };
        response: { id: string; cwd: string; shell: string; profile: string; pid?: number; nonce?: string };
      };
      terminalProfiles: {
        params: Record<string, never>;
        response: { profiles: { id: string; name: string }[] };
      };
      terminalWrite: {
        params: { id: string; data: string };
        response: { ok: boolean };
      };
      terminalResize: {
        params: { id: string; cols: number; rows: number };
        response: { ok: boolean };
      };
      terminalKill: {
        params: { id: string };
        response: { ok: boolean };
      };
      /**
       * End every shell session: sent by a freshly loaded page before it
       * starts its own, so a reload does not leave the old page's shells running.
       */
      terminalReset: {
        params: Record<string, never>;
        response: { killed: number };
      };
      /* extensions */
      extensionsList: {
        params: Record<string, never>;
        response: { extensions: ExtensionDescription[]; dir: string };
      };
      /** TextMate grammars of the enabled extensions (contributes.grammars). */
      extensionGrammars: {
        params: Record<string, never>;
        response: { grammars: ExtensionGrammar[] };
      };
      /** Color themes of the enabled extensions (contributes.themes). */
      extensionThemes: {
        params: Record<string, never>;
        response: { themes: ExtensionColorTheme[] };
      };
      /** A contributed color theme by id (workbench.colorTheme), with includes and token colors loaded. */
      extensionColorTheme: {
        params: { id: string };
        response: { theme: ColorThemeData | null; error?: string };
      };
      /** Text of a grammar file, restricted to installed extension folders. */
      extensionGrammarFile: {
        params: { path: string };
        response: { content: string | null; error?: string };
      };
      /** Install a .vsix (asks for the file without `path`). VS Code packages are transpiled. */
      extensionsInstallVsix: {
        params: { path?: string };
        response: ExtensionInstallResult;
      };
      /** Use an extension folder in place (development) or copy it in. */
      extensionsInstallFolder: {
        params: { path?: string; copy?: boolean };
        response: ExtensionInstallResult;
      };
      extensionsInstallMarketplace: {
        params: { namespace: string; name: string; version?: string };
        response: ExtensionInstallResult;
      };
      extensionsUninstall: {
        params: { id: string };
        response: { ok: boolean; error?: string };
      };
      extensionsSetEnabled: {
        params: { id: string; enabled: boolean };
        response: { ok: boolean };
      };
      extensionsSearch: {
        params: { query: string; sortBy?: "relevance" | "downloadCount" | "averageRating" | "timestamp" };
        response: { extensions: MarketplaceExtension[]; total: number; error?: string };
      };
      /** Newer Open VSX versions of the installed extensions (by marketplace id). */
      extensionsCheckUpdates: {
        params: Record<string, never>;
        response: { updates: MarketplaceExtension[] };
      };
      /** README and listing details of an extension on Open VSX (before it is installed). */
      extensionsMarketplaceDetails: {
        params: { namespace: string; name: string; version?: string };
        response: MarketplaceDetails;
      };
      /** Downloads an Open VSX package and analyzes its compatibility, without installing it. */
      extensionsMarketplaceCompat: {
        /** `cached`: only a cached result (empty when there is none); `refresh`: analyze again, ignoring the cache. */
        params: { namespace: string; name: string; version?: string; mode?: "cached" | "refresh" };
        response: MarketplaceCompat;
      };
      extensionsChangelog: {
        params: { id: string };
        response: { markdown: string | null };
      };
      extensionsReadme: {
        params: { id: string };
        response: { markdown: string | null };
      };
      /** (Re)start the extension host with the view's settings. */
      extensionsStart: {
        params: { config: ConfigSnapshot; workspace: string | null };
        response: { count: number };
      };
      extensionsRestart: {
        params: Record<string, never>;
        response: { count: number };
      };
      /** A call into the extension host (completions, hovers, …). */
      extHostCall: {
        params: { method: keyof HostMethods; args: unknown[] };
        response: { result?: unknown; error?: string };
      };
      openExternal: {
        params: { url: string };
        response: { ok: boolean };
      };
      backupWrite: {
        params: DocumentBackup;
        response: { success: boolean };
      };
      backupDelete: {
        params: { path: string };
        response: { success: boolean };
      };
      /** The backups left by the last session (unsaved editors to restore). */
      backupList: {
        params: Record<string, never>;
        response: { backups: DocumentBackup[] };
      };
      /** `update.mode` or `update.channel` changed (also sent once at startup): schedules the background checks. */
      updateConfigure: {
        /** `channel` null: the user did not choose one (the channel of the running build). */
        params: { mode: UpdateMode; channel: UpdateChannel | null };
        response: { state: UpdateState };
      };
      /** Help > Check for Updates: check now and download what is found. */
      updateCheck: {
        params: Record<string, never>;
        response: { state: UpdateState };
      };
      /** Quit (asking about unsaved changes) and install the downloaded update; the app starts again. */
      updateInstall: {
        params: Record<string, never>;
        response: { ok: boolean; error?: string };
      };
    };
    messages: {
      log: { msg: string };
      /** Notifications for the extension host (in order). */
      extHostPost: { message: ViewToHost };
    };
  };
  webview: {
    requests: {
      requestCloseCheck: {
        params: Record<string, never>;
        response: { allow: boolean; dirtyCount: number };
      };
    };
    messages: {
      menuAction: { action: string };
      diagnostics: { diagnostics: Diagnostic[] };
      forceQuit: Record<string, never>;
      terminalData: { id: string; data: string };
      terminalExit: { id: string; code: number | null };
      /** Files under the workspace changed on disk (debounced). */
      workspaceChanged: { paths: string[]; git: boolean };
      /** Messages from the extension host. */
      extHost: { message: HostToView };
      /** The app's update moved on (checking, downloading, ready…). */
      updateState: { state: UpdateState };
    };
  };
};
