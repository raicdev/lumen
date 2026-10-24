import {
  Blocks,
  Bug,
  Cloud,
  GitCommitHorizontal,
  Tag,
  Ellipsis,
  LayoutPanelLeft,
  Maximize2,
  Minimize2,
  X,
  ChevronDown,
  ListCollapse,
  Eraser,
  FilePlus,
  Files,
  FolderPlus,
  GitBranch,
  ListTree,
  Plus,
  RefreshCw,
  Search,
  Settings,
  SquareSplitHorizontal,
  Trash2,
} from "lucide-react";
import { commandExecuted, refreshContext, setContextLookup, setVisibleViews } from "./features/menus-walkthroughs/state";
import { ModalEditorTitleActions } from "./features/menus-walkthroughs/MenuActions";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeSet } from "@codemirror/state";
import { api, setCloseCheckHandler } from "./lib/rpc";
import { diffTabPath, isDiffTab, parseDiffTab } from "./lib/diff-tab";
import { gitUri, parseGitUri } from "./lib/git-uri";
import { blameText, blameTooltip, relativeTime } from "./lib/git-blame";
import { isSmart, isTsFamily, isUntitled, isVirtualDocument, lspStatusLabel, type CursorInfo, type EditorController, type Location } from "./lib/editor";
import { isWebviewTab, useWebviews, webviewIdOf, webviewService, webviewTabPath, type SavedWebview } from "./lib/webviews";
import { ContainerIcon, ViewContainerView, WebviewSlot } from "./components/WebviewSlot";
import { isTerminalTab, terminalIdOf, terminalService, terminalTabPath } from "./lib/terminals";
import { showDialog, showPrompt, showAbout } from "./lib/dialog";
import { COMPAT_GRADES, compatGrade } from "./lib/compat";
import { hideSplash } from "./lib/splash";
import { notify, toast } from "./lib/toast";
import { extensionService, useExtensions } from "./lib/extensions";
import { treeService, useTreeViews } from "./lib/trees";
import { setTooltipCommandHandler } from "./lib/tooltip";
import { createExtensionHandlers } from "./lib/extension-handlers";
import { FeatureActivityBadge, FeatureEditorView, FeatureExplorerSections, FeatureIconView, FeatureSidebarPanels } from "./features/components";
import {
  FEATURE_VIEW_PREFIX,
  editorOpenerById,
  featureCommands,
  featureEditorTabPath,
  featureSidebarViews,
  featureViewId,
  findEditorOpener,
  initFeatures,
  isFeatureEditorDirty,
  isFeatureEditorTab,
  parseFeatureEditorTab,
  saveFeatureEditor,
  setFeatureBridge,
} from "./features/registry";
import { showContextMenu } from "./lib/context-menu";
import { basename, dirname, joinPath } from "./lib/paths";
import { getSettings, updateSetting, useSettings } from "./lib/settings";
import { localeLabel, t } from "./lib/i18n";
import { DISPLAY_LANGUAGES } from "../shared/i18n";
import { listColorThemes, reloadConfiguredColorTheme, showColorTheme, type ColorThemeEntry } from "./lib/theme";
import { DEFAULT_THEME_ID } from "../shared/color-theme";
import {
  bindingTable,
  commandLabel,
  effectiveKeybindings,
  primaryKeys,
  recentCommandIds,
  rememberCommand,
  TERMINAL_PASSTHROUGH,
  type Command,
} from "./lib/commands";
import { focusContext, keyFromEvent, loadKeybindingOverrides, OVERRIDES_KEY, saveKeybindingOverrides } from "./lib/keybindings";
import { extractSymbols, flattenSymbols } from "./lib/symbols";
import { applyTextEdits, saveParticipantEdits } from "./lib/text-edits";
import { snippetToText } from "./lib/snippets";
import { allLanguageLabels, languageLabel, setContributedLanguageLabels } from "./lib/languages";
import { toggleFullScreen, setCustomEditorRoleHandler } from "./lib/menu";
import {
  addRecentFolder,
  clearRecentFolders,
  loadEditorSession,
  loadLayout,
  recentFolders,
  RECENT_KEY,
  saveLayout,
  type Layout,
  type SavedTerminal,
  type WorkspaceState,
} from "./lib/session";
import { CodeMirrorEditor } from "./components/CodeMirrorEditor";
import { DiffEditor, type DiffContent } from "./components/DiffEditor";
import { EditorDropTarget, FILE_DRAG_TYPE, TAB_DRAG_TYPE, type EditorDropZone } from "./components/EditorDropTarget";
import { evenSizes, layoutGrid, leafIds, removeLeaf, resizeSplit, splitLeaf, type DropSide, type GridNode } from "./lib/editor-grid";
import { TERMINAL_DRAG_TYPE, TerminalHost, TerminalPanelView, useTerminals, type TerminalMenuAction } from "./components/TerminalView";
import { DockOverlay, EDITOR_TERMINAL_DRAG_TYPE, type DockZone } from "./components/DockOverlay";
import { FileTreeView, type TreeContextAction, type TreeDecorations } from "./components/FileTreeView";
import { explorerRoots } from "./features/workspace-misc/roots";
import { useStore } from "./features/store";
import { renderMarkdown } from "./lib/markdown";
import { SearchView } from "./components/SearchView";
import { QuickInput, type PickItem, type QuickInputRequest } from "./components/QuickInput";
import { TitleBar } from "./components/TitleBar";
import { TabBar, type TabAction, type TabInfo } from "./components/TabBar";
import { Breadcrumbs } from "./components/Breadcrumbs";
import { StatusBar } from "./components/StatusBar";
import { PANEL_DRAG_TYPE, Panel, type PanelPosition, type PanelTab, type ReferencesResult } from "./components/Panel";
import { DebugView } from "./components/DebugView";
import { DebugToolbar } from "./components/DebugToolbar";
import { DebugConsole } from "./components/DebugConsole";
import { debugService } from "./lib/debug";
import {
  debugStep,
  debugUi,
  editBreakpoint,
  isDebugging,
  isStopped,
  restartDebugging,
  samePath,
  startDebugging,
  stopDebugging,
  toggleBreakpoint,
} from "./lib/debug-ui";
import { OutlineView } from "./components/OutlineView";
import { ScmView, gitDecoration } from "./components/ScmView";
import { SettingsEditor } from "./components/SettingsEditor";
import { ShortcutsEditor } from "./components/ShortcutsEditor";
import { ProcessExplorer } from "./components/ProcessExplorer";
import { checkForUpdates, restartToUpdate, updateState } from "./lib/updates";
import { Welcome } from "./components/Welcome";
import { ExtensionsView, type ExtensionAction, type ExtensionTarget } from "./components/ExtensionsView";
import { ExtensionDetails } from "./components/ExtensionDetails";
import type { Diagnostic, DocumentSymbol, FileEdits, GitCommitInfo, GitFileStatus, GitRef, GitStatus, SearchOptions, TextRange } from "../shared/types";
import type {
  ExtensionDescription,
  HostDebugConfiguration,
  HostFileOperation,
  HostInputBox,
  HostQuickPick,
  HostStatusBarItem,
  HostTabGroup,
  HostWorkspaceSymbol,
  MarketplaceExtension,
} from "../shared/extensions";
import { normalizeFileSystemKey, sameDocumentKey } from "../shared/file-systems";
import { encodingShortName, FILE_ENCODINGS } from "../shared/encodings";
import { indentationFor, setDocumentIndentation } from "./lib/indentation";
import { buildMatcher, replacementEdits } from "../shared/search-replace";

/** What the app knows about an open document besides the editor state. */
type DocState = {
  /** Content when not loaded in the editor (`\n` line endings). */
  content: string;
  savedContent: string;
  language: string;
  eol: "LF" | "CRLF";
  savedEol: "LF" | "CRLF";
  /** The file's encoding (VS Code ids); UTF-8 when unset. */
  encoding?: string;
  /** The file's version on disk when it was read or last saved (see writeTextFile). */
  version?: string;
  /** A document an extension provides for reading only (text document content provider). */
  readOnly?: boolean;
  /** The provider's message for a read-only file system (registerFileSystemProvider). */
  readOnlyMessage?: string;
};

type SideView = Layout["sideView"];

const lowerKey = (path: string) => path.toLowerCase();

/** The key of the open document a path names: a provider's URI may arrive with another path case. */
const openDocumentKey = (docs: Map<string, DocState>, path: string) => [...docs.keys()].find((candidate) => sameDocumentKey(candidate, path)) ?? path;

const isInside = (path: string, folder: string) => {
  // Provider paths follow their provider's isCaseSensitive; local files compare case-insensitively.
  const normalize = (value: string) => (isVirtualDocument(value) ? normalizeFileSystemKey(value) : lowerKey(value));
  const lower = normalize(path);
  // A provider root ends in ":" or "/" ("memfs:/"); a drive root ends in a separator too.
  const base = normalize(folder).replace(/[\\/]+$/, "");
  return lower === base || lower.startsWith(base + "\\") || lower.startsWith(base + "/");
};

type EditorGroupState = { id: string; tabs: TabInfo[]; activePath: string | null };

type ReadDocumentResult = {
  content: string;
  language: string;
  encoding?: string;
  version?: string;
  readOnly?: boolean;
  readOnlyMessage?: string;
};

/** Read a document: from disk (in `encoding` when given), or from the file system an extension provides. */
async function readDocument(path: string, encoding?: string): Promise<ReadDocumentResult | { error: string }> {
  const gitVersion = parseGitUri(path);
  if (gitVersion) {
    const [{ content }, { language }] = await Promise.all([
      api().request.gitShow({ root: dirname(gitVersion.path), ref: gitVersion.ref, path: gitVersion.path }),
      api().request.detectLanguage({ path: gitVersion.path }),
    ]);
    return { content: content ?? "", language, readOnly: true };
  }
  if (!isVirtualDocument(path)) return await api().request.readFile({ path, encoding });
  try {
    return await extensionService.call("readVirtualFile", path);
  } catch (error) {
    return { error: t("Cannot open {0}: {1}", path, error instanceof Error ? error.message : error) };
  }
}

/** The document state of freshly read content (`\n` line endings inside, the file's own on save). */
function loadedDocState(result: ReadDocumentResult): DocState {
  const eol = result.content.includes("\r\n") ? "CRLF" : "LF";
  const content = result.content.replace(/\r\n/g, "\n");
  return {
    content,
    savedContent: content,
    language: result.language,
    eol,
    savedEol: eol,
    encoding: result.encoding,
    version: result.version,
    readOnly: !!result.readOnly,
    readOnlyMessage: result.readOnlyMessage,
  };
}

async function writeDocument(
  path: string,
  content: string,
  options: { encoding?: string; expectedVersion?: string } = {},
): Promise<{ success: boolean; error?: string; conflict?: boolean; version?: string }> {
  if (!isVirtualDocument(path)) return await api().request.writeFile({ path, content, ...options });
  try {
    await extensionService.call("writeVirtualFile", path, content);
    return { success: true };
  } catch (error) {
    return { success: false, error: t("Cannot save {0}: {1}", path, error instanceof Error ? error.message : error) };
  }
}

/** Tabs that are not text documents. */
const isSpecialTab = (path: string | null | undefined): path is string =>
  isTerminalTab(path) || isWebviewTab(path) || isFeatureEditorTab(path) || isDiffTab(path);

/** A custom editor tab (`webview:<id>` bound to a file): its file, provider kind and dirty state. */
type CustomEditorTabInfo = { id: string; uri: string; viewType: string; kind: "text" | "readonly" | "editable"; dirty: boolean };
const customEditorTabInfo = (path: string | null | undefined): CustomEditorTabInfo | null => {
  if (!isWebviewTab(path)) return null;
  const info = webviewService.info(webviewIdOf(path));
  if (!info?.uri) return null;
  return { id: info.id, uri: info.uri, viewType: info.viewType, kind: info.customKind ?? "text", dirty: !!info.dirty };
};

/** How long a save waits for format on save before saving the file unformatted. */
const FORMAT_ON_SAVE_TIMEOUT_MS = 10_000;

/** How often unsaved editors are backed up (hot exit). */
const BACKUP_INTERVAL_MS = 1500;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const FIRST_GROUP = "g1";
/** The modal editor part (workbench.editor.useModal): an editor group outside the grid, shown over the window. */
const MODAL_GROUP = "modal";

/** Drag data of an activity bar item being moved. */
const ACTIVITY_DRAG_TYPE = "application/x-lumen-activity";

export function App() {
  /* ── editor groups (split editor layout) ──────────────────────────────── */
  const editors = useRef(new Map<string, EditorController>());
  const editorWaiters = useRef(new Map<string, ((editor: EditorController) => void)[]>());
  const groupSeq = useRef(1);
  const groupsRef = useRef<Record<string, EditorGroupState>>({ [FIRST_GROUP]: { id: FIRST_GROUP, tabs: [], activePath: null } });
  const gridRef = useRef<GridNode>({ type: "leaf", groupId: FIRST_GROUP });
  const activeGroupIdRef = useRef(FIRST_GROUP);
  const [groups, setGroupsState] = useState(groupsRef.current);
  const [grid, setGridState] = useState(gridRef.current);
  const [activeGroupId, setActiveGroupIdState] = useState(FIRST_GROUP);
  /** The active group's editor: most features work on "the" editor. */
  const editorRef = useMemo(
    () => ({
      get current(): EditorController | null {
        return editors.current.get(activeGroupIdRef.current) ?? null;
      },
    }),
    [],
  );
  const docs = useRef(new Map<string, DocState>());
  /** Where a diff tab should put the cursor in its modified side, and whether it takes the focus when it opens. */
  const diffSelections = useRef(new Map<string, TextRange>());
  const diffAutoFocus = useRef(new Set<string>());
  const mru = useRef<string[]>([]);
  const closedStack = useRef<string[]>([]);
  const navBack = useRef<Location[]>([]);
  const navForward = useRef<Location[]>([]);
  const untitledCounter = useRef(0);
  const autoSaveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const editorDirty = useRef(new Map<string, boolean>());
  const workspaceRootRef = useRef<string | null>(null);
  /** Session saving is paused while a workspace's editors are being restored. */
  const restoringSession = useRef(false);
  /** While a project's terminals are recreated, editor tabs are set up by the restore itself. */
  const restoringTerminals = useRef(false);
  /** Bumped when a restore ends, so the terminal-tab sync catches up. */
  const [terminalSyncTick, setTerminalSyncTick] = useState(0);

  const settings = useSettings();
  const initialLayout = useMemo(loadLayout, []);
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [activeLanguage, setActiveLanguage] = useState<string | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState(initialLayout.sidebarVisible);
  const [sidebarWidth, setSidebarWidth] = useState(initialLayout.sidebarWidth);
  const [explorerViewsHeight, setExplorerViewsHeight] = useState<number | null>(initialLayout.explorerViewsHeight ?? null);
  const [auxBarVisible, setAuxBarVisible] = useState(initialLayout.auxBarVisible ?? true);
  const [auxBarWidth, setAuxBarWidth] = useState(initialLayout.auxBarWidth ?? 340);
  const [auxBarView, setAuxBarView] = useState<string | null>(initialLayout.auxBarView ?? null);
  const [sideView, setSideView] = useState<SideView>(initialLayout.sideView);
  const [panelVisible, setPanelVisible] = useState(initialLayout.panelVisible);
  const [panelHeight, setPanelHeight] = useState(initialLayout.panelHeight);
  const [panelWidth, setPanelWidth] = useState(initialLayout.panelWidth);
  const [panelPosition, setPanelPosition] = useState<PanelPosition>(initialLayout.panelPosition);
  const [dragKind, setDragKind] = useState<"panel" | "terminal" | "tab" | "file" | null>(null);
  const terminals = useTerminals();
  /** Group that the next terminal moved into the editor area should open in. */
  const pendingTerminalGroup = useRef<string | null>(null);
  const [panelTab, setPanelTab] = useState<PanelTab>(initialLayout.panelTab);
  const [activityDrop, setActivityDrop] = useState<{ view: string; after: boolean } | null>(null);
  const [panelMaximized, setPanelMaximized] = useState(false);
  const [zenMode, setZenMode] = useState(false);
  const [treeRefresh, setTreeRefresh] = useState(0);
  /** Extra workspace folders (including provided file systems) the explorer shows. */
  const explorerRootEntries = useStore(explorerRoots);
  const [treeReveal, setTreeReveal] = useState<{ path: string; token: number } | null>(null);
  const [treeCollapse, setTreeCollapse] = useState(0);
  const [outlineCollapse, setOutlineCollapse] = useState(0);
  const [searchFocus, setSearchFocus] = useState(0);
  const [searchReplace, setSearchReplace] = useState(0);
  const [searchSeed, setSearchSeed] = useState("");
  const [quick, setQuick] = useState<QuickInputRequest | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [processExplorerOpen, setProcessExplorerOpen] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, string>>(loadKeybindingOverrides);
  const [diagnostics, setDiagnostics] = useState<Map<string, Diagnostic[]>>(new Map());
  const [references, setReferences] = useState<ReferencesResult | null>(null);
  const [symbols, setSymbols] = useState<DocumentSymbol[] | null>(null);
  const [cursor, setCursor] = useState<CursorInfo | null>(null);
  const [git, setGit] = useState<GitStatus | null>(null);
  const [gitBusy, setGitBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>(recentFolders);

  /* extensions */
  const ext = useExtensions();
  /** Every installed extension (enabled or not), for the Extensions view. */
  const [installedExtensions, setInstalledExtensions] = useState<ExtensionDescription[]>([]);
  const [extensionTarget, setExtensionTarget] = useState<ExtensionTarget | null>(null);
  const [extensionBusy, setExtensionBusy] = useState<Set<string>>(new Set());
  const [extensionsFocus, setExtensionsFocus] = useState(0);
  /** Terminals created by extensions (they hear when one closes). */
  const extensionTerminals = useRef(new Set<string>());
  const webviews = useWebviews();
  const treeViews = useTreeViews();
  /** Bumped (debounced) when a webview saves its state, so the window state is written again. */
  const [webviewSaveTick, setWebviewSaveTick] = useState(0);
  /** Language service diagnostics plus the ones extensions reported. */
  const allDiagnostics = useMemo(() => {
    if (!ext.diagnostics.size) return diagnostics;
    const merged = new Map(diagnostics);
    for (const [path, list] of ext.diagnostics) {
      const key = [...merged.keys()].find((candidate) => lowerKey(candidate) === lowerKey(path)) ?? path;
      merged.set(key, [...(merged.get(key) ?? []), ...list]);
    }
    return merged;
  }, [diagnostics, ext.diagnostics]);
  const extensionKeybindings = useMemo(
    () =>
      extensionService.contributedKeybindings().map((binding) => ({ key: binding.key, command: binding.command, whenExpr: binding.when, args: binding.args })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ext.extensions],
  );
  // Extensions came, went or were switched on / off: the configured theme may have changed with them.
  useEffect(() => {
    void reloadConfiguredColorTheme(true);
  }, [ext.extensions]);
  useEffect(() => {
    setContributedLanguageLabels(
      Object.fromEntries(extensionService.contributedLanguages().map((language) => [language.id, language.aliases?.[0] ?? language.id])),
    );
  }, [ext.extensions]);

  workspaceRootRef.current = workspaceRoot;

  /** Group state changes go through here so the ref is always current. */
  const updateGroups = useCallback((update: (prev: Record<string, EditorGroupState>) => Record<string, EditorGroupState>) => {
    const next = update(groupsRef.current);
    if (next === groupsRef.current) return;
    groupsRef.current = next;
    setGroupsState(next);
  }, []);

  const updateGrid = useCallback((update: (prev: GridNode) => GridNode) => {
    const next = update(gridRef.current);
    if (next === gridRef.current) return;
    gridRef.current = next;
    setGridState(next);
  }, []);

  /** Tabs of a group (the active one by default). */
  const setTabs = useCallback(
    (update: TabInfo[] | ((prev: TabInfo[]) => TabInfo[]), groupId = activeGroupIdRef.current) =>
      updateGroups((prev) => {
        const group = prev[groupId];
        if (!group) return prev;
        const tabs = typeof update === "function" ? update(group.tabs) : update;
        return tabs === group.tabs ? prev : { ...prev, [groupId]: { ...group, tabs } };
      }),
    [updateGroups],
  );

  const setActivePath = useCallback(
    (update: string | null | ((prev: string | null) => string | null), groupId = activeGroupIdRef.current) =>
      updateGroups((prev) => {
        const group = prev[groupId];
        if (!group) return prev;
        const activePath = typeof update === "function" ? update(group.activePath) : update;
        return activePath === group.activePath ? prev : { ...prev, [groupId]: { ...group, activePath } };
      }),
    [updateGroups],
  );

  /** Apply a tab mapping in every group (dirty marks, renames, …). */
  const mapAllTabs = useCallback(
    (map: (tab: TabInfo) => TabInfo) =>
      updateGroups((prev) => {
        let changed = false;
        const next: Record<string, EditorGroupState> = {};
        for (const [id, group] of Object.entries(prev)) {
          const tabs = group.tabs.map(map);
          const same = tabs.every((tab, index) => tab === group.tabs[index]);
          next[id] = same ? group : { ...group, tabs };
          if (!same) changed = true;
        }
        return changed ? next : prev;
      }),
    [updateGroups],
  );

  const activeGroup = groups[activeGroupId] ?? Object.values(groups)[0]!;
  const tabs = activeGroup.tabs;
  const activePath = activeGroup.activePath;
  const activePathRef = useMemo(
    () => ({
      get current(): string | null {
        return groupsRef.current[activeGroupIdRef.current]?.activePath ?? null;
      },
    }),
    [],
  );

  const groupsWith = (path: string) => Object.values(groupsRef.current).filter((group) => group.tabs.some((tab) => tab.path === path));
  const allTabPaths = () => [...new Set(Object.values(groupsRef.current).flatMap((group) => group.tabs.map((tab) => tab.path)))];
  const editorHolding = (path: string) => [...editors.current.values()].find((editor) => editor.hasDocument(path)) ?? null;

  const focusGroup = useCallback((id: string) => {
    if (!groupsRef.current[id] || activeGroupIdRef.current === id) return;
    activeGroupIdRef.current = id;
    setActiveGroupIdState(id);
    editors.current.get(id)?.requestCursor();
  }, []);

  /** The editor of a group, waiting for it to mount (new groups render first). */
  const waitForEditor = useCallback((groupId: string): Promise<EditorController> => {
    const existing = editors.current.get(groupId);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const list = editorWaiters.current.get(groupId) ?? [];
      list.push(resolve);
      editorWaiters.current.set(groupId, list);
    });
  }, []);

  /** Make room for a new, empty group beside `groupId`. */
  const splitGroup = useCallback(
    (groupId: string, side: DropSide): string => {
      const id = `g${++groupSeq.current}`;
      updateGroups((prev) => ({ ...prev, [id]: { id, tabs: [], activePath: null } }));
      updateGrid((prev) => splitLeaf(prev, groupId, side, id));
      return id;
    },
    [updateGroups, updateGrid],
  );

  /**
   * Remove an empty group. Without `force` this only happens when
   * workbench.editor.closeEmptyGroups is on; otherwise the layout stays.
   */
  const pruneGroup = useCallback(
    (groupId: string, force = false) => {
      const group = groupsRef.current[groupId];
      if (!group || group.tabs.length || Object.keys(groupsRef.current).length < 2) return;
      if (!force && !getSettings()["workbench.editor.closeEmptyGroups"]) return;
      updateGrid((prev) => removeLeaf(prev, groupId));
      updateGroups((prev) => {
        const next = { ...prev };
        delete next[groupId];
        return next;
      });
      if (activeGroupIdRef.current === groupId) {
        const fallback = leafIds(gridRef.current)[0];
        if (fallback) {
          activeGroupIdRef.current = fallback;
          setActiveGroupIdState(fallback);
          editors.current.get(fallback)?.requestCursor();
          editors.current.get(fallback)?.focus();
        }
      }
    },
    [updateGrid, updateGroups],
  );

  /* ── modal editor part ─────────────────────────────────────────────────── */

  const [modalMaximized, setModalMaximized] = useState(false);
  /** Set while the modal group is created for a file being opened (it is empty until the tab arrives). */
  const modalPending = useRef(false);
  const [modalCheck, setModalCheck] = useState(0);

  const ensureModalGroup = useCallback(() => {
    if (groupsRef.current[MODAL_GROUP]) return;
    modalPending.current = true;
    updateGroups((prev) => ({ ...prev, [MODAL_GROUP]: { id: MODAL_GROUP, tabs: [], activePath: null } }));
    // An open that failed leaves the group empty: drop it after a while.
    setTimeout(() => {
      modalPending.current = false;
      setModalCheck((n) => n + 1);
    }, 3000);
  }, [updateGroups]);

  // The modal closes with its last editor.
  useEffect(() => {
    const modal = groups[MODAL_GROUP];
    if (!modal) return;
    if (modal.tabs.length) {
      modalPending.current = false;
      return;
    }
    if (modalPending.current) return;
    updateGroups((prev) => {
      const next = { ...prev };
      delete next[MODAL_GROUP];
      return next;
    });
    setModalMaximized(false);
    if (activeGroupIdRef.current === MODAL_GROUP) {
      const fallback = leafIds(gridRef.current)[0];
      if (fallback) {
        activeGroupIdRef.current = fallback;
        setActiveGroupIdState(fallback);
        editors.current.get(fallback)?.focus();
      }
    }
  }, [groups, modalCheck, updateGroups]);

  const bindings = useMemo(() => effectiveKeybindings(overrides, extensionKeybindings), [overrides, extensionKeybindings]);
  const keys = useMemo(() => primaryKeys(bindings), [bindings]);
  const bindingsByKey = useRef(bindingTable(bindings));
  bindingsByKey.current = bindingTable(bindings);

  /* ── documents & tabs ─────────────────────────────────────────────────── */

  const docContent = useCallback((path: string): string | null => {
    for (const editor of editors.current.values()) {
      const content = editor.getDocumentContent(path);
      if (content !== null) return content;
    }
    return docs.current.get(path)?.content ?? null;
  }, []);

  const isDocDirty = useCallback((path: string) => {
    const doc = docs.current.get(path);
    return (editorDirty.current.get(path) ?? false) || (!!doc && doc.eol !== doc.savedEol);
  }, []);

  const refreshTabDirty = useCallback(
    (path: string) => {
      const dirty = isDocDirty(path);
      mapAllTabs((tab) => {
        // Diff tabs show the modified document: their dot follows that document.
        const shows = tab.path === path || parseDiffTab(tab.path)?.modified === path;
        return shows && (tab.dirty !== dirty || (dirty && tab.preview)) ? { ...tab, dirty, preview: tab.preview && !dirty } : tab;
      });
    },
    [isDocDirty, mapAllTabs],
  );

  const syncDirtyState = useCallback(() => {
    const dirty = [...docs.current.keys()].some((path) => isDocDirty(path)) || webviewService.dirtyCustomEditors().length > 0;
    void api()
      .request.setDirtyState({ dirty })
      .catch(() => {});
  }, [isDocDirty]);

  const touchMru = (path: string) => {
    mru.current = [path, ...mru.current.filter((p) => p !== path)];
  };

  const currentLocation = useCallback((): Location | null => {
    const path = editorRef.current?.getCurrent()?.path;
    if (!path) return null;
    return { path, ...editorRef.current!.getCursor() };
  }, [editorRef]);

  /** Remember where we are before jumping somewhere else (Go Back / Forward). */
  const pushNavigation = useCallback(() => {
    const location = currentLocation();
    if (!location) return;
    const last = navBack.current[navBack.current.length - 1];
    if (last && last.path === location.path && Math.abs(last.line - location.line) < 3) return;
    navBack.current.push(location);
    if (navBack.current.length > 50) navBack.current.shift();
    navForward.current = [];
  }, [currentLocation]);

  const loadGitBase = useCallback(async (path: string) => {
    const root = workspaceRootRef.current;
    if (!root || isUntitled(path) || isVirtualDocument(path) || !getSettings()["editor.gitGutter"]) return;
    try {
      const { content } = await api().request.gitShowHead({ root, path });
      for (const editor of editors.current.values()) editor.setGitBase(path, content);
    } catch {
      /* not a repository */
    }
  }, []);

  const saveDocRef = useRef<(path: string, options?: { saveAs?: boolean }) => Promise<boolean>>(async () => false);

  /** Open (or switch to) a file; `preview` reuses the preview tab like VS Code. */
  const openFile = useCallback(
    async (
      path: string,
      options: {
        preview?: boolean;
        line?: number;
        character?: number;
        end?: { line: number; character: number };
        focus?: boolean;
        recordNav?: boolean;
        /** Editor group to open in (default: the active group). */
        groupId?: string;
        /** Open with this custom editor view type; "default" forces the text editor. */
        viewType?: string;
      } = {},
    ): Promise<boolean> => {
      // The same provider resource with another path case is the open document's tab.
      path = openDocumentKey(docs.current, path);
      // workbench.editor.useModal "all": files open in the modal editor part.
      const toModal =
        !options.groupId && getSettings()["workbench.editor.useModal"] === "all" && !isTerminalTab(path) && !isWebviewTab(path) && !isDiffTab(path);
      if (toModal) ensureModalGroup();
      const groupId = toModal ? MODAL_GROUP : options.groupId && groupsRef.current[options.groupId] ? options.groupId : activeGroupIdRef.current;
      focusGroup(groupId);
      const editor = editors.current.get(groupId) ?? (await waitForEditor(groupId));
      if (isTerminalTab(path)) {
        // Terminal in the editor area: just switch to its tab.
        if (!groupsRef.current[groupId]?.tabs.some((tab) => tab.path === path)) return false;
        touchMru(path);
        setActivePath(path, groupId);
        terminalService.focus(terminalIdOf(path));
        return true;
      }
      if (isWebviewTab(path)) {
        if (!groupsRef.current[groupId]?.tabs.some((tab) => tab.path === path)) return false;
        touchMru(path);
        setActivePath(path, groupId);
        return true;
      }
      if (isDiffTab(path)) {
        if (!groupsRef.current[groupId]?.tabs.some((tab) => tab.path === path)) return false;
        touchMru(path);
        setActivePath(path, groupId);
        return true;
      }
      if (options.recordNav !== false) pushNavigation();

      // A feature's editor (notebooks) renders the whole file: its own tab, taking the place of a plain tab of the file.
      const featureTab = parseFeatureEditorTab(path);
      const featureOpener = featureTab
        ? editorOpenerById(featureTab.openerId)
        : options.viewType === "default" || isUntitled(path)
          ? null
          : findEditorOpener(path);
      if (isFeatureEditorTab(path) && !featureOpener) return false;
      if (featureOpener) {
        const filePath = featureTab?.path ?? path;
        const tabPath = featureEditorTabPath(featureOpener.id, filePath);
        setTabs((prev) => {
          if (prev.some((tab) => tab.path === tabPath)) return prev;
          const tab: TabInfo = {
            path: tabPath,
            name: featureOpener.title?.(filePath) ?? basename(filePath),
            dirty: isFeatureEditorDirty(tabPath),
            preview: false,
          };
          const plain = prev.findIndex((t) => t.path === filePath);
          if (plain >= 0) return prev.map((t, index) => (index === plain ? tab : t));
          const activeIndex = prev.findIndex((t) => t.path === editor.getCurrent()?.path);
          const next = [...prev];
          next.splice(activeIndex >= 0 ? activeIndex + 1 : next.length, 0, tab);
          return next;
        }, groupId);
        touchMru(tabPath);
        setActivePath(tabPath, groupId);
        return true;
      }

      const forcedViewType = options.viewType;

      // A custom editor already showing this file: focus its tab.
      const existingCustom = forcedViewType ? undefined : webviewService.customEditorFor(path);
      if (existingCustom) {
        const customTabPath = webviewTabPath(existingCustom.id);
        if (groupsRef.current[groupId]?.tabs.some((tab) => tab.path === customTabPath)) {
          touchMru(customTabPath);
          setActivePath(customTabPath, groupId);
          return true;
        }
      }

      // A "default" priority custom editor (or a chosen one) handles this file: open it there.
      if (!isUntitled(path) && forcedViewType !== "default" && extensionService.hasExtensions) {
        const alreadyTextTab = !forcedViewType && Object.values(groupsRef.current).some((group) => group.tabs.some((tab) => tab.path === path));
        const contribution = forcedViewType
          ? { viewType: forcedViewType, displayName: forcedViewType, priority: "option" as const, extensionId: "", selector: [] }
          : extensionService.defaultCustomEditorFor(path, docs.current.get(path)?.language);
        if (contribution && !alreadyTextTab) {
          const opened = await extensionService
            .call("openCustomEditor", path, contribution.viewType, { preview: !!options.preview, beside: false })
            .catch(() => null);
          if (opened) {
            if (opened.kind === "text") {
              // The extension edits the file's text document: keep the view's copy in sync.
              if (!docs.current.has(path)) {
                const result = await readDocument(path);
                if (!("error" in result)) docs.current.set(path, loadedDocState(result));
              }
              extensionService.documentOpened(path);
            }
            return true;
          }
        }
      }

      if (!docs.current.has(path)) {
        if (isUntitled(path)) return false;
        const result = await readDocument(path);
        if ("error" in result) {
          toast(result.error, "error");
          setTabs((prev) => prev.filter((tab) => tab.path !== path), groupId);
          return false;
        }
        docs.current.set(path, loadedDocState(result));
      }
      const doc = docs.current.get(path)!;
      const preview = !!options.preview && getSettings()["workbench.editor.enablePreview"];

      setTabs((prev) => {
        const existing = prev.find((tab) => tab.path === path);
        if (existing) {
          return preview || !existing.preview ? prev : prev.map((tab) => (tab.path === path ? { ...tab, preview: false } : tab));
        }
        const tab: TabInfo = { path, name: basename(path), dirty: isDocDirty(path), preview };
        const previewIndex = preview ? prev.findIndex((t) => t.preview && !t.dirty) : -1;
        if (previewIndex >= 0) {
          const replaced = prev[previewIndex]!.path;
          queueMicrotask(() => {
            editor.closeDocument(replaced);
            if (groupsWith(replaced).length) return; // still open in another group
            docs.current.delete(replaced);
            editorDirty.current.delete(replaced);
            mru.current = mru.current.filter((p) => p !== replaced);
            if (!isUntitled(replaced))
              void api()
                .request.lspClose({ path: replaced })
                .catch(() => {});
          });
          const next = [...prev];
          next[previewIndex] = tab;
          return next;
        }
        const activeIndex = prev.findIndex((t) => t.path === editor.getCurrent()?.path);
        const next = [...prev];
        next.splice(activeIndex >= 0 ? activeIndex + 1 : next.length, 0, tab);
        return next;
      }, groupId);

      touchMru(path);
      setActivePath(path, groupId);
      setActiveLanguage(doc.language);
      if (editor.getCurrent()?.path !== path) {
        const previous = editor.getCurrent()?.path;
        await editor.openDocument({
          path,
          language: doc.language,
          content: docContent(path) ?? doc.content,
          savedContent: doc.savedContent,
          readOnly: doc.readOnly,
        });
        if (previous && getSettings()["files.autoSave"] === "onFocusChange" && !isUntitled(previous) && isDocDirty(previous)) {
          void saveDocRef.current(previous);
        }
        void loadGitBase(path);
      }
      extensionService.documentOpened(path);
      if (options.line !== undefined) editor.revealPosition(options.line, options.character ?? 0, options.end);
      else if (options.focus !== false) editor.focus();
      if (getSettings()["explorer.autoReveal"] && !isUntitled(path)) setTreeReveal({ path, token: Date.now() });
      return true;
    },
    [docContent, isDocDirty, loadGitBase, focusGroup, waitForEditor, setTabs, setActivePath, pushNavigation, ensureModalGroup],
  );

  /** Read either side of a diff: an open document's editor state, or the file / virtual document on disk. */
  const loadDiffContent = useCallback(
    async (path: string): Promise<DiffContent> => {
      const doc = docs.current.get(path);
      if (doc) return { content: docContent(path) ?? doc.content, language: doc.language, readOnly: doc.readOnly };
      if (isUntitled(path)) return { error: t("Cannot open {0}: the document is not open.", path) };
      return await readDocument(path);
    },
    [docContent],
  );

  /** Open (or switch to) a side-by-side diff tab (`vscode.diff`). */
  const openDiff = useCallback(
    async (
      original: string,
      modified: string,
      options: { title?: string; preview?: boolean; preserveFocus?: boolean; viewColumn?: number; selection?: TextRange } = {},
    ): Promise<boolean> => {
      original = openDocumentKey(docs.current, original);
      modified = openDocumentKey(docs.current, modified);
      let groupId = activeGroupIdRef.current;
      if (options.viewColumn !== undefined && (options.viewColumn === -2 || options.viewColumn > 1)) {
        const order = leafIds(gridRef.current);
        groupId = order[order.indexOf(activeGroupIdRef.current) + 1] ?? splitGroup(activeGroupIdRef.current, "right");
      }
      focusGroup(groupId);
      const editor = editors.current.get(groupId) ?? (await waitForEditor(groupId));

      // The modified side is a real document: it is saved and synced like a text tab.
      if (!docs.current.has(modified)) {
        if (isUntitled(modified)) return false;
        const result = await readDocument(modified);
        if ("error" in result) {
          toast(result.error, "error");
          return false;
        }
        docs.current.set(modified, loadedDocState(result));
      }

      const tabPath = diffTabPath(original, modified);
      // A content provider URI may carry a query (`git:/a.txt?ref=HEAD`): show just the name.
      const nameOf = (path: string) => basename(path.replace(/[?#].*$/, "")) || basename(path);
      const name = options.title ?? `${nameOf(original)} ↔ ${nameOf(modified)}`;
      if (options.selection) diffSelections.current.set(tabPath, options.selection);
      if (!options.preserveFocus) diffAutoFocus.current.add(tabPath);
      const preview = !!options.preview && getSettings()["workbench.editor.enablePreview"];
      setTabs((prev) => {
        if (prev.some((tab) => tab.path === tabPath)) return prev;
        const tab: TabInfo = { path: tabPath, name, dirty: isDocDirty(modified), preview };
        const previewIndex = preview ? prev.findIndex((candidate) => candidate.preview && !candidate.dirty) : -1;
        if (previewIndex >= 0) {
          const next = [...prev];
          next[previewIndex] = tab;
          return next;
        }
        const activeIndex = prev.findIndex((candidate) => candidate.path === editor.getCurrent()?.path);
        const next = [...prev];
        next.splice(activeIndex >= 0 ? activeIndex + 1 : next.length, 0, tab);
        return next;
      }, groupId);

      touchMru(tabPath);
      setActivePath(tabPath, groupId);
      extensionService.documentOpened(modified);
      return true;
    },
    [focusGroup, isDocDirty, setActivePath, setTabs, waitForEditor, splitGroup],
  );

  /** Keep the modified side of a diff tab in the document model (dirty dot, extensions, saving). */
  const editDiffDocument = useCallback(
    (path: string, content: string, changes: ChangeSet) => {
      const doc = docs.current.get(path);
      if (!doc) return;
      doc.content = content;
      for (const editor of editors.current.values()) if (editor.hasDocument(path)) editor.applyRemoteChanges(path, changes);
      const dirty = content !== doc.savedContent || doc.eol !== doc.savedEol;
      editorDirty.current.set(path, dirty);
      refreshTabDirty(path);
      syncDirtyState();
      extensionService.documentChanged(path);
      extensionService.documentDirty(path, dirty);
    },
    [refreshTabDirty, syncDirtyState],
  );

  const newUntitled = useCallback(
    async (language = "plaintext", content = "") => {
      untitledCounter.current += 1;
      const name = `Untitled-${untitledCounter.current}`;
      const path = `untitled:${name}`;
      docs.current.set(path, { content, savedContent: "", language, eol: "LF", savedEol: "LF" });
      setTabs((prev) => [...prev, { path, name, dirty: content !== "", preview: false }]);
      await openFile(path);
    },
    [openFile, setTabs],
  );

  /** Save a document; returns false when cancelled or failed. */
  const saveDoc = useCallback(
    async (path: string, options: { saveAs?: boolean; destination?: string } = {}): Promise<boolean> => {
      // A diff tab saves its modified side.
      const diff = parseDiffTab(path);
      if (diff) path = diff.modified;
      // A feature editor (notebooks) saves through its opener.
      if (isFeatureEditorTab(path)) return await saveFeatureEditor(path);
      // A custom editor tab saves through its provider; a text custom editor uses the normal path.
      const custom = customEditorTabInfo(path);
      if (custom && custom.kind !== "text") {
        if (custom.kind !== "editable") return false;
        const method = options.saveAs ? "saveCustomEditorAs" : "saveCustomEditor";
        return !!(await extensionService.call(method, custom.uri, custom.viewType).catch(() => false));
      }
      if (custom) path = custom.uri;
      const editor = editorRef.current;
      const doc = docs.current.get(path);
      if (!editor || !doc) return false;
      // A read-only file system provider's message says why the file cannot be written.
      if (doc.readOnly && !options.saveAs) {
        toast(doc.readOnlyMessage ?? t("{0} is read-only.", basename(path)), "info");
        return false;
      }

      let target = path;
      if (isUntitled(path) || options.saveAs) {
        if (options.destination) target = options.destination;
        else {
          const root = workspaceRootRef.current;
          const suggested = isUntitled(path)
            ? root
              ? joinPath(root, basename(path).replace(/^untitled:/, "") + (doc.language === "plaintext" ? ".txt" : ""))
              : undefined
            : path;
          const { path: chosen } = await api().request.showSaveDialog({ defaultPath: suggested });
          if (!chosen) return false;
          target = chosen;
        }
      }

      if (editor.getCurrent()?.path === path) {
        const s = getSettings();
        if (s["editor.formatOnSave"] && editor.canFormat()) {
          // A formatter that hangs (or an extension host that died) must not keep the file from being saved.
          const formatted = await Promise.race([editor.format().catch(() => false), delay(FORMAT_ON_SAVE_TIMEOUT_MS).then(() => "timeout" as const)]);
          if (formatted === "timeout") toast(t("Formatting {0} took too long; it was saved without formatting.", basename(path)), "info");
        }
        // onWillSaveTextDocument: extensions may hand back edits (reason 1 = Manually).
        if (extensionService.hasExtensions) {
          const edits = await extensionService.call("willSaveDocument", path, 1).catch(() => []);
          if (edits?.length) editor.applyEdits(edits);
        }
        const participants = saveParticipantEdits(editor.getContent(), s["files.trimTrailingWhitespace"], s["files.insertFinalNewline"]);
        if (participants.length) editor.applyEdits(participants);
      }

      const content = docContent(path) ?? doc.content;
      const onDisk = doc.eol === "CRLF" ? content.replace(/\n/g, "\r\n") : content;
      const write = (expectedVersion?: string) => writeDocument(target, onDisk, { encoding: doc.encoding, expectedVersion });
      let result = await write(target === path ? doc.version : undefined);
      if (result.conflict) {
        // Another program wrote the file since it was read or saved here. Ask, unless the disk
        // still holds what was last read or saved (a tool only touched it).
        const current = await readDocument(target, doc.encoding);
        const unchanged = !("error" in current) && current.content.replace(/\r\n/g, "\n") === doc.savedContent;
        const choice = unchanged
          ? "overwrite"
          : await showDialog({
              title: t("File Changed on Disk"),
              message: t("{0} has been changed on disk since you opened it. Overwrite it with your changes?", basename(target)),
              detail: t("Revert File (Command Palette) loads the version on disk instead."),
              buttons: [
                { label: t("Overwrite"), role: "danger", value: "overwrite" },
                { label: t("Cancel"), role: "default", value: "cancel" },
              ],
              kind: "warning",
            });
        if (choice !== "overwrite") return false;
        result = await write();
      }
      if (!result.success) {
        toast(result.error ?? t("Save failed"), "error");
        return false;
      }

      if (target !== path) {
        extensionService.documentClosed(path);
        const { language } = await api().request.detectLanguage({ path: target });
        docs.current.delete(path);
        docs.current.set(target, { ...doc, language });
        renameEverywhere(path, target, { pin: true });
        for (const other of editors.current.values()) {
          if (other.getCurrent()?.path === target) other.setLanguage(language);
        }
        if (editor.getCurrent()?.path === target) setActiveLanguage(language);
        setTreeRefresh((n) => n + 1);
      }

      const saved = docs.current.get(target)!;
      saved.savedContent = content;
      saved.content = content;
      saved.savedEol = saved.eol;
      saved.version = result.version;
      // A diff tab edits the document without an EditorController holding it.
      editorDirty.current.set(target, content !== saved.savedContent);
      for (const other of editors.current.values()) other.markSaved(target, content);
      refreshTabDirty(target);
      syncDirtyState();
      extensionService.documentSaved(target);
      return true;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- renameEverywhere is a plain function that works through refs; listing it would rebuild this on every render
    [docContent, refreshTabDirty, syncDirtyState, editorRef],
  );
  saveDocRef.current = saveDoc;

  const saveAll = useCallback(async () => {
    let saved = 0;
    for (const path of [...docs.current.keys()]) {
      if (!isDocDirty(path)) continue;
      if (await saveDoc(path)) saved++;
    }
    // Custom editor tabs are not in `docs` (an editable document is the extension's).
    for (const entry of webviewService.dirtyCustomEditors()) {
      const ok =
        entry.kind === "text" ? await saveDoc(entry.uri) : !!(await extensionService.call("saveCustomEditor", entry.uri, entry.viewType).catch(() => false));
      if (ok) saved++;
    }
    return saved;
  }, [isDocDirty, saveDoc]);

  /**
   * Close editors: in one group, or (without `groupId`) wherever they are open.
   * A document is only closed — and asked about unsaved changes — when its
   * last editor goes away.
   */
  const closeTabs = useCallback(
    async (paths: string[], groupId?: string): Promise<boolean> => {
      const targets = groupId ? [groupId] : Object.keys(groupsRef.current);
      // A diff tab edits its modified document; closing either closes the document with its last tab.
      const documentOf = (path: string) => parseDiffTab(path)?.modified ?? path;
      const lastEditor = (path: string) => {
        const document = documentOf(path);
        return !Object.values(groupsRef.current).some(
          (group) => !targets.includes(group.id) && group.tabs.some((tab) => tab.path !== path && documentOf(tab.path) === document),
        );
      };

      for (const path of paths) {
        const document = documentOf(path);
        const dirty = isDocDirty(document) || !!customEditorTabInfo(path)?.dirty || (isFeatureEditorTab(path) && isFeatureEditorDirty(path));
        if (!lastEditor(path) || !dirty) continue;
        const holder = targets.find((id) => groupsRef.current[id]?.tabs.some((tab) => tab.path === path));
        if (holder && !isDiffTab(path) && docs.current.has(document)) await openFile(document, { recordNav: false, groupId: holder });
        const choice = await showDialog({
          title: t("Unsaved changes"),
          message: t("Do you want to save the changes you made to {0}?", basename(document)),
          detail: t("Your changes will be lost if you don't save them."),
          buttons: [
            { label: t("Save"), role: "primary", value: "save" },
            { label: t("Don't Save"), role: "danger", value: "discard" },
            { label: t("Cancel"), role: "default", value: "cancel" },
          ],
        });
        if (choice === "cancel" || choice === null) return false;
        if (choice === "save" && !(await saveDoc(document))) return false;
      }

      const closing = new Set(paths);
      const finished = paths.filter(lastEditor);
      for (const id of targets) {
        const group = groupsRef.current[id];
        if (!group) continue;
        for (const tab of group.tabs) {
          if (closing.has(tab.path) && !isSpecialTab(tab.path)) editors.current.get(id)?.closeDocument(tab.path);
        }
      }
      for (const path of finished) {
        mru.current = mru.current.filter((p) => p !== path);
        const diff = parseDiffTab(path);
        if (diff) {
          diffSelections.current.delete(path);
          diffAutoFocus.current.delete(path);
          const stillOpen = Object.values(groupsRef.current).some((group) =>
            group.tabs.some((tab) => tab.path !== path && !closing.has(tab.path) && documentOf(tab.path) === diff.modified),
          );
          if (!stillOpen) {
            docs.current.delete(diff.modified);
            editorDirty.current.delete(diff.modified);
            extensionService.documentClosed(diff.modified);
          }
          continue;
        }
        if (isTerminalTab(path)) {
          terminalService.kill(terminalIdOf(path));
          continue;
        }
        if (isFeatureEditorTab(path)) {
          const file = parseFeatureEditorTab(path)?.path;
          if (file) closedStack.current.push(file);
          continue;
        }
        if (isWebviewTab(path)) {
          const custom = customEditorTabInfo(path);
          webviewService.close(webviewIdOf(path));
          // A text custom editor keeps the file open in the window: close it with its last tab.
          if (custom) {
            const stillOpen = Object.values(groupsRef.current).some((group) =>
              group.tabs.some(
                (tab) => tab.path !== path && !closing.has(tab.path) && (tab.path === custom.uri || customEditorTabInfo(tab.path)?.uri === custom.uri),
              ),
            );
            if (!stillOpen) {
              docs.current.delete(custom.uri);
              editorDirty.current.delete(custom.uri);
              extensionService.documentClosed(custom.uri);
            }
          }
          continue;
        }
        if (!isUntitled(path) && !isVirtualDocument(path)) {
          closedStack.current.push(path);
          void api()
            .request.lspClose({ path })
            .catch(() => {});
        }
        docs.current.delete(path);
        editorDirty.current.delete(path);
        extensionService.documentClosed(path);
      }
      setDiagnostics((prev) => {
        if (!finished.some((path) => prev.has(path))) return prev;
        const next = new Map(prev);
        for (const path of finished) next.delete(path);
        return next;
      });

      // Remove the tabs; a group whose active editor closed shows its previous one.
      const reopen: { groupId: string; path: string }[] = [];
      updateGroups((prev) => {
        const next = { ...prev };
        for (const id of targets) {
          const group = prev[id];
          if (!group || !group.tabs.some((tab) => closing.has(tab.path))) continue;
          const tabs = group.tabs.filter((tab) => !closing.has(tab.path));
          let active = group.activePath;
          if (active && closing.has(active)) {
            active = mru.current.find((path) => tabs.some((tab) => tab.path === path)) ?? tabs[tabs.length - 1]?.path ?? null;
            if (active) reopen.push({ groupId: id, path: active });
          }
          next[id] = { ...group, tabs, activePath: active && !reopen.some((r) => r.groupId === id) ? active : null };
        }
        return next;
      });
      for (const { groupId: id, path } of reopen) void openFile(path, { recordNav: false, groupId: id });
      for (const id of targets) pruneGroup(id);
      if (!activePathRef.current) {
        setActiveLanguage(null);
        setSymbols(null);
        setCursor(null);
      }
      syncDirtyState();
      return true;
    },
    [isDocDirty, openFile, saveDoc, syncDirtyState, updateGroups, pruneGroup, activePathRef],
  );

  /**
   * Apply a multi-file edit (rename symbol, workspace.applyEdit, …) to open
   * documents and files on disk. A lone snippet edit for the document in the
   * active editor is inserted as a snippet (tab stops); other snippets become text.
   */
  const applyWorkspaceEdits = useCallback(
    async (fileEdits: FileEdits[]) => {
      let changed = 0;
      for (const { path, edits: given, eol } of fileEdits) {
        const openPath = [...docs.current.keys()].find((p) => sameDocumentKey(p, path));
        if (openPath && eol) docs.current.get(openPath)!.eol = eol;
        const active = editorRef.current;
        if (openPath && given.length === 1 && given[0]!.snippet && active?.getCurrent()?.path === openPath) {
          if (active.insertSnippet(given[0]!.newText, [given[0]!])) changed++;
          continue;
        }
        const edits = given.map((edit) => (edit.snippet ? { ...edit, newText: snippetToText(edit.newText), snippet: undefined } : edit));
        if (openPath && editorHolding(openPath)?.applyEditsToDocument(openPath, edits)) {
          changed++;
          continue;
        }
        if (openPath) {
          const doc = docs.current.get(openPath)!;
          doc.content = applyTextEdits(doc.content, edits);
          editorDirty.current.set(openPath, doc.content !== doc.savedContent);
          extensionService.documentChanged(openPath);
          changed++;
          continue;
        }
        const file = await readDocument(path);
        if ("error" in file) continue;
        const crlf = eol ? eol === "CRLF" : file.content.includes("\r\n");
        let text = applyTextEdits(file.content.replace(/\r\n/g, "\n"), edits);
        if (crlf) text = text.replace(/\n/g, "\r\n");
        const result = await writeDocument(path, text, { encoding: file.encoding });
        if (result.success) changed++;
      }
      return changed;
    },
    [editorRef],
  );

  /** Replace in Files for the files open in editors: undoable edits that stay unsaved, as in VS Code. */
  const replaceInOpenDocuments = useCallback(
    async (paths: string[], query: string, replacement: string, options: SearchOptions) => {
      const matcher = buildMatcher(query, options);
      const handled: string[] = [];
      const fileEdits: FileEdits[] = [];
      let replacements = 0;
      for (const path of paths) {
        const openPath = [...docs.current.keys()].find((p) => sameDocumentKey(p, path));
        if (!openPath) continue;
        handled.push(path);
        const edits = replacementEdits(docContent(openPath) ?? docs.current.get(openPath)!.content, matcher, replacement, !!options.regex);
        if (!edits.length) continue;
        fileEdits.push({ path: openPath, edits });
        replacements += edits.length;
      }
      if (fileEdits.length) await applyWorkspaceEdits(fileEdits);
      for (const { path } of fileEdits) refreshTabDirty(path);
      syncDirtyState();
      return { paths: handled, files: fileEdits.length, replacements };
    },
    [applyWorkspaceEdits, docContent, refreshTabDirty, syncDirtyState],
  );

  /* ── workspace ────────────────────────────────────────────────────────── */

  const refreshGit = useCallback(async () => {
    const root = workspaceRootRef.current;
    if (!root) {
      setGit(null);
      return;
    }
    try {
      setGit(await api().request.gitStatus({ root }));
    } catch {
      setGit(null);
    }
  }, []);

  const openWorkspace = useCallback(
    async (path: string) => {
      // A folder is open in one window at a time: the window that shows it comes to the front.
      if (lowerKey(path) !== lowerKey(workspaceRootRef.current ?? "")) {
        const { focused } = await api()
          .request.focusWorkspaceWindow({ path })
          .catch(() => ({ focused: false }));
        if (focused) return false;
      }
      const { error } = await api().request.readDir({ path, depth: 1 });
      if (error) {
        toast(t("Cannot open {0}: {1}", path, error), "error");
        return false;
      }
      const previousRoot = workspaceRootRef.current;
      const switching = !!previousRoot && lowerKey(previousRoot) !== lowerKey(path);
      if (switching) {
        // The old project's arrangement is already saved: don't overwrite it while it is torn down.
        restoringSession.current = true;
        if (!(await closeTabs(allTabPaths()))) {
          restoringSession.current = false;
          return false;
        }
        // Start from a single empty group; the new project's layout (if any) replaces it below.
        updateGroups(() => ({ [FIRST_GROUP]: { id: FIRST_GROUP, tabs: [], activePath: null } }));
        updateGrid(() => ({ type: "leaf", groupId: FIRST_GROUP }));
        activeGroupIdRef.current = FIRST_GROUP;
        setActiveGroupIdState(FIRST_GROUP);
        // Terminals belong to the project: the previous project's go away.
        terminalService.disposeAll();
      }
      // Read the saved arrangement before anything can overwrite it.
      const stored = await api()
        .request.workspaceStateGet({ root: path })
        .then((result) => result.state as WorkspaceState | null)
        .catch(() => null);
      const projectState = stored && stored.version === 1 ? stored : null;
      // Older versions kept the editors in localStorage.
      const session = projectState?.editors ?? loadEditorSession(path);
      restoringSession.current = true;
      workspaceRootRef.current = path;
      setWorkspaceRoot(path);
      await api().request.setWorkspace({ path });
      terminalService.setDefaultCwd(path);
      if (projectState?.layout) applyLayout(projectState.layout);
      const terminalIds = projectState?.terminals && !terminalService.getSnapshot().instances.length ? restoreTerminals(projectState.terminals) : [];
      /** Saved tab entry → current tab path (terminal placeholders → new terminal ids). */
      /** Saved webview panels → placeholder webviews (their extensions restore them once the host runs). */
      const webviewIds = new Map<number, string>();
      const resolveTab = (saved: string): string | null => {
        const webview = /^webview:#(\d+)$/.exec(saved);
        if (webview) {
          const index = Number(webview[1]);
          const entry = projectState?.webviews?.[index];
          if (!entry) return null;
          if (!webviewIds.has(index)) webviewIds.set(index, webviewService.createRestoring(entry));
          return webviewTabPath(webviewIds.get(index)!);
        }
        const match = /^terminal:#(\d+)$/.exec(saved);
        if (!match) return saved;
        const id = terminalIds[Number(match[1])];
        return id ? terminalTabPath(id) : null;
      };
      const tabInfo = (p: string): TabInfo => ({
        path: p,
        name: isTerminalTab(p)
          ? (terminalService.info(terminalIdOf(p))?.title ?? "terminal")
          : isWebviewTab(p)
            ? (webviewService.info(webviewIdOf(p))?.title ?? "webview")
            : basename(p),
        dirty: false,
        preview: false,
      });
      localStorage.setItem("lumen.lastWorkspace", path);
      addRecentFolder(path);
      setRecent(recentFolders());
      setTreeRefresh((n) => n + 1);
      void refreshGit();

      try {
        const savedGroups = session?.groups && session.grid ? session.groups : null;
        const hasLayout = !!savedGroups && (Object.keys(savedGroups).length > 1 || Object.values(savedGroups).some((g) => g.tabs.length));
        if ((session?.tabs.length || hasLayout) && !allTabPaths().length) {
          mru.current = session!.tabs.filter((p) => !p.startsWith("terminal:#") && !p.startsWith("webview:#"));
          const saved = savedGroups;
          if (saved && session!.grid) {
            // Restore the split layout: one group per saved group.
            const restoredGroups: Record<string, EditorGroupState> = {};
            for (const [id, group] of Object.entries(saved)) {
              group.tabs = group.tabs.map(resolveTab).filter((p): p is string => !!p);
              group.active = group.active ? resolveTab(group.active) : null;
              restoredGroups[id] = {
                id,
                tabs: group.tabs.map(tabInfo),
                activePath: null,
              };
              const n = Number(id.slice(1));
              if (n > groupSeq.current) groupSeq.current = n;
            }
            updateGroups(() => restoredGroups);
            updateGrid(() => session!.grid as GridNode);
            restoringTerminals.current = false;
            const first = leafIds(session!.grid as GridNode)[0] ?? FIRST_GROUP;
            activeGroupIdRef.current = session!.activeGroup && restoredGroups[session!.activeGroup] ? session!.activeGroup : first;
            setActiveGroupIdState(activeGroupIdRef.current);
            for (const [id, group] of Object.entries(saved)) {
              const active = group.active && group.tabs.includes(group.active) ? group.active : group.tabs[0];
              if (active) await openFile(active, { recordNav: false, groupId: id });
            }
            focusGroup(activeGroupIdRef.current);
          } else {
            const tabs = session!.tabs.filter((p) => !p.startsWith("terminal:#") && !p.startsWith("webview:#"));
            setTabs(tabs.map(tabInfo));
            const active = session!.active && tabs.includes(session!.active) ? session!.active : tabs[0];
            if (active) await openFile(active, { recordNav: false });
          }
        }
      } finally {
        restoringSession.current = false;
        restoringTerminals.current = false;
        setTerminalSyncTick((n) => n + 1);
      }
      return true;
    },
    [closeTabs, openFile, refreshGit, updateGroups, updateGrid, focusGroup, setTabs],
  );

  const pickFolder = useCallback(async () => {
    const { path } = await api().request.openFolder({});
    if (path) await openWorkspace(path);
  }, [openWorkspace]);

  const closeFolder = useCallback(async () => {
    if (!(await closeTabs(allTabPaths()))) return;
    workspaceRootRef.current = null;
    setWorkspaceRoot(null);
    setGit(null);
    localStorage.removeItem("lumen.lastWorkspace");
    await api().request.setWorkspace({ path: null });
  }, [closeTabs]);

  /* ── language features ────────────────────────────────────────────────── */

  const loadSymbols = useCallback(async (): Promise<DocumentSymbol[] | null> => {
    const editor = editorRef.current;
    const current = editor?.getCurrent();
    if (!editor || !current) return null;
    if (isTsFamily(current.language) && !isUntitled(current.path)) {
      try {
        await api().request.lspChange({ path: current.path, content: editor.getContent() });
        const { symbols: list } = await api().request.lspSymbols({ path: current.path });
        if (list) return list;
      } catch {
        /* fall back to patterns */
      }
    }
    const list = extractSymbols(current.language, editor.getContent());
    return list.length || ["markdown", "python", "rust", "go", "css", "yaml", "shell"].includes(current.language) ? list : null;
  }, [editorRef]);

  const revealSymbol = useCallback(
    (symbol: DocumentSymbol) => {
      pushNavigation();
      editorRef.current?.revealPosition(symbol.line, symbol.character);
    },
    [editorRef, pushNavigation],
  );

  /** Open a workspace symbol; its location is resolved first when the provider only reported the file. */
  const gotoWorkspaceSymbol = useCallback(
    async (symbol: HostWorkspaceSymbol) => {
      const location =
        symbol.line !== undefined
          ? { path: symbol.path, line: symbol.line, character: symbol.character ?? 0 }
          : await extensionService.call("resolveWorkspaceSymbol", symbol.id).catch(() => null);
      if (!location) return;
      await openFile(extensionService.viewPath(location.path), { line: location.line, character: location.character });
    },
    [openFile],
  );

  const goToReferences = useCallback(async () => {
    const editor = editorRef.current;
    const current = editor?.getCurrent();
    if (!editor || !current) return;
    if (!isTsFamily(current.language) || isUntitled(current.path)) {
      toast(t("References are available for TypeScript and JavaScript files."), "info");
      return;
    }
    await editor.syncLsp();
    const position = editor.getCursor();
    const word = editor.wordAtCursor();
    const { locations } = await api().request.lspReferences({ path: current.path, ...position });
    setReferences({ title: word || t("symbol"), locations });
    setPanelTab("references");
    setPanelVisible(true);
  }, [editorRef]);

  const renameSymbol = useCallback(async () => {
    const editor = editorRef.current;
    const current = editor?.getCurrent();
    if (!editor || !current) return;
    // The built-in language service handles TypeScript/JavaScript files; an
    // extension rename provider may handle anything else (or be the fallback).
    const builtIn = isTsFamily(current.language) && !isUntitled(current.path);
    const hasExtension = extensionService.providersFor("rename", current.path, current.language).length > 0;
    if (!builtIn && !hasExtension) {
      toast(t("Rename Symbol is available for TypeScript and JavaScript files."), "info");
      return;
    }
    const position = editor.getCursor();
    // The provider says what to rename (prepareRename); otherwise the word under the cursor.
    let oldName = editor.wordAtCursor();
    if (!builtIn && hasExtension) {
      const prepared = await extensionService.call("prepareRename", current.path, position.line, position.character).catch(() => null);
      if (prepared && "error" in prepared) {
        toast(prepared.error, "error");
        return;
      }
      if (prepared) oldName = prepared.placeholder;
    }
    const newName = await showPrompt({ title: t("Rename Symbol"), message: t("Rename “{0}” to:", oldName), defaultValue: oldName });
    editor.focus();
    if (!newName || newName === oldName) return;

    const applyRenameEdits = async (edits: FileEdits[]) => {
      const changed = await applyWorkspaceEdits(edits);
      for (const { path } of edits) {
        const open = [...docs.current.keys()].find((p) => sameDocumentKey(p, path));
        if (open) refreshTabDirty(open);
      }
      syncDirtyState();
      toast(
        t(
          "Renamed {0} occurrence(s) in {1} file(s)",
          edits.reduce((n, f) => n + f.edits.length, 0),
          changed,
        ),
        "success",
      );
    };

    if (builtIn) {
      await editor.syncLsp();
      const { edits, error } = await api().request.lspRename({ path: current.path, ...position, newName });
      if (edits.length) {
        await applyRenameEdits(edits);
        return;
      }
      if (!hasExtension) {
        toast(error ?? t("No rename result for “{0}”.", oldName), error ? "error" : "info");
        return;
      }
    }

    const result = await extensionService.call("provideRenameEdits", current.path, position.line, position.character, newName).catch(() => null);
    if (!result) {
      toast(t("The rename provider returned no edits."), "info");
      return;
    }
    if ("error" in result) {
      toast(result.error, "error");
      return;
    }
    await applyRenameEdits(result.edits);
  }, [applyWorkspaceEdits, refreshTabDirty, syncDirtyState, editorRef]);

  const formatDocument = useCallback(async () => {
    const editor = editorRef.current;
    const current = editor?.getCurrent();
    if (!editor || !current) return;
    if (!editor.canFormat()) {
      toast(t("There is no formatter for '{0}' files.", languageLabel(current.language)), "info");
      return;
    }
    const ok = await editor.format().catch(() => false);
    if (!ok) toast(t("Formatting failed (is the document valid?)"), "error");
  }, [editorRef]);

  const navigate = useCallback(
    async (direction: "back" | "forward") => {
      const from = direction === "back" ? navBack.current : navForward.current;
      const to = direction === "back" ? navForward.current : navBack.current;
      const target = from.pop();
      if (!target) return;
      const here = currentLocation();
      if (here) to.push(here);
      await openFile(target.path, { line: target.line, character: target.character, recordNav: false });
    },
    [openFile, currentLocation],
  );

  const diagnosticsRef = useRef(allDiagnostics);
  diagnosticsRef.current = allDiagnostics;

  const gotoProblem = useCallback(
    (step: 1 | -1) => {
      const editor = editorRef.current;
      const current = editor?.getCurrent();
      const all = diagnosticsRef.current;
      if (editor && current && (all.get(current.path)?.length ?? 0) > 0) {
        editor.run(step === 1 ? "nextProblem" : "previousProblem");
        return;
      }
      const next = [...all].find(([, list]) => list.some((d) => d.severity === "error" || d.severity === "warning"));
      if (next) {
        const first = next[1].find((d) => d.severity === "error" || d.severity === "warning")!;
        void openFile(next[0], { line: first.startLine, character: first.startCharacter });
      }
    },
    [openFile, editorRef],
  );

  /* ── pickers ──────────────────────────────────────────────────────────── */

  const pick = useCallback((placeholder: string, items: PickItem[], onPick: (id: string) => void, activeId?: string) => {
    setQuick({ kind: "pick", placeholder, items, onPick, activeId });
  }, []);

  const openRecentPicker = useCallback(() => {
    const folders = recentFolders();
    pick(
      t("Select a folder to open"),
      [
        ...folders.map((path) => ({ id: path, label: basename(path), description: path })),
        ...(folders.length ? [{ id: "__clear", label: t("Clear Recently Opened…") }] : []),
      ],
      (id) => {
        if (id === "__clear") {
          clearRecentFolders();
          setRecent([]);
          return;
        }
        void openWorkspace(id);
      },
    );
  }, [openWorkspace, pick]);

  const changeLanguagePicker = useCallback(() => {
    const editor = editorRef.current;
    const current = editor?.getCurrent();
    if (!editor || !current) return;
    pick(
      t("Select Language Mode"),
      Object.entries(allLanguageLabels())
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([id, label]) => ({ id, label, description: id === current.language ? t("({0}) - Configured Language", id) : `(${id})` })),
      (id) => {
        const doc = docs.current.get(current.path);
        if (doc) doc.language = id;
        editor.setLanguage(id);
        setActiveLanguage(id);
        extensionService.documentLanguageChanged(current.path);
      },
      current.language,
    );
  }, [pick, editorRef]);

  /** Indentation of the active file (with Detect Indentation on), else the editor.* settings. */
  const indentationPicker = useCallback(() => {
    const s = getSettings();
    const editor = editorRef.current;
    const path = editor?.getCurrent()?.path ?? null;
    const current = indentationFor(path, s);
    pick(
      t("Select Action"),
      [
        { id: "spaces", label: t("Indent Using Spaces"), description: current.insertSpaces ? t("(current)") : "" },
        { id: "tabs", label: t("Indent Using Tabs"), description: !current.insertSpaces ? t("(current)") : "" },
        ...[1, 2, 3, 4, 6, 8].map((n) => ({ id: `size:${n}`, label: t("Tab Size: {0}", n), description: current.tabSize === n ? t("(current)") : "" })),
      ],
      (id) => {
        const next =
          id === "spaces"
            ? { ...current, insertSpaces: true }
            : id === "tabs"
              ? { ...current, insertSpaces: false }
              : { ...current, tabSize: Number(id.slice(5)) };
        if (path && s["editor.detectIndentation"]) {
          setDocumentIndentation(path, next);
          editor?.refreshIndentation();
          setCursor((c) => (c ? { ...c } : c));
        } else {
          updateSetting("editor.insertSpaces", next.insertSpaces);
          updateSetting("editor.tabSize", next.tabSize);
        }
      },
    );
  }, [pick, editorRef]);

  /** Configure Display Language: sets `locale`; the window offers a reload (lib/i18n.ts). */
  const displayLanguagePicker = useCallback(() => {
    const configured = getSettings().locale;
    pick(
      t("Select Display Language"),
      ["auto", ...DISPLAY_LANGUAGES.map((language) => language.id)].map((id) => ({
        id,
        label: localeLabel(id),
        description: id === configured ? t("(current)") : "",
      })),
      (id) => updateSetting("locale", id as ReturnType<typeof getSettings>["locale"]),
      configured,
    );
  }, [pick]);

  /** Preferences: Color Theme — the highlighted theme is previewed; Escape goes back to the configured one. */
  const colorThemePicker = useCallback(async () => {
    const themes = await listColorThemes();
    const current = getSettings()["workbench.colorTheme"] || DEFAULT_THEME_ID;
    const groups: [string, ColorThemeEntry[]][] = [
      [t("light themes"), themes.filter((theme) => theme.kind === "light")],
      [t("dark themes"), themes.filter((theme) => theme.kind === "dark")],
      [t("high contrast themes"), themes.filter((theme) => theme.kind === "hcDark" || theme.kind === "hcLight")],
    ];
    const items: PickItem[] = groups.flatMap(([title, list]) =>
      list.map((theme, index) => ({ id: theme.id, label: theme.label, separator: index === 0 ? title : undefined })),
    );
    setQuick({
      kind: "pick",
      placeholder: t("Select Color Theme (Up/Down Keys to Preview)"),
      items,
      activeId: themes.find((theme) => theme.id === current || theme.label === current)?.id,
      onActive: (id) => void showColorTheme(id),
      onPick: (id) => {
        updateSetting("workbench.colorTheme", id);
        void showColorTheme(id);
      },
      onCancel: () => void reloadConfiguredColorTheme(),
    });
  }, []);

  const eolPicker = useCallback(() => {
    const path = editorRef.current?.getCurrent()?.path;
    const doc = path ? docs.current.get(path) : null;
    if (!path || !doc) return;
    pick(
      t("Select End of Line Sequence"),
      [
        { id: "LF", label: "LF", description: doc.eol === "LF" ? t("(current)") : "" },
        { id: "CRLF", label: "CRLF", description: doc.eol === "CRLF" ? t("(current)") : "" },
      ],
      (id) => {
        doc.eol = id as DocState["eol"];
        refreshTabDirty(path);
        syncDirtyState();
        setCursor((c) => (c ? { ...c } : c));
      },
      doc.eol,
    );
  }, [pick, refreshTabDirty, syncDirtyState, editorRef]);

  /* ── git (source control) ─────────────────────────────────────────────── */

  const gitAction = useCallback(
    async (run: (root: string) => Promise<{ ok: boolean; error?: string }>) => {
      const root = workspaceRootRef.current;
      if (!root) return false;
      setGitBusy(true);
      try {
        const result = await run(root);
        if (!result.ok) toast(result.error ?? t("Git command failed"), "error");
        return result.ok;
      } finally {
        setGitBusy(false);
        void refreshGit();
      }
    },
    [refreshGit],
  );

  /**
   * A changed file in the diff editor, like VS Code: a staged change compares HEAD
   * with the index, an unstaged one the index with the working tree. A deleted
   * file opens its last version read-only.
   */
  const scmOpenChanges = useCallback(
    async (file: GitFileStatus, staged: boolean) => {
      const name = basename(file.path);
      if (staged) {
        if (file.index === "D") await openFile(gitUri(file.path, "HEAD"), { preview: true });
        else await openDiff(gitUri(file.path, "HEAD"), gitUri(file.path, ""), { title: t("{0} (Index)", name), preview: true });
        return;
      }
      if (file.worktree === "D") await openFile(gitUri(file.path, ""), { preview: true });
      else await openDiff(gitUri(file.path, ""), file.path, { title: t("{0} (Working Tree)", name), preview: true });
    },
    [openFile, openDiff],
  );

  /** Fetch, pull, push or sync: one at a time, shown on the status bar's sync button. */
  const [gitSyncing, setGitSyncing] = useState(false);
  const gitSyncingRef = useRef(false);
  const gitRemoteAction = useCallback(
    async (kind: "fetch" | "pull" | "push" | "sync", options: { quiet?: boolean } = {}) => {
      const root = workspaceRootRef.current;
      if (!root || gitSyncingRef.current) return false;
      gitSyncingRef.current = true;
      setGitSyncing(true);
      try {
        const request = { fetch: api().request.gitFetch, pull: api().request.gitPull, push: api().request.gitPush, sync: api().request.gitSync }[kind];
        const result = await request({ root });
        if (!result.ok && !options.quiet) toast(result.error ?? t("Git command failed"), "error");
        return result.ok;
      } finally {
        gitSyncingRef.current = false;
        setGitSyncing(false);
        void refreshGit();
        const current = editorRef.current?.getCurrent()?.path;
        if (current) void loadGitBase(current);
      }
    },
    [refreshGit, loadGitBase, editorRef],
  );

  // git.autofetch: every 3 minutes while a repository with a remote is open.
  const autofetch = settings["git.autofetch"] && !!git?.hasRemote;
  useEffect(() => {
    if (!autofetch) return;
    const timer = setInterval(() => void gitRemoteAction("fetch", { quiet: true }), 3 * 60 * 1000);
    return () => clearInterval(timer);
  }, [autofetch, gitRemoteAction]);

  const createBranch = useCallback(
    async (from?: string) => {
      const name = await showPrompt({
        title: t("Create Branch"),
        message: from ? t("New branch name (from {0}):", from) : t("New branch name:"),
        placeholder: t("Branch name"),
      });
      if (!name?.trim()) return;
      await gitAction((root) => api().request.gitCreateBranch({ root, name: name.trim().replace(/\s+/g, "-"), from }));
    },
    [gitAction],
  );

  const refPickItems = useCallback((refs: GitRef[]): PickItem[] => {
    const separators: Record<GitRef["type"], string> = { head: t("Branches"), remote: t("Remote Branches"), tag: t("Tags") };
    const icons: Record<GitRef["type"], React.ReactNode> = { head: <GitBranch size={14} />, remote: <Cloud size={14} />, tag: <Tag size={14} /> };
    const items: PickItem[] = [];
    for (const type of ["head", "remote", "tag"] as const) {
      refs
        .filter((ref) => ref.type === type)
        .forEach((ref, index) => {
          items.push({
            id: `${type}:${ref.name}`,
            label: ref.name,
            description: [ref.current ? t("current") : "", ref.commit, ref.date ? relativeTime(ref.date) : ""].filter(Boolean).join(" · "),
            detail: ref.subject,
            icon: icons[type],
            separator: index === 0 ? separators[type] : undefined,
          });
        });
    }
    return items;
  }, []);

  /** Git: Checkout to... (the status bar's branch). */
  const checkoutPicker = useCallback(async () => {
    const root = workspaceRootRef.current;
    if (!root) return;
    const { refs } = await api().request.gitRefs({ root });
    pick(
      t("Select a ref to checkout"),
      [
        { id: "__create", label: t("Create new branch..."), icon: <Plus size={14} /> },
        { id: "__createFrom", label: t("Create new branch from..."), icon: <Plus size={14} /> },
        ...refPickItems(refs.filter((ref) => !ref.current)),
      ],
      (id) => {
        if (id === "__create") return void createBranch();
        if (id === "__createFrom") {
          pick(t("Select a ref to create the branch from"), refPickItems(refs), (from) => void createBranch(from.slice(from.indexOf(":") + 1)));
          return;
        }
        const type = id.slice(0, id.indexOf(":")) as GitRef["type"];
        void gitAction((root) => api().request.gitCheckout({ root, ref: id.slice(id.indexOf(":") + 1), type }));
      },
    );
  }, [pick, refPickItems, createBranch, gitAction]);

  /** Git: Delete Branch... (local branches; unmerged ones after a confirmation). */
  const deleteBranchPicker = useCallback(async () => {
    const root = workspaceRootRef.current;
    if (!root) return;
    const { refs } = await api().request.gitRefs({ root });
    const branches = refs.filter((ref) => ref.type === "head" && !ref.current);
    if (!branches.length) return toast(t("There are no other branches to delete."), "info");
    pick(t("Select a branch to delete"), refPickItems(branches), (id) => {
      const name = id.slice(id.indexOf(":") + 1);
      void (async () => {
        const result = await api().request.gitDeleteBranch({ root, name });
        if (result.ok) return void refreshGit();
        if (!result.notMerged) return toast(result.error ?? t("Git command failed"), "error");
        const choice = await showDialog({
          title: t("Delete Branch"),
          message: t("The branch “{0}” is not fully merged. Delete anyway?", name),
          detail: t("Its commits that no other branch has will be lost."),
          buttons: [
            { label: t("Delete Branch"), role: "danger", value: "delete" },
            { label: t("Cancel"), role: "default", value: "cancel" },
          ],
        });
        if (choice === "delete") await gitAction((root) => api().request.gitDeleteBranch({ root, name, force: true }));
      })();
    });
  }, [pick, refPickItems, gitAction, refreshGit]);

  /* history */

  const loadGitLog = useCallback(async (skip: number, limit: number) => {
    const root = workspaceRootRef.current;
    if (!root) return [];
    return (await api().request.gitLog({ root, skip, limit })).commits;
  }, []);

  const loadCommitFiles = useCallback(async (commit: GitCommitInfo) => {
    const root = workspaceRootRef.current;
    if (!root) return [];
    return (await api().request.gitCommitFiles({ root, hash: commit.hash })).files;
  }, []);

  /** What a commit changed in a file: its first parent's version ↔ the commit's. */
  const openCommitChange = useCallback(
    (commit: { hash: string; shortHash: string }, path: string, oldPath?: string) =>
      openDiff(gitUri(oldPath ?? path, `${commit.hash}^`), gitUri(path, commit.hash), {
        title: t("{0} ({1})", basename(path), commit.shortHash),
        preview: true,
      }),
    [openDiff],
  );

  /** Git: View File History: the commits that changed the active file; one opens its change. */
  const fileHistoryPicker = useCallback(async () => {
    const root = workspaceRootRef.current;
    const path = editorRef.current?.getCurrent()?.path;
    if (!root || !path || isUntitled(path) || isVirtualDocument(path)) return;
    const { commits } = await api().request.gitLog({ root, path, limit: 200 });
    if (!commits.length) return toast(t("This file is not tracked by git."), "info");
    pick(
      t("History of {0}", basename(path)),
      commits.map((commit) => ({
        id: commit.hash,
        label: commit.subject,
        description: `${commit.shortHash} · ${commit.author} · ${relativeTime(commit.date)}`,
        icon: <GitCommitHorizontal size={14} />,
      })),
      (hash) => {
        const commit = commits.find((candidate) => candidate.hash === hash)!;
        // --follow: an older commit may know the file under its former name.
        void loadCommitFiles(commit).then((files) => {
          const file =
            files.find((candidate) => lowerKey(candidate.path) === lowerKey(path)) ?? files.find((candidate) => basename(candidate.path) === basename(path));
          void openCommitChange(commit, file?.path ?? path, file?.oldPath);
        });
      },
    );
  }, [editorRef, pick, loadCommitFiles, openCommitChange]);

  /* blame */

  /** Blame the document (its unsaved text when dirty) for the cursor line's author (git-blame.ts). */
  const loadBlame = useCallback(
    async (path: string) => {
      const root = workspaceRootRef.current;
      const s = getSettings();
      const doc = docs.current.get(path);
      if (!root || !doc || isUntitled(path) || isVirtualDocument(path)) return;
      if (!s["git.blame.editorDecoration.enabled"] && !s["git.blame.statusBarItem.enabled"]) return;
      const text = isDocDirty(path) ? (docContent(path) ?? doc.content) : undefined;
      try {
        // In the file's own line endings: git compares them with the committed text.
        const content = text !== undefined && doc.eol === "CRLF" ? text.replace(/\n/g, "\r\n") : text;
        const { blame } = await api().request.gitBlame({ root, path, content });
        // Edited meanwhile: the next blame is on its way.
        if ((isDocDirty(path) ? (docContent(path) ?? doc.content) : undefined) !== text) return;
        for (const editor of editors.current.values()) editor.setBlame(path, blame);
      } catch {
        /* not a repository */
      }
    },
    [docContent, isDocDirty],
  );
  const loadBlameRef = useRef(loadBlame);
  loadBlameRef.current = loadBlame;

  // Blame the active document again when it changes, or the repository does (a commit, a checkout).
  const blameEnabled = settings["git.blame.editorDecoration.enabled"] || settings["git.blame.statusBarItem.enabled"];
  useEffect(() => {
    if (blameEnabled && activePath && git?.isRepo) void loadBlame(activePath);
  }, [activePath, git, blameEnabled, loadBlame]);

  /** Git: Toggle Line Blame (the decoration after the cursor's line). */
  const toggleLineBlame = useCallback(() => {
    const enabled = !getSettings()["git.blame.editorDecoration.enabled"];
    updateSetting("git.blame.editorDecoration.enabled", enabled);
    // Blaming again redraws the decoration with the new setting.
    const path = editorRef.current?.getCurrent()?.path;
    if (path) void loadBlame(path);
  }, [editorRef, loadBlame]);

  const toggleInlineDiff = useCallback(async () => {
    const editor = editorRef.current;
    const current = editor?.getCurrent();
    const root = workspaceRootRef.current;
    if (!editor || !current || !root) return;
    if (editor.isInlineDiffShown()) {
      editor.showInlineDiff(null);
      return;
    }
    const { content } = await api().request.gitShowHead({ root, path: current.path });
    if (content === null) toast(t("This file is not tracked by git."), "info");
    else editor.showInlineDiff(content);
  }, [editorRef]);

  /* ── views ────────────────────────────────────────────────────────────── */

  const showView = useCallback((view: SideView) => {
    setSideView(view);
    setSidebarVisible(true);
    setZenMode(false);
  }, []);

  const showPanel = useCallback(
    (tab: PanelTab, toggle = false) => {
      const { panelVisible: visible, panelTab: current } = stateRef.current;
      if (toggle && visible && current === tab) {
        setPanelVisible(false);
        editorRef.current?.focus();
        return;
      }
      setPanelTab(tab);
      setPanelVisible(true);
      setZenMode(false);
      if (tab === "terminal") {
        // Opening the terminal panel with no terminal creates one (like VS Code).
        if (!terminalService.getSnapshot().groups.length) createTerminal();
        else terminalService.focus(terminalService.getSnapshot().activeId);
      }
    },
    [editorRef],
  );

  const focusSearch = useCallback(
    (replace = false) => {
      showView("search");
      setSearchSeed(editorRef.current?.hasFocus() ? (editorRef.current.selectedText().split("\n")[0] ?? "") : "");
      setSearchFocus((n) => n + 1);
      if (replace) setSearchReplace((n) => n + 1);
    },
    [showView, editorRef],
  );

  /** New file / folder through a prompt (explorer and File menu). */
  const createEntry = useCallback(
    async (kind: "file" | "folder", dir: string) => {
      const name = await showPrompt({
        title: kind === "file" ? t("New File") : t("New Folder"),
        message: kind === "file" ? t("Create file in {0}", basename(dir)) : t("Create folder in {0}", basename(dir)),
        placeholder: kind === "file" ? t("filename.ts (use / for sub folders)") : t("folder-name"),
      });
      if (!name?.trim()) return;
      const full = joinPath(dir, name.trim());
      // Extensions may adjust other files first (workspace.onWillCreateFiles).
      const willEdits = await extensionService.willFileOperation("create", [{ path: full }]);
      if (willEdits.length) await applyWorkspaceEdits(willEdits);
      const virtual = isVirtualDocument(full);
      const result = !virtual
        ? kind === "file"
          ? await api().request.createFile({ path: full, content: "" })
          : await api().request.createDir({ path: full })
        : kind === "file"
          ? await extensionService.call("providerCreateFile", full, "")
          : await extensionService.call("providerCreateDirectory", full);
      if (!result.success) {
        toast(result.error ?? (kind === "file" ? t("Failed to create file") : t("Failed to create folder")), "error");
        return;
      }
      extensionService.didFileOperation("create", [{ path: full }]);
      setTreeRefresh((n) => n + 1);
      if (kind === "file") await openFile(full);
      else setTreeReveal({ path: full, token: Date.now() });
    },
    [openFile, applyWorkspaceEdits],
  );

  /* ── terminals & panel docking ────────────────────────────────────────── */

  /** Create a terminal in the panel (optionally split) or in the editor area. */
  function createTerminal(options: { profileId?: string; splitWith?: string; location?: "panel" | "editor"; cwd?: string } = {}) {
    const profileId = options.profileId ?? (getSettings()["terminal.integrated.defaultProfile"] || undefined);
    const id = terminalService.create({ ...options, profileId });
    if (options.location !== "editor") terminalService.focus(id);
    return id;
  }

  function newTerminal(options: { profileId?: string; splitWith?: string; location?: "panel" | "editor"; cwd?: string } = {}) {
    if (options.location !== "editor") {
      setPanelTab("terminal");
      setPanelVisible(true);
      setZenMode(false);
    }
    return createTerminal(options);
  }

  function pickProfile(onPick: (profileId: string) => void) {
    void api()
      .request.terminalProfiles({})
      .then(({ profiles: shellProfiles }) => {
        const profiles = [...shellProfiles, ...terminalService.extensionProfiles()];
        const current = getSettings()["terminal.integrated.defaultProfile"] || profiles[0]?.id;
        setQuick({
          kind: "pick",
          placeholder: t("Select a terminal profile"),
          items: profiles.map((profile) => ({ id: profile.id, label: profile.name, description: profile.id === current ? t("default") : "" })),
          onPick,
          activeId: current,
        });
      });
  }

  /** Apply a project's saved sidebar / panel arrangement. */
  function applyLayout(layout: Partial<Layout>) {
    if (layout.sidebarVisible !== undefined) setSidebarVisible(layout.sidebarVisible);
    if (layout.sidebarWidth) setSidebarWidth(layout.sidebarWidth);
    if (layout.explorerViewsHeight !== undefined) setExplorerViewsHeight(layout.explorerViewsHeight);
    if (layout.auxBarVisible !== undefined) setAuxBarVisible(layout.auxBarVisible);
    if (layout.auxBarWidth) setAuxBarWidth(layout.auxBarWidth);
    if (layout.auxBarView !== undefined) setAuxBarView(layout.auxBarView);
    if (layout.sideView) setSideView(layout.sideView);
    if (layout.panelVisible !== undefined) setPanelVisible(layout.panelVisible);
    if (layout.panelHeight) setPanelHeight(layout.panelHeight);
    if (layout.panelWidth) setPanelWidth(layout.panelWidth);
    if (layout.panelPosition) setPanelPosition(layout.panelPosition);
    if (layout.panelTab) setPanelTab(layout.panelTab);
    setPanelMaximized(false);
  }

  /**
   * Recreate a project's terminals where they were: panel split groups and
   * editor-area terminals (shells start when first shown). Returns the new id
   * for each saved index.
   */
  function restoreTerminals(saved: WorkspaceState["terminals"]): string[] {
    restoringTerminals.current = true;
    const ids: string[] = [];
    const options = (index: number) => {
      const terminal = saved.list[index] ?? {};
      return { profileId: terminal.profileId, cwd: terminal.cwd, title: terminal.title, initialTitle: terminal.name };
    };
    for (const group of saved.panelGroups) {
      let previous: string | undefined;
      for (const index of group) {
        if (!saved.list[index] || ids[index]) continue;
        ids[index] = terminalService.create({ ...options(index), location: "panel", splitWith: previous });
        previous = ids[index];
      }
    }
    // The rest lived in the editor area.
    saved.list.forEach((_, index) => {
      if (!ids[index]) ids[index] = terminalService.create({ ...options(index), location: "editor" });
    });
    if (saved.activePanel !== null && ids[saved.activePanel]) terminalService.setActive(ids[saved.activePanel]!);
    return ids;
  }

  /** The terminal panel is not left empty: hide it once its last terminal is gone. */
  function hidePanelIfNoTerminals() {
    if (!terminalService.getSnapshot().groups.length && stateRef.current.panelTab === "terminal") setPanelVisible(false);
  }

  function moveTerminalToPanel(id: string) {
    terminalService.moveToPanel(id);
    setPanelTab("terminal");
    setPanelVisible(true);
    terminalService.focus(id);
  }

  function movePanel(position: PanelPosition) {
    setPanelPosition(position);
    setPanelVisible(true);
    setPanelMaximized(false);
  }

  function terminalAction(action: TerminalMenuAction, id: string) {
    switch (action) {
      case "split":
        newTerminal({ splitWith: id || undefined });
        break;
      case "unsplit":
        terminalService.unsplit(id);
        break;
      case "move-to-editor":
        terminalService.moveToEditor(id);
        hidePanelIfNoTerminals();
        break;
      case "relaunch":
        void terminalService.relaunch(id);
        break;
      case "kill": {
        const path = terminalTabPath(id);
        if (allTabPaths().includes(path)) void act.current.closeTabs([path]);
        else {
          terminalService.kill(id);
          hidePanelIfNoTerminals();
        }
        break;
      }
      case "history":
        void showTerminalHistory(id);
        break;
      case "rename":
        void showPrompt({ title: t("Rename Terminal"), message: t("Enter a name for the terminal"), defaultValue: terminalService.info(id)?.title ?? "" }).then(
          (name) => {
            if (name) terminalService.rename(id, name);
            terminalService.focus(id);
          },
        );
        break;
    }
  }

  /* ── extensions ───────────────────────────────────────────────────────── */

  const refreshExtensions = useCallback(async () => {
    try {
      const { extensions } = await api().request.extensionsList({});
      setInstalledExtensions(extensions);
      // Keep an open details page in step with the new state.
      setExtensionTarget((target) => {
        const id = target?.installed?.id ?? (target?.marketplace ? `${target.marketplace.namespace}.${target.marketplace.name}` : null);
        if (!target || !id) return target;
        return { ...target, installed: extensions.find((extension) => extension.id.toLowerCase() === id.toLowerCase()) };
      });
    } catch {
      /* the main process is shutting down */
    }
  }, []);

  /** Tell the user how an install went (VS Code extensions: with their compatibility). */
  const reportInstall = useCallback((result: { extension?: ExtensionDescription; cancelled?: boolean; error?: string }) => {
    if (result.cancelled) return;
    if (result.error || !result.extension) {
      toast(t("Installing the extension failed: {0}", result.error ?? t("unknown error")), "error");
      return;
    }
    const extension = result.extension;
    const name = extension.manifest.displayName ?? extension.manifest.name;
    const level = extension.compat?.level;
    if (extension.kind === "vscode" && level && level !== "full") {
      const grade = compatGrade(extension.compat);
      void notify(
        grade === "unsupported" || grade === "limited" || grade === "low" ? "warning" : "info",
        t("{0} was converted from a VS Code extension. Compatibility: {1} — {2}", name, COMPAT_GRADES[grade].label.toLowerCase(), COMPAT_GRADES[grade].text),
        [t("Show Compatibility")],
        t("Extensions"),
      ).then((choice) => {
        if (choice === 0) setExtensionTarget({ installed: extension });
      });
    } else
      toast(
        extension.kind === "vscode"
          ? t("Installed {0} {1} (converted from VS Code)", name, extension.manifest.version)
          : t("Installed {0} {1}", name, extension.manifest.version),
        "success",
      );
  }, []);

  const installFromMarketplace = useCallback(
    async (entry: MarketplaceExtension) => {
      const id = `${entry.namespace}.${entry.name}`.toLowerCase();
      const current = installedExtensions.find(
        (extension) => extension.source?.type === "openvsx" && `${extension.source.namespace}.${extension.source.name}`.toLowerCase() === id,
      );
      const choice = await showDialog({
        title: current ? t("Update Extension") : t("Install Extension"),
        message: current
          ? t("Update “{0}” from {1} to {2}?", entry.displayName ?? entry.name, current.manifest.version, entry.version)
          : entry.verified
            ? t("Install “{0}” {1} by {2} (verified publisher)?", entry.displayName ?? entry.name, entry.version, entry.publisher ?? entry.namespace)
            : t("Install “{0}” {1} by {2}?", entry.displayName ?? entry.name, entry.version, entry.publisher ?? entry.namespace),
        detail: t(
          "Extensions run with the same access to your computer as Lumen. Only install extensions from publishers you trust.\nVS Code extensions are converted by the transpiler on the way in.",
        ),
        buttons: [
          { label: current ? t("Update") : t("Install"), role: "primary", value: "install" },
          { label: t("Cancel"), role: "default", value: "cancel" },
        ],
      });
      if (choice !== "install") return;
      setExtensionBusy((previous) => new Set(previous).add(id));
      try {
        reportInstall(await api().request.extensionsInstallMarketplace({ namespace: entry.namespace, name: entry.name }));
      } catch (error) {
        toast(t("Installing the extension failed: {0}", error instanceof Error ? error.message : error), "error");
      } finally {
        setExtensionBusy((previous) => {
          const next = new Set(previous);
          next.delete(id);
          return next;
        });
        void refreshExtensions();
      }
    },
    [installedExtensions, refreshExtensions, reportInstall],
  );

  const installExtension = useCallback(
    async (from: "vsix" | "folder") => {
      const result = from === "vsix" ? await api().request.extensionsInstallVsix({}) : await api().request.extensionsInstallFolder({});
      reportInstall(result);
      if (!result.cancelled) {
        void refreshExtensions();
        if (result.extension) setExtensionTarget({ installed: result.extension });
      }
    },
    [refreshExtensions, reportInstall],
  );

  const extensionAction = useCallback(
    async (action: ExtensionAction, extension: ExtensionDescription) => {
      const name = extension.manifest.displayName ?? extension.manifest.name;
      switch (action) {
        case "enable":
        case "disable":
          await api().request.extensionsSetEnabled({ id: extension.id, enabled: action === "enable" });
          toast(action === "enable" ? t("{0} enabled", name) : t("{0} disabled", name), "success");
          break;
        case "uninstall": {
          const choice = await showDialog({
            title: t("Uninstall Extension"),
            message: t("Uninstall “{0}”?", name),
            detail: extension.development ? t("The development folder itself stays on disk.") : t("Removes {0}.", extension.location),
            buttons: [
              { label: t("Uninstall"), role: "danger", value: "uninstall" },
              { label: t("Cancel"), role: "default", value: "cancel" },
            ],
          });
          if (choice !== "uninstall") return;
          const { ok } = await api().request.extensionsUninstall({ id: extension.id });
          if (ok) toast(t("Uninstalled {0}", name), "success");
          setExtensionTarget((target) => (target?.installed?.id === extension.id && !target.marketplace ? null : target));
          break;
        }
        case "details":
          setExtensionTarget({ installed: extension });
          return;
        case "copy-id":
          await navigator.clipboard.writeText(extension.id).catch(() => {});
          toast(t("Copied to clipboard"), "success");
          return;
        case "reveal":
          await api().request.showInFolder({ path: extension.location });
          return;
      }
      void refreshExtensions();
    },
    [refreshExtensions],
  );

  /** An untitled document under a name the extension host picked. */
  const openUntitledAt = useCallback(
    async (path: string, language: string, content: string) => {
      if (!docs.current.has(path)) {
        docs.current.set(path, { content, savedContent: "", language, eol: "LF", savedEol: "LF" });
        setTabs((prev) => [...prev, { path, name: path.replace(/^untitled:/, ""), dirty: content !== "", preview: false }]);
      }
      await openFile(path);
    },
    [openFile, setTabs],
  );

  /** Terminal: Show Full History: what the terminal printed (older output included) as a read-only untitled editor. */
  const showTerminalHistory = useCallback(
    async (id: string) => {
      const content = terminalService.historyText(id);
      if (content === null) return;
      const path = `untitled:${t("History of {0}", terminalService.info(id)?.title ?? "terminal")}`;
      // Shown again, it has the output as it is now.
      if (docs.current.has(path)) await closeTabs([path]);
      docs.current.set(path, { content, savedContent: content, language: "plaintext", eol: "LF", savedEol: "LF", readOnly: true });
      setTabs((prev) => [...prev.filter((tab) => tab.path !== path), { path, name: path.replace(/^untitled:/, ""), dirty: false, preview: false }]);
      // The latest output is at the end.
      await openFile(path, { line: content.split("\n").length - 1 });
    },
    [closeTabs, openFile, setTabs],
  );

  const setDocumentLanguage = useCallback(
    (path: string, language: string) => {
      const doc = docs.current.get(path);
      if (!doc) return;
      doc.language = language;
      for (const editor of editors.current.values()) if (editor.getCurrent()?.path === path) editor.setLanguage(language);
      if (activePathRef.current === path) setActiveLanguage(language);
      extensionService.documentLanguageChanged(path);
    },
    [activePathRef],
  );

  /** Revert a file to what is on disk (workbench.action.files.revert). */
  const revertDocument = useCallback(async (path: string, encoding?: string) => {
    const doc = docs.current.get(path);
    const result = await readDocument(path, encoding ?? doc?.encoding);
    if ("error" in result) {
      toast(result.error, "error");
      return;
    }
    const { content, eol, version } = loadedDocState(result);
    if (doc) Object.assign(doc, { content, savedContent: content, eol, savedEol: eol, version, encoding: result.encoding ?? doc.encoding });
    for (const editor of editors.current.values()) if (editor.hasDocument(path)) editor.reloadDocument(path, content);
    extensionService.documentChanged(path);
    setCursor((c) => (c ? { ...c } : c));
  }, []);

  /** Reopen or save the active file in another encoding (the status bar's encoding item). */
  const encodingPicker = useCallback(() => {
    const path = editorRef.current?.getCurrent()?.path;
    const doc = path ? docs.current.get(path) : null;
    if (!path || !doc || isVirtualDocument(path)) return;
    const current = doc.encoding ?? "utf8";
    const actions = [...(isUntitled(path) ? [] : [{ id: "reopen", label: t("Reopen with Encoding") }]), { id: "save", label: t("Save with Encoding") }];
    pick(t("Select Action"), actions, (action) => {
      const encodings = FILE_ENCODINGS.map((encoding) => ({
        id: encoding.id,
        label: encoding.label,
        description: encoding.id === current ? t("(current)") : "",
      }));
      pick(
        action === "reopen" ? t("Reopen with Encoding") : t("Save with Encoding"),
        encodings,
        (id) => {
          if (action === "save") {
            doc.encoding = id;
            void saveDoc(path).then(() => setCursor((c) => (c ? { ...c } : c)));
          } else if (isDocDirty(path)) toast(t("Save or revert your changes before reopening the file in another encoding."), "info");
          else void revertDocument(path, id);
        },
        current,
      );
    });
  }, [pick, saveDoc, isDocDirty, revertDocument, editorRef]);

  /** Reopen the active file with another editor (Text Editor, or a matching custom editor). */
  const reopenWithEditor = useCallback(
    (path: string | null, groupId?: string) => {
      if (!path) return;
      const custom = customEditorTabInfo(path);
      const uri = custom?.uri ?? path;
      if (isUntitled(uri)) return;
      const choices = extensionService.customEditorsFor(uri, docs.current.get(uri)?.language);
      pick(
        t("Reopen Editor With…"),
        [
          { id: "default", label: t("Text Editor") },
          ...choices.map((choice) => ({ id: choice.viewType, label: choice.displayName, description: choice.priority === "option" ? t("option") : undefined })),
        ],
        (id) => {
          void (async () => {
            const group = groupId && groupsRef.current[groupId] ? groupId : activeGroupIdRef.current;
            const holders = allTabPaths().filter((tab) => tab === uri || customEditorTabInfo(tab)?.uri === uri);
            if (holders.length && !(await closeTabs(holders))) return;
            const opened = await openFile(uri, { groupId: group, viewType: id });
            if (!opened && id !== "default") toast(t("No custom editor handles {0}", basename(uri)), "info");
          })();
        },
      );
    },
    [pick, closeTabs, openFile],
  );

  const showExtensions = useCallback(() => {
    showView("extensions");
    setExtensionsFocus((n) => n + 1);
  }, [showView]);

  /** Show the secondary side bar (on one of its containers). */
  const showAuxBar = useCallback((containerId?: string) => {
    if (containerId) setAuxBarView(containerId);
    setAuxBarVisible(true);
    setZenMode(false);
  }, []);

  /** Show a contributed view container wherever it lives. */
  const showContainer = useCallback(
    (container: { id: string; location: "activitybar" | "secondarySidebar" | "panel" }) => {
      if (container.location === "panel") showPanel(`view:${container.id}`);
      else if (container.location === "secondarySidebar") showAuxBar(container.id);
      else showView(`view:${container.id}`);
    },
    [showView, showPanel, showAuxBar],
  );

  /** Show the container of a contributed view (activity bar, secondary side bar, panel or the Explorer). */
  const revealView = useCallback(
    (viewId: string) => {
      const { containers } = extensionService.viewContainers();
      const container = containers.find((candidate) => candidate.views.some((view) => view.id === viewId));
      if (!container) showView("explorer");
      else showContainer(container);
    },
    [showView, showContainer],
  );

  /* ── debugging ────────────────────────────────────────────────────────── */

  const [debugging, setDebugging] = useState(false);

  /** Debug adapters spell paths their own way (`c:\…` vs `C:\…`): reuse the open tab / workspace spelling. */
  const debugPath = (path: string) => {
    const open = allTabPaths().find((p) => samePath(p, path));
    if (open) return open;
    const root = workspaceRootRef.current;
    if (root && path.length > root.length && samePath(path.slice(0, root.length), root)) return root + path.slice(root.length);
    return path;
  };

  const revealDebugLocation = (path: string, line: number, column: number | undefined, preview: boolean) =>
    openFile(debugPath(path), { line: line - 1, character: Math.max(0, (column ?? 1) - 1), preview, focus: !preview });

  /** Start debugging (F5): continue when paused, else launch the selected configuration. */
  const startDebug = useCallback(
    async (options: { noDebug?: boolean; pick?: boolean; config?: HostDebugConfiguration | null } = {}) => {
      if (!options.noDebug && isStopped()) return void debugStep("continue");
      if (options.config) debugUi.selectConfig(options.config.name);
      await startDebugging(workspaceRootRef.current, editorRef.current?.getCurrent()?.language ?? null, {
        noDebug: options.noDebug,
        // "Select and Start Debugging": ask, then start again with the choice.
        pick: !options.pick
          ? undefined
          : async (configs) => {
              pick(
                t("Select a launch configuration"),
                configs.map((c) => ({ id: c.name, label: c.name, description: c.type })),
                (name) => {
                  debugUi.selectConfig(name);
                  void act.current.startDebug();
                },
              );
              return null;
            },
      });
    },
    [pick, editorRef],
  );

  /** Open .vscode/launch.json, creating it from the installed debuggers' initial configurations. */
  const openLaunchJson = useCallback(async () => {
    const root = workspaceRootRef.current;
    if (!root) {
      toast(t("Open a folder to create a launch.json file."), "error");
      return;
    }
    const dir = joinPath(root, ".vscode");
    const file = joinPath(dir, "launch.json");
    const existing = await api()
      .request.readFile({ path: file })
      .catch(() => ({ error: "unreadable" }));
    if ("error" in existing && existing.error === "File not found") {
      const language = editorRef.current?.getCurrent()?.language;
      const debuggers = debugService.debuggers();
      const chosen = debuggers.find((d) => language && d.languages?.includes(language)) ?? debuggers[0];
      const configurations = chosen?.initialConfigurations ?? [];
      await api()
        .request.createDir({ path: dir })
        .catch(() => {});
      await api().request.createFile({ path: file, content: `${JSON.stringify({ version: "0.2.0", configurations }, null, 2)}\n` });
    }
    await openFile(file);
  }, [openFile, editorRef]);

  // Reveal where the debugger stopped; show the debug view when a session starts.
  useEffect(() => {
    const offStopped = debugService.onStopped((stopped) => {
      if (stopped.path && stopped.line) void act.current.revealDebugLocation(stopped.path, stopped.line, stopped.column, false);
    });
    let wasLive = false;
    const offChange = debugService.subscribe(() => {
      const live = isDebugging();
      setDebugging(live);
      if (live && !wasLive) {
        act.current.showView("debug");
        act.current.showPanel("view:debug-console");
      }
      wasLive = live;
    });
    return () => {
      offStopped();
      offChange();
    };
  }, []);

  /* ── commands ─────────────────────────────────────────────────────────── */

  // Commands are created once and call through these refs, so they always see
  // the latest state without being rebuilt on every render.
  const actions = {
    openFile,
    openDiff,
    newUntitled,
    saveDoc,
    saveAll,
    closeTabs,
    pickFolder,
    openWorkspace,
    closeFolder,
    openRecentPicker,
    changeLanguagePicker,
    colorThemePicker,
    displayLanguagePicker,
    goToReferences,
    renameSymbol,
    formatDocument,
    navigate,
    gotoProblem,
    showView,
    showPanel,
    focusSearch,
    toggleInlineDiff,
    refreshGit,
    gitRemoteAction,
    checkoutPicker,
    createBranch,
    deleteBranchPicker,
    fileHistoryPicker,
    toggleLineBlame,
    scmOpenChanges,
    createEntry,
    newTerminal,
    pickProfile,
    terminalAction,
    moveTerminalToPanel,
    movePanel,
    splitEditor,
    moveEditorToGroup,
    joinAllGroups,
    closeGroup,
    closeModalEditor,
    moveModalEditorToEditorArea,
    openActiveEditorInModal,
    applyWorkspaceEdits,
    openUntitledAt,
    showTerminalHistory,
    setDocumentLanguage,
    revertDocument,
    reopenWithEditor,
    showExtensions,
    installExtension,
    revealView,
    showAuxBar,
    showContainer,
    startDebug,
    openLaunchJson,
    revealDebugLocation,
  };
  const act = useRef(actions);
  act.current = actions;
  const stateRef = useRef({ activePath, tabs, sidebarVisible, auxBarVisible, panelVisible, zenMode, panelTab, panelPosition, sideView });
  stateRef.current = { activePath, tabs, sidebarVisible, auxBarVisible, panelVisible, zenMode, panelTab, panelPosition, sideView };

  const commands = useMemo(() => {
    const a = () => act.current;
    const st = () => stateRef.current;
    const editor = () => editorRef.current;
    const ed = (command: Parameters<EditorController["run"]>[0]) => () => {
      editor()?.run(command);
      if (command !== "find" && command !== "replace") editor()?.focus();
    };
    const toggleSetting = (key: "editor.minimap.enabled" | "breadcrumbs.enabled" | "workbench.statusBar.visible" | "workbench.activityBar.visible") => () =>
      updateSetting(key, !getSettings()[key]);
    const hasEditor = () => !!editor()?.getCurrent() || !!customEditorTabInfo(st().activePath);
    const activeTabs = () => st().tabs;
    const activeIndex = () => st().tabs.findIndex((t) => t.path === st().activePath);
    const openAt = (index: number) => {
      const tab = activeTabs()[index];
      if (tab) void a().openFile(tab.path);
    };
    /** The terminal the user is working with: an editor-area terminal tab, else the panel's. */
    const activeTerminalId = () => {
      const path = st().activePath;
      if (isTerminalTab(path) && document.activeElement?.closest(".editor-host")) return terminalIdOf(path);
      return terminalService.getSnapshot().activeId ?? (isTerminalTab(path) ? terminalIdOf(path) : null);
    };
    const switcher = (backwards: boolean) => () => {
      if (mru.current.length > 1) setQuick({ kind: "editors", paths: [...mru.current], backwards });
    };

    const list: Command[] = [
      // Quick open & palette
      { id: "workbench.action.showCommands", title: "Show All Commands", run: () => setQuick({ kind: "quick", value: ">" }) },
      { id: "workbench.action.quickOpen", title: "Go to File…", run: () => setQuick({ kind: "quick", value: "" }) },
      { id: "workbench.action.gotoLine", title: "Go to Line/Column…", run: () => setQuick({ kind: "quick", value: ":" }) },
      { id: "workbench.action.gotoSymbol", title: "Go to Symbol in Editor…", run: () => setQuick({ kind: "quick", value: "@" }) },
      { id: "workbench.action.showAllSymbols", title: "Go to Symbol in Workspace…", run: () => setQuick({ kind: "quick", value: "#" }) },
      { id: "workbench.action.openRecent", title: "Open Recent…", category: "File", run: () => a().openRecentPicker() },
      { id: "workbench.action.quickOpenPreviousRecentlyUsedEditor", title: "Quick Open Previous Recently Used Editor", category: "View", run: switcher(false) },
      { id: "workbench.action.quickOpenLeastRecentlyUsedEditor", title: "Quick Open Least Recently Used Editor", category: "View", run: switcher(true) },
      // Files
      { id: "workbench.action.files.newUntitledFile", title: "New Untitled Text File", category: "File", run: () => a().newUntitled() },
      {
        id: "explorer.newFile",
        title: "New File…",
        category: "File",
        run: () => (workspaceRootRef.current ? a().createEntry("file", workspaceRootRef.current) : a().newUntitled()),
      },
      {
        id: "explorer.newFolder",
        title: "New Folder…",
        category: "File",
        enabled: () => !!workspaceRootRef.current,
        run: () => workspaceRootRef.current && a().createEntry("folder", workspaceRootRef.current),
      },
      {
        id: "workbench.action.files.openFile",
        title: "Open File…",
        category: "File",
        run: async () => {
          const { paths } = await api().request.openFileDialog({});
          for (const path of paths) await a().openFile(path);
        },
      },
      { id: "workbench.action.files.openFolder", title: "Open Folder…", category: "File", run: () => a().pickFolder() },
      { id: "workbench.action.newWindow", title: "New Window", category: "File", run: () => api().request.newWindow({}) },
      // vscode.openFolder / vscode.newWindow of extensions: a folder (or a pick) in this window or a new one.
      {
        id: "lumen.window.openFolder",
        title: "Open Folder in Window",
        category: "File",
        enabled: () => false,
        run: async (path?: unknown, newWindow?: unknown) => {
          const folder = typeof path === "string" && path ? path : (await api().request.openFolder({})).path;
          if (!folder) return;
          if (newWindow === true) await api().request.newWindow({ path: folder });
          else await a().openWorkspace(folder);
        },
      },
      // Used by workspace.updateWorkspaceFolders: the window follows the extension's first folder.
      {
        id: "lumen.workspace.openFolderPath",
        title: "Open Folder by Path",
        category: "File",
        enabled: () => false,
        run: (path?: unknown) => (typeof path === "string" && path ? a().openWorkspace(path) : undefined),
      },
      {
        id: "workbench.action.closeFolder",
        title: "Close Folder",
        category: "Workspaces",
        enabled: () => !!workspaceRootRef.current,
        run: () => a().closeFolder(),
      },
      { id: "workbench.action.files.save", title: "Save", category: "File", enabled: hasEditor, run: () => st().activePath && a().saveDoc(st().activePath!) },
      {
        id: "workbench.action.files.saveAs",
        title: "Save As…",
        category: "File",
        enabled: hasEditor,
        run: () => st().activePath && a().saveDoc(st().activePath!, { saveAs: true }),
      },
      {
        id: "workbench.action.files.saveAll",
        title: "Save All",
        category: "File",
        run: async () => {
          const saved = await a().saveAll();
          if (saved) toast(t("Saved {0} file(s)", saved), "success");
        },
      },
      {
        id: "workbench.action.files.revert",
        title: "Revert File",
        category: "File",
        enabled: () => !!st().activePath && !isUntitled(st().activePath!),
        run: async () => {
          const path = st().activePath;
          if (!path || isUntitled(path)) return;
          const custom = customEditorTabInfo(path);
          if (custom) {
            if (custom.kind === "editable") await extensionService.call("revertCustomEditor", custom.uri, custom.viewType).catch(() => false);
            else if (custom.kind === "text") await a().revertDocument(custom.uri);
            return;
          }
          await a().revertDocument(path);
        },
      },
      {
        id: "workbench.action.toggleAutoSave",
        title: "Toggle Auto Save",
        category: "File",
        checked: () => getSettings()["files.autoSave"] !== "off",
        run: () => updateSetting("files.autoSave", getSettings()["files.autoSave"] === "off" ? "afterDelay" : "off"),
      },
      {
        id: "workbench.action.reopenWithEditor",
        title: "Reopen Editor With…",
        category: "View",
        enabled: () => !!st().activePath && !isUntitled(st().activePath!),
        run: () => a().reopenWithEditor(st().activePath, activeGroupIdRef.current),
      },
      {
        id: "undo",
        title: "Undo",
        category: "Edit",
        enabled: () => customEditorTabInfo(st().activePath)?.kind === "editable",
        run: () => {
          const custom = customEditorTabInfo(st().activePath);
          if (custom?.kind === "editable") void extensionService.call("undoCustomEditor", custom.uri, custom.viewType).catch(() => false);
        },
      },
      {
        id: "redo",
        title: "Redo",
        category: "Edit",
        enabled: () => customEditorTabInfo(st().activePath)?.kind === "editable",
        run: () => {
          const custom = customEditorTabInfo(st().activePath);
          if (custom?.kind === "editable") void extensionService.call("redoCustomEditor", custom.uri, custom.viewType).catch(() => false);
        },
      },
      // Editors / tabs
      {
        id: "workbench.action.closeActiveEditor",
        title: "Close Editor",
        category: "View",
        enabled: () => !!st().activePath,
        run: () => st().activePath && a().closeTabs([st().activePath!], activeGroupIdRef.current),
      },
      { id: "workbench.action.closeAllEditors", title: "Close All Editors", category: "View", run: () => a().closeTabs(allTabPaths()) },
      {
        id: "workbench.action.closeEditorsInGroup",
        title: "Close All Editors in Group",
        category: "View",
        run: () =>
          a().closeTabs(
            activeTabs().map((t) => t.path),
            activeGroupIdRef.current,
          ),
      },
      { id: "workbench.action.splitEditor", title: "Split Editor Right", category: "View", run: () => a().splitEditor("right") },
      { id: "workbench.action.splitEditorDown", title: "Split Editor Down", category: "View", run: () => a().splitEditor("bottom") },
      { id: "workbench.action.splitEditorLeft", title: "Split Editor Left", category: "View", run: () => a().splitEditor("left") },
      { id: "workbench.action.splitEditorUp", title: "Split Editor Up", category: "View", run: () => a().splitEditor("top") },
      { id: "workbench.action.moveEditorToNextGroup", title: "Move Editor into Next Group", category: "View", run: () => a().moveEditorToGroup(1) },
      { id: "workbench.action.moveEditorToPreviousGroup", title: "Move Editor into Previous Group", category: "View", run: () => a().moveEditorToGroup(-1) },
      { id: "workbench.action.joinAllGroups", title: "Join All Editor Groups", category: "View", run: () => a().joinAllGroups() },
      { id: "workbench.action.openEditorInModal", title: "Open Active Editor in Modal", category: "View", run: () => a().openActiveEditorInModal() },
      {
        id: "workbench.action.closeModalEditor",
        title: "Close Modal Editor",
        category: "View",
        enabled: () => !!groupsRef.current[MODAL_GROUP],
        run: () => a().closeModalEditor(),
      },
      {
        id: "workbench.action.toggleModalEditorMaximized",
        title: "Toggle Modal Editor Maximized",
        category: "View",
        enabled: () => !!groupsRef.current[MODAL_GROUP],
        run: () => setModalMaximized((value) => !value),
      },
      {
        id: "workbench.action.moveModalEditorToMain",
        title: "Move Modal Editor into Editor Area",
        category: "View",
        enabled: () => !!groupsRef.current[MODAL_GROUP],
        run: () => a().moveModalEditorToEditorArea(),
      },
      { id: "workbench.action.evenEditorWidths", title: "Reset Editor Group Sizes", category: "View", run: () => updateGrid((prev) => evenSizes(prev)) },
      {
        id: "workbench.action.closeGroup",
        title: "Close Editor Group",
        category: "View",
        enabled: () => leafIds(gridRef.current).length > 1,
        run: () => a().closeGroup(activeGroupIdRef.current),
      },
      {
        id: "workbench.action.toggleKeepEmptyGroups",
        title: "Keep Layout When Closing Editors",
        category: "View",
        checked: () => !getSettings()["workbench.editor.closeEmptyGroups"],
        run: () => updateSetting("workbench.editor.closeEmptyGroups", !getSettings()["workbench.editor.closeEmptyGroups"]),
      },
      ...[1, 2, 3, 4].map((n) => ({
        id: `workbench.action.focus${["First", "Second", "Third", "Fourth"][n - 1]}EditorGroup`,
        title: `Focus ${["First", "Second", "Third", "Fourth"][n - 1]} Editor Group`,
        category: "View",
        run: () => {
          const id = leafIds(gridRef.current)[n - 1];
          if (id) {
            focusGroup(id);
            const path = groupsRef.current[id]?.activePath;
            if (isTerminalTab(path)) terminalService.focus(terminalIdOf(path));
            else editors.current.get(id)?.focus();
          } else if (n > 1) void a().splitEditor("right");
        },
      })),
      {
        id: "workbench.action.closeOtherEditors",
        title: "Close Other Editors",
        category: "View",
        run: () =>
          a().closeTabs(
            activeTabs()
              .filter((t) => t.path !== st().activePath)
              .map((t) => t.path),
            activeGroupIdRef.current,
          ),
      },
      {
        id: "workbench.action.closeUnmodifiedEditors",
        title: "Close Saved Editors",
        category: "View",
        run: () =>
          a().closeTabs(
            activeTabs()
              .filter((t) => !t.dirty)
              .map((t) => t.path),
            activeGroupIdRef.current,
          ),
      },
      {
        id: "workbench.action.reopenClosedEditor",
        title: "Reopen Closed Editor",
        category: "View",
        run: () => {
          const path = closedStack.current.pop();
          if (path) void a().openFile(path);
        },
      },
      {
        id: "workbench.action.nextEditor",
        title: "Open Next Editor",
        category: "View",
        run: () => openAt((activeIndex() + 1) % Math.max(1, activeTabs().length)),
      },
      {
        id: "workbench.action.previousEditor",
        title: "Open Previous Editor",
        category: "View",
        run: () => openAt((activeIndex() - 1 + activeTabs().length) % Math.max(1, activeTabs().length)),
      },
      ...Array.from({ length: 9 }, (_, i) => ({
        id: `workbench.action.openEditorAtIndex${i + 1}`,
        title: i === 8 ? "Open Last Editor" : `Open Editor at Index ${i + 1}`,
        category: "View",
        run: () => openAt(i === 8 ? activeTabs().length - 1 : i),
      })),
      {
        id: "workbench.action.keepEditor",
        title: "Keep Editor",
        category: "View",
        run: () => setTabs((prev) => prev.map((t) => (t.path === st().activePath ? { ...t, preview: false } : t))),
      },
      // Views & layout
      { id: "workbench.view.explorer", title: "Show Explorer", category: "View", run: () => a().showView("explorer") },
      { id: "workbench.view.search", title: "Show Search", category: "View", run: () => a().focusSearch() },
      { id: "workbench.action.replaceInFiles", title: "Replace in Files", category: "Search", run: () => a().focusSearch(true) },
      { id: "workbench.view.scm", title: "Show Source Control", category: "View", run: () => a().showView("scm") },
      { id: "outline.focus", title: "Show Outline", category: "View", run: () => a().showView("outline") },
      { id: "workbench.view.debug", title: "Show Run and Debug", category: "View", run: () => a().showView("debug") },
      { id: "workbench.debug.action.toggleRepl", title: "Debug Console", category: "View", run: () => a().showPanel("view:debug-console", true) },
      { id: "workbench.action.debug.start", title: "Start Debugging", category: "Debug", run: () => void a().startDebug() },
      { id: "workbench.action.debug.run", title: "Run Without Debugging", category: "Debug", run: () => void a().startDebug({ noDebug: true }) },
      {
        id: "workbench.action.debug.selectandstart",
        title: "Select and Start Debugging",
        category: "Debug",
        run: () => void a().startDebug({ pick: true }),
      },
      { id: "workbench.action.debug.configure", title: "Open 'launch.json'", category: "Debug", run: () => void a().openLaunchJson() },
      { id: "workbench.action.debug.continue", title: "Continue", category: "Debug", enabled: isStopped, run: () => void debugStep("continue") },
      {
        id: "workbench.action.debug.pause",
        title: "Pause",
        category: "Debug",
        enabled: () => isDebugging() && !isStopped(),
        run: () => void debugStep("pause"),
      },
      { id: "workbench.action.debug.stepOver", title: "Step Over", category: "Debug", enabled: isStopped, run: () => void debugStep("next") },
      { id: "workbench.action.debug.stepInto", title: "Step Into", category: "Debug", enabled: isStopped, run: () => void debugStep("in") },
      { id: "workbench.action.debug.stepOut", title: "Step Out", category: "Debug", enabled: isStopped, run: () => void debugStep("out") },
      { id: "workbench.action.debug.restart", title: "Restart", category: "Debug", enabled: isDebugging, run: () => void restartDebugging() },
      { id: "workbench.action.debug.stop", title: "Stop", category: "Debug", enabled: isDebugging, run: () => void stopDebugging() },
      {
        id: "editor.debug.action.toggleBreakpoint",
        title: "Toggle Breakpoint",
        category: "Debug",
        run: () => {
          const current = editorRef.current?.getCurrent();
          if (current) toggleBreakpoint(current.path, editorRef.current!.getCursor().line + 1);
        },
      },
      {
        id: "editor.debug.action.conditionalBreakpoint",
        title: "Add Conditional Breakpoint…",
        category: "Debug",
        run: () => {
          const current = editorRef.current?.getCurrent();
          if (current) void editBreakpoint(current.path, editorRef.current!.getCursor().line + 1, "condition");
        },
      },
      {
        id: "editor.debug.action.addLogPoint",
        title: "Add Logpoint…",
        category: "Debug",
        run: () => {
          const current = editorRef.current?.getCurrent();
          if (current) void editBreakpoint(current.path, editorRef.current!.getCursor().line + 1, "logMessage");
        },
      },
      {
        id: "workbench.debug.viewlet.action.removeAllBreakpoints",
        title: "Remove All Breakpoints",
        category: "Debug",
        run: () => void debugService.removeAllBreakpoints(),
      },
      { id: "workbench.actions.view.problems", title: "Toggle Problems", category: "View", run: () => a().showPanel("problems", true) },
      { id: "workbench.action.terminal.toggleTerminal", title: "Toggle Terminal", category: "View", run: () => a().showPanel("terminal", true) },
      { id: "workbench.action.terminal.new", title: "Create New Terminal", category: "Terminal", run: () => a().newTerminal() },
      {
        id: "workbench.action.terminal.newWithProfile",
        title: "Create New Terminal (With Profile)",
        category: "Terminal",
        run: () => a().pickProfile((profile) => a().newTerminal({ profileId: profile })),
      },
      {
        id: "workbench.action.terminal.split",
        title: "Split Terminal",
        category: "Terminal",
        run: () => a().newTerminal({ splitWith: activeTerminalId() ?? undefined }),
      },
      {
        id: "workbench.action.createTerminalEditor",
        title: "Create New Terminal in Editor Area",
        category: "Terminal",
        run: () => a().newTerminal({ location: "editor" }),
      },
      {
        id: "workbench.action.terminal.moveToEditor",
        title: "Move Terminal into Editor Area",
        category: "Terminal",
        enabled: () => !!terminalService.getSnapshot().activeId,
        run: () => {
          const id = terminalService.getSnapshot().activeId;
          if (id) a().terminalAction("move-to-editor", id);
        },
      },
      {
        id: "workbench.action.terminal.moveToTerminalPanel",
        title: "Move Terminal into Panel",
        category: "Terminal",
        enabled: () => isTerminalTab(st().activePath),
        run: () => {
          const path = st().activePath;
          if (isTerminalTab(path)) a().moveTerminalToPanel(terminalIdOf(path));
        },
      },
      {
        id: "workbench.action.terminal.rename",
        title: "Rename…",
        category: "Terminal",
        enabled: () => !!activeTerminalId(),
        run: () => {
          const id = activeTerminalId();
          if (id) a().terminalAction("rename", id);
        },
      },
      { id: "workbench.action.terminal.focusNext", title: "Focus Next Terminal", category: "Terminal", run: () => terminalService.cycle(1) },
      { id: "workbench.action.terminal.focusPrevious", title: "Focus Previous Terminal", category: "Terminal", run: () => terminalService.cycle(-1) },
      { id: "workbench.action.terminal.clear", title: "Clear", category: "Terminal", run: () => terminalService.clear(activeTerminalId()) },
      {
        id: "lumen.terminal.showFullHistory",
        title: "Show Full History",
        category: "Terminal",
        enabled: () => !!activeTerminalId(),
        run: () => {
          const id = activeTerminalId();
          if (id) void a().showTerminalHistory(id);
        },
      },
      {
        id: "workbench.action.terminal.kill",
        title: "Kill the Active Terminal Instance",
        category: "Terminal",
        enabled: () => !!activeTerminalId(),
        run: () => {
          const id = activeTerminalId();
          if (id) a().terminalAction("kill", id);
        },
      },
      {
        id: "workbench.action.terminal.selectDefaultShell",
        title: "Select Default Profile",
        category: "Terminal",
        run: () => a().pickProfile((profile) => updateSetting("terminal.integrated.defaultProfile", profile)),
      },
      {
        id: "workbench.action.positionPanelBottom",
        title: "Move Panel To Bottom",
        category: "View",
        checked: () => st().panelPosition === "bottom",
        run: () => a().movePanel("bottom"),
      },
      {
        id: "workbench.action.positionPanelLeft",
        title: "Move Panel Left",
        category: "View",
        checked: () => st().panelPosition === "left",
        run: () => a().movePanel("left"),
      },
      {
        id: "workbench.action.positionPanelRight",
        title: "Move Panel Right",
        category: "View",
        checked: () => st().panelPosition === "right",
        run: () => a().movePanel("right"),
      },
      {
        id: "workbench.action.toggleSidebarVisibility",
        title: "Toggle Primary Side Bar Visibility",
        category: "View",
        checked: () => st().sidebarVisible,
        run: () => setSidebarVisible((v) => !v),
      },
      {
        id: "workbench.action.toggleAuxiliaryBar",
        title: "Toggle Secondary Side Bar Visibility",
        category: "View",
        checked: () => st().auxBarVisible,
        run: () => setAuxBarVisible((v) => !v),
      },
      { id: "workbench.action.focusAuxiliaryBar", title: "Focus into Secondary Side Bar", category: "View", run: () => a().showAuxBar() },
      { id: "workbench.action.closeAuxiliaryBar", title: "Hide Secondary Side Bar", category: "View", run: () => setAuxBarVisible(false) },
      {
        id: "workbench.action.togglePanel",
        title: "Toggle Panel Visibility",
        category: "View",
        checked: () => st().panelVisible,
        run: () => setPanelVisible((v) => !v),
      },
      {
        id: "workbench.action.toggleMaximizedPanel",
        title: "Toggle Maximized Panel",
        category: "View",
        run: () => {
          setPanelVisible(true);
          setPanelMaximized((v) => !v);
        },
      },
      { id: "workbench.action.toggleZenMode", title: "Toggle Zen Mode", category: "View", checked: () => st().zenMode, run: () => setZenMode((v) => !v) },
      {
        id: "workbench.action.toggleFullScreen",
        title: "Toggle Full Screen",
        category: "View",
        checked: () => !!document.fullscreenElement,
        run: () => toggleFullScreen(),
      },
      {
        id: "workbench.action.toggleActivityBarVisibility",
        title: "Toggle Activity Bar Visibility",
        category: "View",
        checked: () => getSettings()["workbench.activityBar.visible"],
        run: toggleSetting("workbench.activityBar.visible"),
      },
      {
        id: "workbench.action.toggleStatusbarVisibility",
        title: "Toggle Status Bar Visibility",
        category: "View",
        checked: () => getSettings()["workbench.statusBar.visible"],
        run: toggleSetting("workbench.statusBar.visible"),
      },
      {
        id: "workbench.action.toggleModernStyle",
        title: "Toggle Modern Style",
        category: "View",
        checked: () => getSettings()["workbench.style"] === "modern",
        run: () => updateSetting("workbench.style", getSettings()["workbench.style"] === "modern" ? "legacy" : "modern"),
      },
      {
        id: "editor.action.toggleMinimap",
        title: "Toggle Minimap",
        category: "View",
        checked: () => getSettings()["editor.minimap.enabled"],
        run: toggleSetting("editor.minimap.enabled"),
      },
      {
        id: "breadcrumbs.toggle",
        title: "Toggle Breadcrumbs",
        category: "View",
        checked: () => getSettings()["breadcrumbs.enabled"],
        run: toggleSetting("breadcrumbs.enabled"),
      },
      {
        id: "editor.action.toggleRenderWhitespace",
        title: "Toggle Render Whitespace",
        category: "View",
        checked: () => getSettings()["editor.renderWhitespace"] === "all",
        run: () => updateSetting("editor.renderWhitespace", getSettings()["editor.renderWhitespace"] === "all" ? "none" : "all"),
      },
      {
        id: "editor.action.toggleWordWrap",
        title: "Toggle Word Wrap",
        category: "View",
        checked: () => getSettings()["editor.wordWrap"] === "on",
        run: () => updateSetting("editor.wordWrap", getSettings()["editor.wordWrap"] === "on" ? "off" : "on"),
      },
      {
        id: "editor.action.fontZoomIn",
        title: "Editor Font Zoom In",
        category: "Editor",
        run: () => updateSetting("editor.fontSize", Math.min(72, getSettings()["editor.fontSize"] + 1)),
      },
      {
        id: "editor.action.fontZoomOut",
        title: "Editor Font Zoom Out",
        category: "Editor",
        run: () => updateSetting("editor.fontSize", Math.max(6, getSettings()["editor.fontSize"] - 1)),
      },
      { id: "editor.action.fontZoomReset", title: "Editor Font Zoom Reset", category: "Editor", run: () => updateSetting("editor.fontSize", 14) },
      // Preferences
      { id: "workbench.action.openSettings", title: "Open Settings", category: "Preferences", run: () => setSettingsOpen(true) },
      { id: "workbench.action.openGlobalKeybindings", title: "Open Keyboard Shortcuts", category: "Preferences", run: () => setShortcutsOpen(true) },
      { id: "workbench.action.selectTheme", title: "Color Theme", category: "Preferences", run: () => void a().colorThemePicker() },
      { id: "workbench.action.configureLocale", title: "Configure Display Language", run: () => a().displayLanguagePicker() },
      // Navigation & language features
      { id: "workbench.action.navigateBack", title: "Go Back", category: "Go", run: () => a().navigate("back") },
      { id: "workbench.action.navigateForward", title: "Go Forward", category: "Go", run: () => a().navigate("forward") },
      { id: "editor.action.revealDefinition", title: "Go to Definition", enabled: hasEditor, run: () => editor()?.goToDefinition() },
      { id: "editor.action.goToTypeDefinition", title: "Go to Type Definition", enabled: hasEditor, run: () => editor()?.goToTypeDefinition() },
      { id: "editor.action.goToImplementation", title: "Go to Implementation", enabled: hasEditor, run: () => editor()?.goToImplementation() },
      { id: "editor.action.revealDeclaration", title: "Go to Declaration", enabled: hasEditor, run: () => editor()?.revealDeclaration() },
      { id: "editor.action.goToReferences", title: "Go to References", enabled: hasEditor, run: () => a().goToReferences() },
      { id: "editor.action.rename", title: "Rename Symbol", enabled: hasEditor, run: () => a().renameSymbol() },
      { id: "editor.action.formatDocument", title: "Format Document", enabled: hasEditor, run: () => a().formatDocument() },
      { id: "editor.action.triggerParameterHints", title: "Trigger Parameter Hints", enabled: hasEditor, run: () => editor()?.triggerParameterHints() },
      { id: "editor.action.quickFix", title: "Quick Fix…", enabled: hasEditor, run: () => editor()?.quickFix() },
      {
        id: "editor.action.marker.nextInFiles",
        title: "Go to Next Problem in Files (Error, Warning, Info)",
        category: "Go",
        run: () => a().gotoProblem(1),
      },
      {
        id: "editor.action.marker.prevInFiles",
        title: "Go to Previous Problem in Files (Error, Warning, Info)",
        category: "Go",
        run: () => a().gotoProblem(-1),
      },
      { id: "workbench.action.editor.changeLanguageMode", title: "Change Language Mode", enabled: hasEditor, run: () => a().changeLanguagePicker() },
      // Editor editing commands
      { id: "actions.find", title: "Find", enabled: hasEditor, run: ed("find") },
      { id: "editor.action.startFindReplaceAction", title: "Replace", enabled: hasEditor, run: ed("replace") },
      { id: "editor.action.commentLine", title: "Toggle Line Comment", enabled: hasEditor, run: ed("toggleComment") },
      { id: "editor.action.addCommentLine", title: "Add Line Comment", enabled: hasEditor, run: ed("toggleComment") },
      { id: "editor.action.removeCommentLine", title: "Remove Line Comment", enabled: hasEditor, run: ed("toggleComment") },
      { id: "editor.action.blockComment", title: "Toggle Block Comment", enabled: hasEditor, run: ed("toggleBlockComment") },
      { id: "editor.action.copyLinesUpAction", title: "Copy Line Up", enabled: hasEditor, run: ed("copyLineUp") },
      { id: "editor.action.copyLinesDownAction", title: "Copy Line Down", enabled: hasEditor, run: ed("copyLineDown") },
      { id: "editor.action.moveLinesUpAction", title: "Move Line Up", enabled: hasEditor, run: ed("moveLineUp") },
      { id: "editor.action.moveLinesDownAction", title: "Move Line Down", enabled: hasEditor, run: ed("moveLineDown") },
      { id: "editor.action.deleteLines", title: "Delete Line", enabled: hasEditor, run: ed("deleteLine") },
      { id: "editor.action.insertLineAfter", title: "Insert Line Below", enabled: hasEditor, run: ed("insertLineBelow") },
      { id: "editor.action.duplicateSelection", title: "Duplicate Selection", enabled: hasEditor, run: ed("duplicateSelection") },
      { id: "expandLineSelection", title: "Expand Line Selection", enabled: hasEditor, run: ed("selectLine") },
      { id: "editor.action.smartSelect.expand", title: "Expand Selection", enabled: hasEditor, run: ed("expandSelection") },
      { id: "editor.action.smartSelect.shrink", title: "Shrink Selection", enabled: hasEditor, run: ed("shrinkSelection") },
      { id: "editor.action.jumpToBracket", title: "Go to Bracket", enabled: hasEditor, run: ed("jumpToBracket") },
      { id: "editor.action.indentLines", title: "Indent Line", enabled: hasEditor, run: ed("indent") },
      { id: "editor.action.outdentLines", title: "Outdent Line", enabled: hasEditor, run: ed("outdent") },
      { id: "editor.action.insertCursorAbove", title: "Add Cursor Above", enabled: hasEditor, run: ed("addCursorAbove") },
      { id: "editor.action.insertCursorBelow", title: "Add Cursor Below", enabled: hasEditor, run: ed("addCursorBelow") },
      { id: "editor.action.addSelectionToNextFindMatch", title: "Add Selection to Next Find Match", enabled: hasEditor, run: ed("addNextOccurrence") },
      { id: "editor.action.selectHighlights", title: "Select All Occurrences of Find Match", enabled: hasEditor, run: ed("selectAllOccurrences") },
      { id: "editor.foldAll", title: "Fold All", enabled: hasEditor, run: ed("foldAll") },
      { id: "editor.unfoldAll", title: "Unfold All", enabled: hasEditor, run: ed("unfoldAll") },
      { id: "editor.fold", title: "Fold", enabled: hasEditor, run: ed("fold") },
      { id: "editor.unfold", title: "Unfold", enabled: hasEditor, run: ed("unfold") },
      { id: "editor.action.transformToUppercase", title: "Transform to Uppercase", enabled: hasEditor, run: ed("upperCase") },
      { id: "editor.action.transformToLowercase", title: "Transform to Lowercase", enabled: hasEditor, run: ed("lowerCase") },
      { id: "editor.action.transformToTitlecase", title: "Transform to Title Case", enabled: hasEditor, run: ed("titleCase") },
      { id: "editor.action.sortLinesAscending", title: "Sort Lines Ascending", enabled: hasEditor, run: ed("sortLinesAscending") },
      { id: "editor.action.sortLinesDescending", title: "Sort Lines Descending", enabled: hasEditor, run: ed("sortLinesDescending") },
      { id: "editor.action.removeDuplicateLines", title: "Delete Duplicate Lines", enabled: hasEditor, run: ed("deleteDuplicateLines") },
      { id: "editor.action.joinLines", title: "Join Lines", enabled: hasEditor, run: ed("joinLines") },
      { id: "editor.action.trimTrailingWhitespace", title: "Trim Trailing Whitespace", enabled: hasEditor, run: ed("trimTrailingWhitespace") },
      // Extensions & output
      { id: "workbench.view.extensions", title: "Show Extensions", category: "View", run: () => a().showExtensions() },
      { id: "workbench.extensions.action.installVSIX", title: "Install from VSIX…", category: "Extensions", run: () => a().installExtension("vsix") },
      {
        id: "workbench.extensions.action.installExtensionFromLocation",
        title: "Install Extension from Location…",
        category: "Developer",
        run: () => a().installExtension("folder"),
      },
      { id: "workbench.action.restartExtensionHost", title: "Restart Extension Host", category: "Developer", run: () => extensionService.restart() },
      {
        id: "workbench.extensions.action.openExtensionsFolder",
        title: "Open Extensions Folder",
        category: "Extensions",
        run: async () => {
          const { dir } = await api().request.extensionsList({});
          await api().request.showInFolder({ path: dir });
        },
      },
      { id: "workbench.action.output.toggleOutput", title: "Toggle Output", category: "View", run: () => a().showPanel("output", true) },
      {
        id: "workbench.action.showExtensionHostLog",
        title: "Show Extension Host Log",
        category: "Developer",
        run: () => {
          extensionService.showOutput("Extension Host");
          a().showPanel("output");
        },
      },
      // Source control
      { id: "git.refresh", title: "Refresh", category: "Git", run: () => a().refreshGit() },
      { id: "git.toggleInlineDiff", title: "Toggle Inline Diff (Open Changes)", category: "Git", enabled: hasEditor, run: () => a().toggleInlineDiff() },
      {
        id: "git.openChange",
        title: "Open Changes",
        category: "Git",
        enabled: hasEditor,
        run: () => {
          const path = editor()?.getCurrent()?.path;
          if (path && !isUntitled(path) && !isVirtualDocument(path)) void a().scmOpenChanges({ path, relativePath: "", index: " ", worktree: "M" }, false);
        },
      },
      { id: "git.fetch", title: "Fetch", category: "Git", run: () => a().gitRemoteAction("fetch") },
      { id: "git.pull", title: "Pull", category: "Git", run: () => a().gitRemoteAction("pull") },
      { id: "git.push", title: "Push", category: "Git", run: () => a().gitRemoteAction("push") },
      { id: "git.sync", title: "Sync", category: "Git", run: () => a().gitRemoteAction("sync") },
      { id: "git.checkout", title: "Checkout to...", category: "Git", run: () => a().checkoutPicker() },
      { id: "git.branch", title: "Create Branch...", category: "Git", run: () => a().createBranch() },
      { id: "git.deleteBranch", title: "Delete Branch...", category: "Git", run: () => a().deleteBranchPicker() },
      { id: "git.viewFileHistory", title: "View File History", category: "Git", enabled: hasEditor, run: () => a().fileHistoryPicker() },
      { id: "git.blame.toggleEditorDecoration", title: "Toggle Git Blame Editor Decoration", category: "Git", run: () => a().toggleLineBlame() },
      // App
      {
        id: "workbench.action.openWelcome",
        title: "Welcome",
        category: "Help",
        run: () => a().closeTabs(st().tabs.map((t) => t.path)),
      },
      {
        id: "workbench.action.showAboutDialog",
        title: "About",
        category: "Help",
        run: async () => {
          const info = await api()
            .request.getAppInfo({})
            .catch(() => ({ name: "Lumen", version: "0.3.0-beta.9", platform: navigator.platform }));
          await showAbout(info);
        },
      },
      { id: "workbench.action.openProcessExplorer", title: "Open Process Explorer", category: "Developer", run: () => setProcessExplorerOpen(true) },
      { id: "update.checkForUpdate", title: "Check for Updates…", run: () => checkForUpdates() },
      { id: "update.restartToUpdate", title: "Restart to Update", enabled: () => updateState().kind === "ready", run: () => restartToUpdate() },
      { id: "workbench.action.reloadWindow", title: "Reload Window", category: "Developer", run: () => location.reload() },
      // The find bar of the active webview panel (enableFindWidget).
      { id: "editor.action.webvieweditor.showFind", title: "Show Find", category: "Webview", run: () => void webviewService.find("open") },
      { id: "editor.action.webvieweditor.findNext", title: "Find Next", category: "Webview", run: () => void webviewService.find("next") },
      { id: "editor.action.webvieweditor.findPrevious", title: "Find Previous", category: "Webview", run: () => void webviewService.find("previous") },
      { id: "editor.action.webvieweditor.hideFind", title: "Stop Find", category: "Webview", run: () => void webviewService.find("close") },
      {
        id: "workbench.action.closeWindow",
        title: "Close Window",
        run: () => (window.__lumen?.frameless ? window.__lumen.window.close() : void api().request.windowClose({})),
      },
      { id: "workbench.action.quit", title: "Quit", category: "File", run: () => api().request.quitApp({}) },
    ];
    return new Map(list.map((command) => [command.id, command]));
  }, [focusGroup, updateGrid, setTabs, editorRef]);

  /** Context keys for when clauses (extension keybindings, menus, enablement). */
  const contextKey = useCallback(
    (key: string): unknown => {
      const st = stateRef.current;
      const focus = focusContext();
      const path = activePathRef.current;
      const isFile = !!path && !isTerminalTab(path);
      switch (key) {
        case "editorTextFocus":
        case "editorFocus":
          return focus === "editor";
        case "textInputFocus":
        case "inputFocus":
          return focus === "editor" || focus === "input";
        case "terminalFocus":
          return focus === "terminal";
        case "explorerFocus":
        case "filesExplorerFocus":
          return focus === "explorer";
        case "editorLangId":
        case "resourceLangId":
          return isFile ? docs.current.get(path!)?.language : undefined;
        case "resourceExtname":
          return isFile ? (/(\.[^./\\]+)$/.exec(path!)?.[1] ?? "") : undefined;
        case "resourceFilename":
          return isFile ? basename(path!) : undefined;
        case "resourceDirname":
          return isFile ? dirname(path!) : undefined;
        case "resource":
        case "resourcePath":
          return isFile ? path : undefined;
        case "resourceScheme":
          return isFile ? (isUntitled(path!) ? "untitled" : "file") : undefined;
        case "editorHasSelection":
          return isFile && !!editorRef.current?.selectedText();
        case "editorHasMultipleSelections":
          return isFile && (editorRef.current?.getSelections().length ?? 0) > 1;
        case "editorIsOpen":
          return isFile;
        case "editorReadonly":
          return false;
        case "activeEditor":
          return isFile ? "workbench.editors.files.textFileEditor" : isTerminalTab(path) ? "terminalEditor" : undefined;
        case "isWindows":
          return navigator.platform.startsWith("Win");
        case "isMac":
          return navigator.platform.startsWith("Mac");
        case "isLinux":
          return /linux/i.test(navigator.platform);
        case "isWeb":
          return false;
        case "sideBarVisible":
          return st.sidebarVisible;
        case "panelVisible":
          return st.panelVisible;
        case "explorerViewletVisible":
          return st.sidebarVisible && st.sideView === "explorer";
        case "workspaceFolderCount":
          return workspaceRootRef.current ? 1 : 0;
        case "workbenchState":
          return workspaceRootRef.current ? "folder" : "empty";
        case "inQuickOpen":
          return quickOpenRef.current;
        default:
          return undefined;
      }
    },
    [activePathRef, editorRef],
  );

  // Walkthrough `when` clauses and onContext events see the window's context keys too.
  useEffect(() => setContextLookup(contextKey), [contextKey]);

  /** Commands contributed by extensions: in the palette, runnable from keys and menus. */
  const extensionCommands = useMemo(
    () =>
      new Map<string, Command>(
        extensionService.contributedCommands().map((contribution) => [
          contribution.command,
          {
            id: contribution.command,
            title: contribution.title,
            category: contribution.category,
            run: () => extensionService.executeCommand(contribution.command),
            enabled: () =>
              contribution.paletteWhen !== "false" &&
              extensionService.when(contribution.paletteWhen, contextKey) &&
              extensionService.when(contribution.enablement, contextKey),
          },
        ]),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ext.extensions, contextKey],
  );
  /** View containers and views of extensions. */
  const viewLayout = useMemo(
    () => extensionService.viewContainers(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ext.extensions],
  );
  /** `workbench.view.extension.<container>` and `<view>.focus`, as in VS Code (extensions run them too). */
  const viewCommands = useMemo(() => {
    const list: Command[] = [];
    for (const container of viewLayout.containers) {
      list.push({
        id: `workbench.view.extension.${container.id}`,
        title: `Show ${container.title}`,
        category: "View",
        run: () => act.current.showContainer(container),
      });
    }
    for (const view of [...viewLayout.containers.flatMap((container) => container.views), ...viewLayout.explorerViews]) {
      list.push({ id: `${view.id}.focus`, title: `Focus on ${view.name} View`, category: "View", run: () => act.current.revealView(view.id) });
      if (view.type !== "webview") {
        list.push({
          id: `workbench.actions.treeView.${view.id}.collapseAll`,
          title: `Collapse All (${view.name})`,
          category: "View",
          run: () => treeService.collapseAll(view.id),
        });
      }
    }
    // Commands of feature plug-ins (src/mainview/features).
    list.push(...featureCommands());
    return new Map(list.map((command) => [command.id, command]));
  }, [viewLayout]);
  const viewCommandsRef = useRef(viewCommands);
  viewCommandsRef.current = viewCommands;
  const allCommands = useMemo(() => new Map([...extensionCommands, ...viewCommands, ...commands]), [commands, extensionCommands, viewCommands]);
  const allCommandsRef = useRef(allCommands);
  allCommandsRef.current = allCommands;

  /** Run an extension command; the host first gets the current selection. */
  const runExtensionCommand = useCallback(
    (id: string, args: unknown[]) => {
      const path = activePathRef.current;
      const editor = editorRef.current;
      if (path && editor?.getCurrent()?.path === path) extensionService.selectionChanged(path, editor.getSelections());
      extensionService.executeCommand(id, args);
    },
    [editorRef, activePathRef],
  );

  const runCommand = useCallback(
    (id: string, fromPalette = false, args?: unknown) => {
      const builtIn = commands.get(id) ?? viewCommands.get(id);
      if (!builtIn && (extensionCommands.has(id) || extensionService.getSnapshot().hostCommands.has(id))) {
        if (fromPalette) rememberCommand(id);
        runExtensionCommand(id, args === undefined ? [] : [args]);
        return;
      }
      const command = builtIn;
      if (!command) return;
      if (fromPalette) rememberCommand(id);
      void Promise.resolve()
        .then(() => command.run(args))
        .then(() => commandExecuted(id))
        .catch((error: unknown) => {
          console.error(`[command] ${id} failed`, error);
          toast(t("{0} failed", commandLabel(command)), "error");
        });
    },
    [commands, extensionCommands, viewCommands, runExtensionCommand],
  );
  const runCommandRef = useRef(runCommand);
  runCommandRef.current = runCommand;

  /* ── keyboard shortcuts (with chords) ─────────────────────────────────── */

  const quickOpenRef = useRef(false);
  quickOpenRef.current = quick !== null;

  useEffect(() => {
    let chord: string | null = null;
    let messageTimer: ReturnType<typeof setTimeout> | null = null;
    let lastEscape = 0;
    const flash = (message: string | null, sticky = false) => {
      setStatusMessage(message);
      if (messageTimer) clearTimeout(messageTimer);
      if (message && !sticky) messageTimer = setTimeout(() => setStatusMessage(null), 2500);
    };

    const onKey = (e: KeyboardEvent) => {
      // Zen mode: Escape twice to leave.
      if (e.key === "Escape" && stateRef.current.zenMode && !quickOpenRef.current) {
        if (Date.now() - lastEscape < 600) setZenMode(false);
        lastEscape = Date.now();
      }
      if (quickOpenRef.current || document.querySelector(".modal-overlay")) return;
      const key = keyFromEvent(e);
      if (!key || key === "Escape") return;
      const context = focusContext();
      const sequence = chord ? `${chord} ${key}` : key;
      const candidates = (bindingsByKey.current.get(sequence) ?? [])
        .filter(
          (binding) =>
            (!binding.when || binding.when === context) &&
            (context !== "terminal" || TERMINAL_PASSTHROUGH.has(binding.command) || !!binding.whenExpr?.includes("terminalFocus")) &&
            (!binding.whenExpr || extensionService.when(binding.whenExpr, contextKey)),
        )
        // Bindings scoped to the focused part (or with a when clause) win over global ones.
        .sort((a, b) => Number(!!(b.when || b.whenExpr)) - Number(!!(a.when || a.whenExpr)));

      if (chord) {
        chord = null;
        e.preventDefault();
        e.stopPropagation();
        if (candidates[0]) {
          flash(null);
          runCommand(candidates[0].command, false, candidates[0].args);
        } else flash(t("The key combination ({0}) is not a command.", sequence));
        return;
      }
      if (candidates[0]) {
        e.preventDefault();
        e.stopPropagation();
        runCommand(candidates[0].command, false, candidates[0].args);
        return;
      }
      if (context !== "terminal" && /^(Ctrl|Alt)\+/.test(key)) {
        for (const binding of bindingsByKey.current.keys()) {
          if (binding.startsWith(`${key} `)) {
            chord = key;
            e.preventDefault();
            e.stopPropagation();
            flash(t("({0}) was pressed. Waiting for second key of chord…", key), true);
            return;
          }
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [runCommand, contextKey]);

  /* ── extension host bridge ────────────────────────────────────────────── */

  const quickRef = useRef(quick);
  quickRef.current = quick;

  /** Show an extension's quick input; one still open is cancelled first. */
  const openHostQuick = useCallback((next: QuickInputRequest) => {
    const current = quickRef.current;
    if (current && (current.kind === "hostPick" || current.kind === "input") && current !== next) {
      const sameLive = current.kind === "hostPick" && next.kind === "hostPick" && current.live && next.live && current.pick.id === next.pick.id;
      const sameInput = current.kind === "input" && next.kind === "input" && current.id === next.id;
      if (!sameLive && !sameInput) current.onCancel();
    }
    quickRef.current = next;
    setQuick(next);
  }, []);

  useEffect(() => {
    extensionService.setDocumentBindings({
      paths: () => [...docs.current.keys()],
      content: (path) => docContent(path),
      language: (path) => docs.current.get(path)?.language,
      dirty: (path) => isDocDirty(path),
      eol: (path) => docs.current.get(path)?.eol ?? "LF",
    });
    const resolveDoc = (path: string) => openDocumentKey(docs.current, path);
    extensionService.setHandlers(
      createExtensionHandlers({
        openFile: async (path, options) => {
          let groupId: string | undefined;
          if (options.beside) {
            const order = leafIds(gridRef.current);
            groupId = order[order.indexOf(activeGroupIdRef.current) + 1] ?? splitGroup(activeGroupIdRef.current, "right");
          }
          return await act.current.openFile(resolveDoc(path), { ...options, groupId });
        },
        openDiff: (original, modified, options) => act.current.openDiff(resolveDoc(original), resolveDoc(modified), options),
        editorFor: async (path, open) => {
          const target = resolveDoc(path);
          const holder =
            editorRef.current?.getCurrent()?.path === target
              ? editorRef.current
              : [...editors.current.values()].find((editor) => editor.getCurrent()?.path === target);
          if (holder) return holder;
          if (!open || !(await act.current.openFile(target, {}))) return null;
          return editorRef.current;
        },
        saveDoc: (path) => act.current.saveDoc(resolveDoc(path)),
        saveAll: () => act.current.saveAll(),
        openUntitled: (path, language, content) => act.current.openUntitledAt(path, language, content),
        setDocumentLanguage: (path, language) => act.current.setDocumentLanguage(resolveDoc(path), language),
        applyWorkspaceEdits: async (edits) => {
          const changed = await act.current.applyWorkspaceEdits(edits);
          for (const { path } of edits) {
            const open = [...docs.current.keys()].find((candidate) => sameDocumentKey(candidate, path));
            if (open) refreshTabDirtyRef.current(open);
          }
          syncDirtyStateRef.current();
          return changed;
        },
        runCommand: (command, args) => {
          const builtIn = commands.get(command) ?? viewCommandsRef.current.get(command);
          if (!builtIn) return false;
          void Promise.resolve()
            .then(() => builtIn.run(args[0]))
            .then(() => commandExecuted(command))
            .catch((error: unknown) => console.error(`[command] ${command} failed`, error));
          return true;
        },
        showQuickPick: (pick: HostQuickPick) =>
          new Promise((resolve) => openHostQuick({ kind: "hostPick", pick, onAccept: (items) => resolve(items), onCancel: () => resolve(null) })),
        showInputBox: (options: HostInputBox) =>
          new Promise((resolve) => {
            const id = options.id ?? -Date.now();
            let settled = false;
            let validation = options.validationMessage ?? null;
            let buttons = options.buttons;
            const finish = (value: string | null) => {
              if (settled) return;
              settled = true;
              stop();
              stopButtons();
              resolve(value);
            };
            const show = () =>
              openHostQuick({
                kind: "input",
                id,
                options: buttons === options.buttons ? options : { ...options, buttons },
                validation,
                onAccept: (value) => finish(value),
                onCancel: () => finish(null),
                onValue: (value) => extensionService.inputBoxValue(id, value),
                onButton: (index) => extensionService.quickPickEvent(id, "button", undefined, undefined, index),
              });
            const stop = extensionService.onInputValidation(id, (message, close) => {
              if (settled) return;
              if (close) {
                finish(null);
                if (quickRef.current?.kind === "input" && quickRef.current.id === id) setQuick(null);
              } else {
                validation = message;
                show();
              }
            });
            const stopButtons = extensionService.onInputBoxButtons(id, (next) => {
              if (settled) return;
              buttons = next;
              show();
            });
            show();
            // Validate the initial value, like VS Code.
            extensionService.inputBoxValue(id, options.value ?? "");
          }),
        createTerminal: ({ name, cwd }) => {
          const id = terminalService.create({ title: name, cwd, location: "panel" });
          extensionTerminals.current.add(id);
          return id;
        },
        showTerminal: (id, preserveFocus) => {
          setPanelTab("terminal");
          setPanelVisible(true);
          setZenMode(false);
          terminalService.setActive(id);
          if (!preserveFocus) terminalService.focus(id);
        },
        sendText: (id, text) => terminalService.sendText(id, text),
        killTerminal: (id) => act.current.terminalAction("kill", id),
        closeTabs: (paths) => act.current.closeTabs(paths),
        followFileOperation: async (kind, files) => {
          await followFileOperation(kind, files);
          return true;
        },
        saveAs: (path, destination) => act.current.saveDoc(resolveDoc(path), { saveAs: true, destination }),
      }),
    );
    // What view features (src/mainview/features) can do in the workbench.
    setFeatureBridge({
      openFile: async (path, options) => await act.current.openFile(resolveDoc(path), options),
      showQuickPick: (pick: HostQuickPick) =>
        new Promise((resolve) => openHostQuick({ kind: "hostPick", pick, onAccept: (items) => resolve(items), onCancel: () => resolve(null) })),
      showInputBox: (options: HostInputBox) =>
        new Promise((resolve) =>
          openHostQuick({
            kind: "input",
            id: options.id ?? -Date.now(),
            options,
            validation: null,
            onAccept: (value) => resolve(value),
            onCancel: () => resolve(null),
          }),
        ),
      runCommand: (id, args) => {
        if (!allCommandsRef.current.has(id) && !extensionService.getSnapshot().hostCommands.has(id)) return false;
        runCommandRef.current(id, false, args[0]);
        return true;
      },
      showSideView: (view) => act.current.showView(view as SideView),
      showPanelTab: (tab) => act.current.showPanel(tab as PanelTab),
      markTabDirty: (tabPath, dirty) => mapAllTabs((tab) => (tab.path === tabPath && !!tab.dirty !== dirty ? { ...tab, dirty } : tab)),
    });
    initFeatures();
    const unsubscribe = extensionService.onReveal(() => act.current.showPanel("output"));
    return () => void unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A quick pick an extension drives itself (window.createQuickPick).
  useEffect(() => {
    const pick = ext.quickPick;
    if (!pick) {
      setQuick((current) => (current?.kind === "hostPick" && current.live ? null : current));
      return;
    }
    openHostQuick({
      kind: "hostPick",
      live: true,
      pick,
      onAccept: (items) => extensionService.quickPickEvent(pick.id, "accept", undefined, items),
      onCancel: () => extensionService.quickPickEvent(pick.id, "hide"),
      onValue: (value) => extensionService.quickPickEvent(pick.id, "value", value),
      onActive: (items) => extensionService.quickPickEvent(pick.id, "active", undefined, items),
      onButton: (index) => extensionService.quickPickEvent(pick.id, "button", undefined, undefined, index),
      onItemButton: (item, index) => extensionService.quickPickEvent(pick.id, "itemButton", undefined, [item], index),
    });
  }, [ext.quickPick, openHostQuick]);

  // The extension host learns which editors are visible and which one is active.
  useEffect(() => {
    const visible = Object.values(groups)
      .map((group) => parseDiffTab(group.activePath)?.modified ?? group.activePath)
      .filter((path): path is string => !!path && !isSpecialTab(path));
    const diff = parseDiffTab(activePath);
    const path = diff ? diff.modified : activePath && !isTerminalTab(activePath) && !isFeatureEditorTab(activePath) ? activePath : null;
    extensionService.setActiveEditor(path, path && !diff ? (editors.current.get(activeGroupId)?.getSelections() ?? []) : [], visible);
  }, [groups, activePath, activeGroupId, ext.extensions]);

  // window.tabGroups: the editor layout, posted (debounced) whenever tabs change.
  useEffect(() => {
    if (!ext.ready) return;
    const timer = setTimeout(() => {
      const layout: HostTabGroup[] = leafIds(grid).map((id, index) => {
        const group = groups[id];
        return {
          viewColumn: index + 1,
          isActive: id === activeGroupId,
          tabs: (group?.tabs ?? []).map((tab) => {
            const custom = customEditorTabInfo(tab.path);
            const webview = isWebviewTab(tab.path) ? webviewService.info(webviewIdOf(tab.path)) : null;
            const feature = parseFeatureEditorTab(tab.path);
            const diff = parseDiffTab(tab.path);
            return {
              label: tab.name,
              path: tab.path,
              kind: isTerminalTab(tab.path)
                ? "terminal"
                : diff
                  ? "diff"
                  : custom
                    ? "custom"
                    : isWebviewTab(tab.path)
                      ? "webview"
                      : feature
                        ? "feature"
                        : "text",
              isActive: group?.activePath === tab.path,
              isDirty: !!tab.dirty,
              isPinned: !tab.preview,
              isPreview: tab.preview,
              ...(custom ? { uri: custom.uri, viewType: custom.viewType } : webview?.viewType ? { viewType: webview.viewType } : {}),
              ...(feature ? { uri: feature.path, viewType: feature.openerId } : {}),
              ...(diff ? { original: diff.original, modified: diff.modified } : {}),
            };
          }),
        };
      });
      extensionService.post({ type: "tabs", groups: layout });
    }, 80);
    return () => clearTimeout(timer);
  }, [groups, activeGroupId, grid, ext.ready]);

  // Extensions hear when a terminal they created goes away.
  useEffect(() => {
    const alive = new Set(terminals.instances.map((instance) => instance.id));
    for (const id of [...extensionTerminals.current]) {
      if (alive.has(id)) continue;
      extensionTerminals.current.delete(id);
      extensionService.post({ type: "terminalClosed", id });
    }
  }, [terminals]);

  // window.activeTerminal / onDidChangeActiveTerminal follow the panel's active terminal.
  useEffect(() => {
    extensionService.activeTerminalChanged(terminals.activeId);
  }, [terminals.activeId, ext.ready, ext.extensions]);

  // The installed list follows host restarts (installs, enable / disable).
  useEffect(() => {
    void refreshExtensions();
  }, [ext.extensions, refreshExtensions]);

  // The Edit menu's Undo / Redo reach an editable custom document.
  useEffect(() => {
    setCustomEditorRoleHandler((role) => {
      const custom = customEditorTabInfo(activePathRef.current);
      if (custom?.kind !== "editable") return false;
      void extensionService.call(role === "undo" ? "undoCustomEditor" : "redoCustomEditor", custom.uri, custom.viewType).catch(() => {});
      return true;
    });
    return () => setCustomEditorRoleHandler(null);
  }, [activePathRef]);

  /* ── webviews ─────────────────────────────────────────────────────────── */

  // Webview panels live in editor tabs: extensions create, reveal and dispose them.
  useEffect(() => {
    const touch = (path: string) => (mru.current = [path, ...mru.current.filter((p) => p !== path)]);
    const unsubscribe = webviewService.onPanelEvent((event) => {
      const path = webviewTabPath(event.id);
      const holder = Object.values(groupsRef.current).find((group) => group.tabs.some((tab) => tab.path === path));
      if (event.type === "created") {
        if (holder || !event.reveal) return;
        // Webviews are drawn over the window, under a modal: they stay in the editor area.
        let groupId = activeGroupIdRef.current === MODAL_GROUP ? (leafIds(gridRef.current)[0] ?? FIRST_GROUP) : activeGroupIdRef.current;
        if (event.reveal.beside) {
          const order = leafIds(gridRef.current);
          groupId = order[order.indexOf(groupId) + 1] ?? splitGroup(groupId, "right");
        }
        setTabs((prev) => [...prev, { path, name: webviewService.info(event.id)?.title || t("Webview"), dirty: false, preview: false }], groupId);
        touch(path);
        setActivePath(path, groupId);
        if (!event.reveal.preserveFocus) focusGroup(groupId);
      } else if (event.type === "disposed") {
        if (holder) void act.current.closeTabs([path]);
      } else if (event.kind === "view") act.current.revealView(event.viewType);
      else if (holder) {
        touch(path);
        setActivePath(path, holder.id);
        if (!event.preserveFocus) focusGroup(holder.id);
      }
    });
    // `command:` links in webviews that allow them, the toolbars / welcome content of tree views and Markdown tooltips.
    const runLinkCommand = (command: string, args: unknown[]) => {
      if (commands.has(command) || viewCommandsRef.current.has(command)) runCommandRef.current(command, false, args[0]);
      else extensionService.executeCommand(command, args);
    };
    webviewService.setCommandHandler(runLinkCommand);
    treeService.setCommandHandler(runLinkCommand);
    setTooltipCommandHandler(runLinkCommand);
    // TreeView.reveal shows the view.
    const unsubscribeTreeReveal = treeService.onReveal((viewId) => act.current.revealView(viewId));
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribeState = webviewService.onStateChange(() => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => setWebviewSaveTick((n) => n + 1), 1000);
    });
    return () => {
      unsubscribe();
      unsubscribeState();
      unsubscribeTreeReveal();
      if (saveTimer) clearTimeout(saveTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Panels saved with the window come back through their serializers (or their custom editor provider), or close.
  const deserializing = useRef(new Set<string>());
  useEffect(() => {
    if (!ext.ready) return;
    for (const pending of webviewService.restoringPanels()) {
      if (deserializing.current.has(pending.id)) continue;
      deserializing.current.add(pending.id);
      const restore = pending.uri
        ? extensionService.call("deserializeCustomEditor", pending.uri, pending.viewType, pending.id, pending.state)
        : extensionService.call("deserializeWebviewPanel", pending.viewType, pending.id, pending.title, pending.state, pending.options);
      void restore
        .catch(() => false)
        .then((restored) => {
          deserializing.current.delete(pending.id);
          if (!restored) void act.current.closeTabs([webviewTabPath(pending.id)]);
        });
    }
  }, [ext.ready, ext.extensions, webviews]);

  // Tab titles follow the panels' titles (and custom editors their dirty state); the active one is "active" for its extension.
  useEffect(() => {
    mapAllTabs((tab) => {
      if (!isWebviewTab(tab.path)) return tab;
      const info = webviews.find((webview) => webview.id === webviewIdOf(tab.path));
      if (!info) return tab;
      const name = info.title && info.title !== tab.name ? info.title : tab.name;
      const dirty = !!info.dirty;
      return name !== tab.name || dirty !== tab.dirty ? { ...tab, name, dirty } : tab;
    });
  }, [webviews, mapAllTabs]);

  // A custom editor's dirty state also marks the window dirty.
  useEffect(() => {
    syncDirtyState();
  }, [webviews, syncDirtyState]);
  useEffect(() => {
    const active = groups[activeGroupId]?.activePath;
    webviewService.setActivePanels(isWebviewTab(active) ? [webviewIdOf(active)] : []);
  }, [groups, activeGroupId]);

  // Webviews must not swallow the mouse while something is dragged or resized.
  useEffect(() => {
    document.body.classList.toggle("lumen-dragging", !!dragKind);
  }, [dragKind]);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.(".resizer, .panel-resizer, .editor-split-sash, .explorer-views-sash"))
        document.body.classList.add("lumen-resizing");
    };
    const up = () => document.body.classList.remove("lumen-resizing");
    window.addEventListener("mousedown", down, true);
    window.addEventListener("mouseup", up, true);
    return () => {
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("mouseup", up, true);
    };
  }, []);

  // Files of extension file systems changed: reload clean editors.
  useEffect(() => {
    const onChanged = (e: Event) => {
      const { paths, changes } = (e as CustomEvent<{ paths: string[]; changes?: { path: string; type: number }[] }>).detail;
      // FileChangeType.Deleted (3): like a local file gone from disk, the tab keeps its
      // content (and unsaved changes); there is nothing left to reload.
      for (const changedPath of paths) {
        // A case-insensitive provider may report the path with another case.
        const path = openDocumentKey(docs.current, changedPath);
        const doc = docs.current.get(path);
        if (!doc) continue;
        const deleted = (changes ?? []).some((change) => change.type === 3 && sameDocumentKey(change.path, changedPath));
        if (deleted) {
          toast(isDocDirty(path) ? t("{0} was deleted. Your unsaved changes are kept.", basename(path)) : t("{0} was deleted.", basename(path)), "info");
          continue;
        }
        void readDocument(path).then((result) => {
          if ("error" in result) return;
          const content = result.content.replace(/\r\n/g, "\n");
          // Our own save just wrote exactly this (providers may fire a change event for it).
          if (content === doc.savedContent || content === doc.content) return;
          if (isDocDirty(path)) {
            toast(t("{0} changed. Your unsaved changes are kept.", basename(path)), "info");
            return;
          }
          doc.savedContent = content;
          doc.content = content;
          for (const editor of editors.current.values()) if (editor.hasDocument(path)) editor.reloadDocument(path, content);
          extensionService.documentChanged(path);
        });
      }
    };
    window.addEventListener("lumen:ext-virtual-changed", onChanged);
    return () => window.removeEventListener("lumen:ext-virtual-changed", onChanged);
  }, [isDocDirty]);

  /* ── editor wiring ────────────────────────────────────────────────────── */

  const refreshTabDirtyRef = useRef(refreshTabDirty);
  refreshTabDirtyRef.current = refreshTabDirty;
  const syncDirtyStateRef = useRef(syncDirtyState);
  syncDirtyStateRef.current = syncDirtyState;

  /** Wire up a group's editor when it mounts. */
  const registerEditor = useCallback((groupId: string, editor: EditorController) => {
    editors.current.set(groupId, editor);
    for (const resolve of editorWaiters.current.get(groupId) ?? []) resolve(editor);
    editorWaiters.current.delete(groupId);
    // The same file open in several groups stays in sync.
    editor.onLocalChange((path, changes) => {
      for (const [id, other] of editors.current) if (id !== groupId) other.applyRemoteChanges(path, changes);
      extensionService.documentChanged(path);
    });
    editor.onDirty((path, dirty) => {
      editorDirty.current.set(path, dirty);
      refreshTabDirtyRef.current(path);
      syncDirtyStateRef.current();
      extensionService.documentDirty(path, dirty);
    });
    editor.onRequestOpen((location) => {
      void act.current.openFile(location.path, { line: location.line, character: location.character, groupId });
    });
    let cursorFrame = 0;
    let selectionTimer: ReturnType<typeof setTimeout> | null = null;
    editor.onCursor((info) => {
      if (activeGroupIdRef.current !== groupId) return;
      cancelAnimationFrame(cursorFrame);
      cursorFrame = requestAnimationFrame(() => setCursor(info));
      if (selectionTimer) clearTimeout(selectionTimer);
      selectionTimer = setTimeout(() => {
        const path = editor.getCurrent()?.path;
        if (path) extensionService.selectionChanged(path, editor.getSelections());
      }, 150);
    });
    // Extensions see the visible ranges of the active editor (onDidChangeTextEditorVisibleRanges).
    editor.onVisibleRanges((path, ranges) => {
      if (activeGroupIdRef.current !== groupId) return;
      extensionService.visibleRangesChanged(path, ranges);
    });
    editor.onDiagnostics((path, list) => {
      setDiagnostics((prev) => {
        if (!prev.get(path)?.length && !list.length) return prev;
        const next = new Map(prev);
        if (list.length) next.set(path, list);
        else next.delete(path);
        return next;
      });
    });
    let symbolTimer: ReturnType<typeof setTimeout> | null = null;
    let blameTimer: ReturnType<typeof setTimeout> | null = null;
    editor.onContentChange((path) => {
      extensionService.documentChanged(path);
      if (symbolTimer) clearTimeout(symbolTimer);
      if (blameTimer) clearTimeout(blameTimer);
      if (activeGroupIdRef.current === groupId) {
        symbolTimer = setTimeout(() => void loadSymbolsRef.current().then(setSymbols), 700);
        // An edit drops the blame (git-blame.ts): blame the new text once typing pauses.
        blameTimer = setTimeout(() => void loadBlameRef.current(path), 1000);
      }
      // files.autoSave = afterDelay
      const s = getSettings();
      if (s["files.autoSave"] === "afterDelay" && !isUntitled(path)) {
        const timers = autoSaveTimers.current;
        const existing = timers.get(path);
        if (existing) clearTimeout(existing);
        timers.set(
          path,
          setTimeout(
            () => {
              timers.delete(path);
              if (editorDirty.current.get(path)) void saveDocRef.current(path);
            },
            Math.max(100, s["files.autoSaveDelay"]),
          ),
        );
      }
    });
  }, []);
  const loadSymbolsRef = useRef(loadSymbols);
  loadSymbolsRef.current = loadSymbols;

  const unregisterEditor = useCallback((groupId: string, editor: EditorController) => {
    if (editors.current.get(groupId) === editor) editors.current.delete(groupId);
  }, []);

  // The language of the active group's document drives the status bar.
  useEffect(() => {
    const document = parseDiffTab(activePath)?.modified ?? activePath;
    setActiveLanguage(document && !isTerminalTab(document) ? (docs.current.get(document)?.language ?? null) : null);
  }, [activePath, activeGroupId]);

  /**
   * Editors follow a file operation (explorer, workspace.applyEdit): renamed
   * files and folders keep their tabs (and unsaved changes), deleted ones close
   * unless they have unsaved changes.
   */
  async function followFileOperation(kind: "create" | "delete" | "rename", files: HostFileOperation[]) {
    for (const file of files) {
      if (kind === "rename" && file.oldPath && file.newPath) {
        const { oldPath, newPath } = file;
        for (const path of [...docs.current.keys()]) {
          if (!isInside(path, oldPath)) continue;
          const target = newPath + path.slice(oldPath.length);
          const doc = docs.current.get(path)!;
          // Extensions see the document close under its old name and open under the new one.
          extensionService.documentClosed(path);
          docs.current.delete(path);
          docs.current.set(target, doc);
          renameEverywhere(path, target);
          extensionService.documentOpened(target);
        }
      } else if (kind === "delete" && file.path) {
        // Clean editors close; editors with unsaved changes stay open (saving writes the file again),
        // as in VS Code: deleting a file never throws away edits that exist nowhere else.
        const affected = [...docs.current.keys()].filter((p) => isInside(p, file.path!));
        const kept = affected.filter((path) => isDocDirty(path));
        if (kept.length) toast(t("Unsaved changes in {0} are kept in the editor.", kept.map((path) => basename(path)).join(", ")), "info");
        const closing = affected.filter((path) => !kept.includes(path));
        if (closing.length) await act.current.closeTabs(closing);
      }
    }
    setTreeRefresh((n) => n + 1);
    syncDirtyState();
  }

  /** Point every group's tabs at a renamed / re-saved file. */
  function renameEverywhere(from: string, to: string, options: { pin?: boolean } = {}) {
    const renamePath = (path: string | null): string | null => {
      if (path === from) return to;
      const diff = parseDiffTab(path);
      return diff && diff.modified === from ? diffTabPath(diff.original, to) : path;
    };
    const renameTab = (tab: TabInfo): TabInfo => {
      if (tab.path === from) return { ...tab, path: to, name: basename(to), preview: options.pin ? false : tab.preview };
      // A diff tab follows its modified document.
      const diff = parseDiffTab(tab.path);
      return diff && diff.modified === from ? { ...tab, path: diffTabPath(diff.original, to) } : tab;
    };
    for (const editor of editors.current.values()) editor.renameDocument(from, to);
    editorDirty.current.set(to, editorDirty.current.get(from) ?? false);
    editorDirty.current.delete(from);
    mru.current = mru.current.map((p) => renamePath(p)!);
    updateGroups((prev) => {
      const next: Record<string, EditorGroupState> = {};
      for (const [id, group] of Object.entries(prev)) {
        next[id] = { ...group, tabs: group.tabs.map(renameTab), activePath: renamePath(group.activePath) };
      }
      return next;
    });
  }

  // Symbols for the outline / breadcrumbs whenever the active document changes.
  useEffect(() => {
    if (!activePath) {
      setSymbols(null);
      return;
    }
    let cancelled = false;
    void loadSymbols().then((list) => {
      if (!cancelled) setSymbols(list);
    });
    return () => {
      cancelled = true;
    };
  }, [activePath, activeLanguage, loadSymbols]);

  // files.autoSave = onFocusChange: save when the window loses focus.
  useEffect(() => {
    const onBlur = () => {
      if (getSettings()["files.autoSave"] !== "onFocusChange") return;
      for (const path of docs.current.keys()) {
        if (!isUntitled(path) && isDocDirty(path)) void saveDocRef.current(path);
      }
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [isDocDirty]);

  /* ── hot exit: backups of unsaved editors ─────────────────────────────── */

  // What each backup on disk holds, so only documents that changed are written again.
  const backedUp = useRef(new Map<string, string>());
  // Set once the user chose "Don't Save" on close: nothing is backed up any more.
  const backupsDiscarded = useRef(false);

  /** Back up the documents with unsaved changes; drop the backups of those that have none any more. */
  const syncBackups = useCallback(() => {
    if (backupsDiscarded.current) return;
    const dirty = new Set<string>();
    for (const [path, doc] of docs.current) {
      // Provider documents live in their extension's file system: only files and untitled editors.
      if (isVirtualDocument(path) || !isDocDirty(path)) continue;
      dirty.add(path);
      const content = docContent(path) ?? doc.content;
      if (backedUp.current.get(path) === content) continue;
      backedUp.current.set(path, content);
      void api()
        .request.backupWrite({ path, content, language: doc.language, eol: doc.eol, encoding: doc.encoding, time: Date.now() })
        .catch(() => backedUp.current.delete(path));
    }
    for (const path of [...backedUp.current.keys()]) {
      if (dirty.has(path)) continue;
      backedUp.current.delete(path);
      void api().request.backupDelete({ path });
    }
  }, [docContent, isDocDirty]);

  useEffect(() => {
    const timer = setInterval(syncBackups, BACKUP_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [syncBackups]);

  /** The user discarded their unsaved changes on close: the next launch must not bring them back. */
  const discardBackups = useCallback(() => {
    backupsDiscarded.current = true;
    for (const path of backedUp.current.keys()) void api().request.backupDelete({ path });
    backedUp.current.clear();
  }, []);

  /** Bring back the unsaved editors of the last session (it crashed, or Windows ended it). */
  const restoreBackups = useCallback(async () => {
    const { backups } = await api()
      .request.backupList({})
      .catch(() => ({ backups: [] }));
    let count = 0;
    for (const backup of backups) {
      if (!isUntitled(backup.path) && (await openFile(backup.path))) {
        const path = openDocumentKey(docs.current, backup.path);
        const doc = docs.current.get(path);
        if (!doc) continue;
        const current = docContent(path) ?? doc.content;
        if (current === backup.content) {
          // Saved after all (the backup outlived the save): nothing to bring back.
          void api().request.backupDelete({ path: backup.path });
          continue;
        }
        const lines = current.split("\n");
        await applyWorkspaceEdits([
          { path, edits: [{ startLine: 0, startCharacter: 0, endLine: lines.length - 1, endCharacter: lines.at(-1)!.length, newText: backup.content }] },
        ]);
        doc.eol = backup.eol;
        if (backup.encoding) doc.encoding = backup.encoding;
        refreshTabDirty(path);
      } else {
        // An untitled editor (or a file that is gone): a new untitled editor with the text.
        void api().request.backupDelete({ path: backup.path });
        await newUntitled(backup.language, backup.content);
      }
      count++;
    }
    syncDirtyState();
    if (count)
      toast(
        count === 1
          ? t("Restored unsaved changes in 1 editor from the last session.")
          : t("Restored unsaved changes in {0} editors from the last session.", count),
        "info",
      );
  }, [applyWorkspaceEdits, docContent, newUntitled, openFile, refreshTabDirty, syncDirtyState]);

  /* ── close guard ──────────────────────────────────────────────────────── */

  useEffect(() => {
    setCloseCheckHandler(async () => {
      const dirty = [...docs.current.keys()].filter((path) => isDocDirty(path));
      const dirtyCustom = webviewService.dirtyCustomEditors();
      const total = dirty.length + dirtyCustom.length;
      if (!total) return { allow: true, dirtyCount: 0 };
      const choice = await showDialog({
        title: t("Unsaved changes"),
        message: t("Do you want to save the changes to {0} file(s)?", total),
        detail: [...dirty.map((path) => basename(path)), ...dirtyCustom.map((entry) => basename(entry.uri))].join(", "),
        buttons: [
          { label: t("Save All"), role: "primary", value: "save" },
          { label: t("Don't Save"), role: "danger", value: "discard" },
          { label: t("Cancel"), role: "default", value: "cancel" },
        ],
      });
      if (choice === "save") {
        for (const path of dirty) if (!(await saveDocRef.current(path))) return { allow: false, dirtyCount: total };
        for (const entry of dirtyCustom) {
          const saved =
            entry.kind === "text"
              ? await saveDocRef.current(entry.uri)
              : !!(await extensionService.call("saveCustomEditor", entry.uri, entry.viewType).catch(() => false));
          if (!saved) return { allow: false, dirtyCount: total };
        }
        syncBackups();
        return { allow: true, dirtyCount: 0 };
      }
      if (choice === "discard") {
        discardBackups();
        // Editable custom documents are backed up so the extension can restore them (hot exit).
        for (const entry of dirtyCustom) {
          if (entry.kind === "editable") void extensionService.call("backupCustomEditor", entry.uri, entry.viewType).catch(() => null);
        }
        return { allow: true, dirtyCount: total };
      }
      return { allow: false, dirtyCount: total };
    });
  }, [isDocDirty, discardBackups, syncBackups]);

  /* ── workspace events ─────────────────────────────────────────────────── */

  // Open the window's folder (and its editors) on startup: the one it showed in the last session, or the one it was opened for.
  const restored = useRef(false);
  const [startupDone, setStartupDone] = useState(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    void api()
      .request.windowInit({})
      // A version without saved windows remembered only the last folder.
      .then((init) => init.workspace ?? (init.restoreLastWorkspace ? localStorage.getItem("lumen.lastWorkspace") : null))
      .catch(() => null)
      .then((folder) => (folder ? openWorkspace(folder) : undefined))
      .finally(() => setStartupDone(true));
  }, [openWorkspace]);

  // Launch URIs (lumen://) go to the window used last.
  useEffect(() => {
    const onFocus = () => api().send.windowFocused({});
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Another window changed keyboard shortcuts or opened a folder (every window shares this storage).
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea !== localStorage) return;
      if (event.key === null || event.key === OVERRIDES_KEY) setOverrides(loadKeybindingOverrides());
      if (event.key === null || event.key === RECENT_KEY) setRecent(recentFolders());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Extensions start once the last workspace (and its editors) is back; the splash gives way to it.
  useEffect(() => {
    if (!startupDone) return;
    hideSplash();
    void extensionService.start(workspaceRootRef.current);
  }, [startupDone]);
  // Then the unsaved editors the last session left behind.
  const backupsRestored = useRef(false);
  useEffect(() => {
    if (!startupDone || backupsRestored.current) return;
    backupsRestored.current = true;
    void restoreBackups();
  }, [startupDone, restoreBackups]);
  useEffect(() => {
    if (startupDone && ext.ready) extensionService.activate("onStartupFinished");
  }, [startupDone, ext.ready, ext.extensions]);

  // Files changed on disk: refresh the explorer, reload clean editors, update git.
  useEffect(() => {
    const onChanged = (e: Event) => {
      const { paths, git: gitTouched } = (e as CustomEvent<{ paths: string[]; git: boolean }>).detail;
      if (paths.length) setTreeRefresh((n) => n + 1);
      if (gitTouched) void refreshGit();
      const changed = new Set(paths.map(lowerKey));
      for (const [path, doc] of docs.current) {
        if (isUntitled(path) || !changed.has(lowerKey(path))) continue;
        void api()
          .request.readFile({ path, encoding: doc.encoding })
          .then((result) => {
            if ("error" in result) return;
            const content = result.content.replace(/\r\n/g, "\n");
            if (content === doc.savedContent) {
              // Same text (our own save, or a tool touched the file): nothing to ask about on the next save.
              doc.version = result.version;
              return;
            }
            if (isDocDirty(path)) {
              // The version stays the one read: saving asks before overwriting the other program's changes.
              toast(t("{0} changed on disk. Your unsaved changes are kept; saving will ask before overwriting.", basename(path)), "info");
              return;
            }
            doc.savedContent = content;
            doc.content = content;
            doc.version = result.version;
            for (const editor of editors.current.values()) if (editor.hasDocument(path)) editor.reloadDocument(path, content);
            extensionService.documentChanged(path);
          });
      }
      // HEAD may have moved (commit, checkout): refresh the change indicators.
      if (gitTouched) {
        for (const editor of editors.current.values()) {
          const current = editor.getCurrent()?.path;
          if (current) void loadGitBase(current);
        }
      }
    };
    window.addEventListener("lumen:workspace-changed", onChanged);
    return () => window.removeEventListener("lumen:workspace-changed", onChanged);
  }, [isDocDirty, loadGitBase, refreshGit]);

  // Persist the project's arrangement: editors (split layout), panels and terminals.
  useEffect(() => {
    if (!workspaceRoot || restoringSession.current) return;
    // Terminals are saved by position; editor tabs refer to them as "terminal:#<index>".
    const terminalList: SavedTerminal[] = [];
    const terminalIndex = new Map<string, number>();
    for (const instance of terminals.instances) {
      // Transient terminals (extension pseudo-terminals) are not restored.
      const described = terminalService.describe(instance.id);
      if (!described) continue;
      terminalIndex.set(instance.id, terminalList.length);
      terminalList.push(described);
    }
    // Webview panels are saved for their serializers; editor tabs refer to them as "webview:#<index>".
    const webviewList: SavedWebview[] = [];
    const webviewIndex = new Map<string, number>();
    const saveTab = (path: string | null): string | null => {
      if (!path || isUntitled(path) || isVirtualDocument(path) || isDiffTab(path)) return null;
      if (isWebviewTab(path)) {
        const id = webviewIdOf(path);
        if (!webviewIndex.has(id)) {
          const saved = webviewService.save(id);
          if (!saved) return null;
          webviewIndex.set(id, webviewList.length);
          webviewList.push(saved);
        }
        return `webview:#${webviewIndex.get(id)}`;
      }
      // A feature editor tab is restored through the file it shows.
      if (isFeatureEditorTab(path)) return parseFeatureEditorTab(path)?.path ?? null;
      if (!isTerminalTab(path)) return path;
      const index = terminalIndex.get(terminalIdOf(path));
      return index === undefined ? null : `terminal:#${index}`;
    };
    const savedGroups: Record<string, { tabs: string[]; active: string | null }> = {};
    for (const [id, group] of Object.entries(groups)) {
      // The modal editor part is not part of the layout.
      if (id === MODAL_GROUP) continue;
      savedGroups[id] = {
        tabs: group.tabs.map((tab) => saveTab(tab.path)).filter((p): p is string => !!p),
        active: saveTab(group.activePath),
      };
    }
    // Groups left with nothing to restore collapse out of the saved layout.
    let savedGrid = grid;
    for (const [id, group] of Object.entries(savedGroups)) {
      if (!group.tabs.length && Object.keys(savedGroups).length > 1 && settings["workbench.editor.closeEmptyGroups"]) {
        savedGrid = removeLeaf(savedGrid, id);
        delete savedGroups[id];
      }
    }
    const state: WorkspaceState = {
      version: 1,
      layout: {
        sidebarVisible,
        sidebarWidth,
        explorerViewsHeight,
        auxBarVisible,
        auxBarWidth,
        auxBarView,
        sideView,
        panelVisible,
        panelHeight,
        panelWidth,
        panelPosition,
        panelTab,
      },
      editors: {
        tabs: [...new Set(Object.values(savedGroups).flatMap((group) => group.tabs))],
        active: saveTab(activePath),
        groups: savedGroups,
        grid: savedGrid,
        activeGroup: activeGroupId === MODAL_GROUP ? (leafIds(grid)[0] ?? FIRST_GROUP) : activeGroupId,
      },
      terminals: {
        list: terminalList,
        panelGroups: terminals.groups.map((group) => group.map((id) => terminalIndex.get(id)!).filter((index) => index !== undefined)),
        activePanel: terminals.activeId ? (terminalIndex.get(terminals.activeId) ?? null) : null,
      },
      webviews: webviewList,
    };
    void api()
      .request.workspaceStateSet({ root: workspaceRoot, state })
      .catch(() => {});
  }, [
    workspaceRoot,
    groups,
    grid,
    activeGroupId,
    activePath,
    settings,
    terminals,
    sidebarVisible,
    sidebarWidth,
    explorerViewsHeight,
    auxBarVisible,
    auxBarWidth,
    auxBarView,
    sideView,
    panelVisible,
    panelHeight,
    panelWidth,
    panelPosition,
    panelTab,
    webviewSaveTick,
  ]);

  useEffect(() => {
    saveLayout({
      sidebarVisible,
      sidebarWidth,
      explorerViewsHeight,
      auxBarVisible,
      auxBarWidth,
      auxBarView,
      sideView,
      panelVisible,
      panelHeight,
      panelWidth,
      panelPosition,
      panelTab,
    });
  }, [
    sidebarVisible,
    sidebarWidth,
    explorerViewsHeight,
    auxBarVisible,
    auxBarWidth,
    auxBarView,
    sideView,
    panelVisible,
    panelHeight,
    panelWidth,
    panelPosition,
    panelTab,
  ]);

  // Terminals in the editor area are editor tabs: keep the tabs in sync with them.
  useEffect(() => {
    if (restoringTerminals.current) return;
    const inEditor = terminals.instances.filter((instance) => instance.location === "editor");
    const ids = new Set(inEditor.map((instance) => terminalTabPath(instance.id)));
    const open = new Set(allTabPaths());
    const added = inEditor.filter((instance) => !open.has(terminalTabPath(instance.id)));
    const staleGroups = Object.values(groupsRef.current).filter((group) => group.tabs.some((tab) => isTerminalTab(tab.path) && !ids.has(tab.path)));
    const titleOf = (path: string) => terminalService.info(terminalIdOf(path))?.title;
    const renamed = Object.values(groupsRef.current).some((group) =>
      group.tabs.some((tab) => isTerminalTab(tab.path) && ids.has(tab.path) && tab.name !== titleOf(tab.path)),
    );
    if (!added.length && !staleGroups.length && !renamed) return;

    mapAllTabs((tab) =>
      isTerminalTab(tab.path) && ids.has(tab.path) && tab.name !== titleOf(tab.path) ? { ...tab, name: titleOf(tab.path) ?? tab.name } : tab,
    );
    for (const group of staleGroups) {
      // The terminal left the editor area (killed, or moved to the panel).
      const stale = group.tabs.filter((tab) => isTerminalTab(tab.path) && !ids.has(tab.path)).map((tab) => tab.path);
      mru.current = mru.current.filter((path) => !stale.includes(path));
      const remaining = group.tabs.filter((tab) => !stale.includes(tab.path));
      const activeGone = !!group.activePath && stale.includes(group.activePath);
      setTabs(remaining, group.id);
      if (activeGone) {
        const fallback = mru.current.find((path) => remaining.some((tab) => tab.path === path)) ?? remaining[0]?.path;
        if (fallback) void openFile(fallback, { recordNav: false, groupId: group.id });
        else setActivePath(null, group.id);
      }
      if (!remaining.length) pruneGroup(group.id);
    }
    for (const instance of added) {
      const placement = terminalService.takePlacement(instance.id);
      let target = pendingTerminalGroup.current && groupsRef.current[pendingTerminalGroup.current] ? pendingTerminalGroup.current : activeGroupIdRef.current;
      pendingTerminalGroup.current = null;
      // An extension's TerminalEditorLocationOptions.viewColumn: a group by its position, or the one beside the active group.
      const column = placement?.viewColumn;
      if (column !== undefined && column !== -1) {
        const order = leafIds(gridRef.current);
        const active = activeGroupIdRef.current;
        if (column === -2) target = order[order.indexOf(active) + 1] ?? splitGroup(active, "right");
        else if (column >= 1) target = order[column - 1] ?? splitGroup(order[order.length - 1] ?? active, "right");
      }
      const path = terminalTabPath(instance.id);
      setTabs((prev) => [...prev, { path, name: instance.title, dirty: false, preview: false }], target);
      setActivePath(path, target);
      if (placement?.preserveFocus) continue;
      mru.current = [path, ...mru.current.filter((p) => p !== path)];
      focusGroup(target);
      terminalService.focus(instance.id);
    }
  }, [terminals, terminalSyncTick, openFile, mapAllTabs, setTabs, setActivePath, pruneGroup, focusGroup, splitGroup]);

  useEffect(() => {
    terminalService.setFontSize(settings["terminal.integrated.fontSize"]);
    terminalService.setScrollback(settings["terminal.integrated.scrollback"]);
  }, [settings]);

  useEffect(() => {
    terminalService.setHistoryOpener((id) => void act.current.showTerminalHistory(id));
    return () => terminalService.setHistoryOpener(null);
  }, []);

  // The terminal panel is never shown empty: open one when it is revealed, or
  // when another project (without saved terminals) opens.
  // (Waits for the startup workspace so the shell starts in that folder.)
  useEffect(() => {
    if (!startupDone || restoringSession.current) return;
    if (panelVisible && !zenMode && panelTab === "terminal" && !terminalService.getSnapshot().groups.length) createTerminal();
  }, [panelVisible, panelTab, zenMode, startupDone, terminalSyncTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // Docking: show drop zones while the panel / a terminal is dragged.
  useEffect(() => {
    const onDragStart = (e: DragEvent) => {
      const types = e.dataTransfer?.types ?? [];
      if (types.includes(PANEL_DRAG_TYPE)) setDragKind("panel");
      else if (types.includes(TERMINAL_DRAG_TYPE)) setDragKind("terminal");
      else if (types.includes(TAB_DRAG_TYPE)) setDragKind("tab");
      else if (types.includes(FILE_DRAG_TYPE)) setDragKind("file");
    };
    const onDragEnd = () => setDragKind(null);
    window.addEventListener("dragstart", onDragStart);
    window.addEventListener("dragend", onDragEnd);
    window.addEventListener("drop", onDragEnd);
    return () => {
      window.removeEventListener("dragstart", onDragStart);
      window.removeEventListener("dragend", onDragEnd);
      window.removeEventListener("drop", onDragEnd);
    };
  }, []);

  const onDock = (zone: DockZone, data: DataTransfer) => {
    setDragKind(null);
    if (zone === "editor" || zone === "panel") return;
    if (data.getData(PANEL_DRAG_TYPE)) movePanel(zone);
  };

  /**
   * Something was dropped on an editor group: a tab (from any group), a file
   * from the explorer or a panel terminal. The edges split the group, the
   * middle moves it in. Ctrl copies a file tab instead of moving it.
   */
  async function dropIntoGroup(groupId: string, zone: EditorDropZone, data: DataTransfer, copy: boolean) {
    setDragKind(null);
    const tabData = data.getData(TAB_DRAG_TYPE);
    const tab = tabData ? (JSON.parse(tabData) as { path: string; groupId: string }) : null;
    const file = data.getData(FILE_DRAG_TYPE);
    const panelTerminal = data.getData(TERMINAL_DRAG_TYPE);
    if (tab && zone === "center" && tab.groupId === groupId) return;
    // Splitting a group with the only editor it has would just move it around.
    if (tab && tab.groupId === groupId && zone !== "center" && (groupsRef.current[groupId]?.tabs.length ?? 0) < 2 && !copy) return;

    const target = zone === "center" ? groupId : splitGroup(groupId, zone);
    if (panelTerminal) {
      pendingTerminalGroup.current = target;
      terminalService.moveToEditor(panelTerminal);
      hidePanelIfNoTerminals();
      return;
    }
    if (file) {
      await openFile(file, { groupId: target });
      return;
    }
    if (!tab) return;
    if (isTerminalTab(tab.path)) {
      // A terminal can only be shown once: move its tab.
      const source = groupsRef.current[tab.groupId];
      const remaining = source?.tabs.filter((t) => t.path !== tab.path) ?? [];
      setTabs(remaining, tab.groupId);
      if (source?.activePath === tab.path) {
        const fallback = mru.current.find((path) => path !== tab.path && remaining.some((t) => t.path === path)) ?? remaining[0]?.path;
        if (fallback) void openFile(fallback, { recordNav: false, groupId: tab.groupId });
        else setActivePath(null, tab.groupId);
      }
      setTabs(
        (prev) => [...prev, { path: tab.path, name: terminalService.info(terminalIdOf(tab.path))?.title ?? "terminal", dirty: false, preview: false }],
        target,
      );
      focusGroup(target);
      setActivePath(tab.path, target);
      terminalService.focus(terminalIdOf(tab.path));
      pruneGroup(tab.groupId);
      return;
    }
    await openFile(tab.path, { groupId: target });
    if (!copy && tab.groupId !== target) await closeTabs([tab.path], tab.groupId);
  }

  /** Split Editor: show the active editor in a new group beside it too. */
  async function splitEditor(side: DropSide, groupId = activeGroupIdRef.current) {
    const path = groupsRef.current[groupId]?.activePath;
    const target = splitGroup(groupId, side);
    if (!path) return;
    if (isTerminalTab(path)) {
      pendingTerminalGroup.current = target;
      newTerminal({ location: "editor" });
    } else await openFile(path, { groupId: target });
  }

  /** Move the active editor into the next / previous group (creating one on the right). */
  async function moveEditorToGroup(step: 1 | -1) {
    const order = leafIds(gridRef.current);
    const from = activeGroupIdRef.current;
    const path = groupsRef.current[from]?.activePath;
    if (!path) return;
    const index = order.indexOf(from) + step;
    let target = order[index];
    if (!target) {
      if (step < 0 || (groupsRef.current[from]?.tabs.length ?? 0) < 2) return;
      target = splitGroup(from, "right");
    }
    const fake = new DataTransfer();
    fake.setData(TAB_DRAG_TYPE, JSON.stringify({ path, groupId: from }));
    await dropIntoGroup(target, "center", fake, false);
  }

  /** Put every editor into the first group. */
  async function joinAllGroups() {
    const order = leafIds(gridRef.current);
    const first = order[0];
    if (!first || order.length < 2) return;
    for (const id of order.slice(1)) {
      for (const tab of [...(groupsRef.current[id]?.tabs ?? [])]) {
        const fake = new DataTransfer();
        fake.setData(TAB_DRAG_TYPE, JSON.stringify({ path: tab.path, groupId: id }));
        await dropIntoGroup(first, "center", fake, false);
      }
      pruneGroup(id, true);
    }
  }

  /** Close a group with all its editors (asks about unsaved changes first). */
  async function closeGroup(groupId: string) {
    const paths = groupsRef.current[groupId]?.tabs.map((tab) => tab.path) ?? [];
    if (paths.length && !(await closeTabs(paths, groupId))) return;
    pruneGroup(groupId, true);
  }

  /** Close the modal editor part with its editors (asks about unsaved changes first). */
  async function closeModalEditor() {
    const paths = groupsRef.current[MODAL_GROUP]?.tabs.map((tab) => tab.path) ?? [];
    if (paths.length) await closeTabs(paths, MODAL_GROUP);
  }

  /** Move the modal's editors into the editor area (its first group). */
  async function moveModalEditorToEditorArea() {
    const target = leafIds(gridRef.current)[0];
    if (!target) return;
    for (const tab of [...(groupsRef.current[MODAL_GROUP]?.tabs ?? [])]) {
      const fake = new DataTransfer();
      fake.setData(TAB_DRAG_TYPE, JSON.stringify({ path: tab.path, groupId: MODAL_GROUP }));
      await dropIntoGroup(target, "center", fake, false);
    }
  }

  /** Show the active editor in the modal editor part. */
  async function openActiveEditorInModal() {
    const source = activeGroupIdRef.current;
    const path = groupsRef.current[source]?.activePath;
    // Webviews are drawn over the window and would sit under the modal.
    if (!path || source === MODAL_GROUP || isWebviewTab(path)) return;
    ensureModalGroup();
    await waitForEditor(MODAL_GROUP);
    const fake = new DataTransfer();
    fake.setData(TAB_DRAG_TYPE, JSON.stringify({ path, groupId: source }));
    await dropIntoGroup(MODAL_GROUP, "center", fake, false);
  }

  // Window title: "● file — folder — Lumen" (taskbar, Alt+Tab).
  const activeTab = tabs.find((tab) => tab.path === activePath) ?? null;
  const windowTitle = [activeTab ? `${activeTab.dirty ? "● " : ""}${activeTab.name}` : null, workspaceRoot ? basename(workspaceRoot) : null, "Lumen"]
    .filter(Boolean)
    .join(" — ");
  useEffect(() => {
    void api()
      .request.setWindowTitle({ title: windowTitle })
      .catch(() => {});
  }, [windowTitle]);

  /* ── explorer & tab actions ───────────────────────────────────────────── */

  /** A row relative to its own root (a workspace folder, also a provided one). */
  const relativeToRoot = useCallback(
    (path: string) => {
      const roots = [...(workspaceRoot ? [workspaceRoot] : []), ...explorerRootEntries.map((root) => root.path)];
      const root = roots.filter((candidate) => isInside(path, candidate)).sort((a, b) => b.length - a.length)[0];
      return root
        ? path
            .slice(root.length)
            .replace(/^[\\/]+/, "")
            .replace(/\\/g, "/")
        : path;
    },
    [workspaceRoot, explorerRootEntries],
  );

  /**
   * Copy or move rows of a provided file system (context menu paste, drag and drop):
   * provider.copy / provider.rename when the provider has them, else a read + write.
   */
  const transferProviderEntries = useCallback(
    async (paths: string[], targetDir: string, copy: boolean) => {
      if (!isVirtualDocument(targetDir)) {
        toast(t("Copy and move are supported inside one provided file system."), "info");
        return;
      }
      for (const source of paths) {
        if (!isVirtualDocument(source)) continue;
        const target = joinPath(targetDir, basename(source));
        if (source === target) continue;
        // A folder cannot be copied or moved into itself.
        if (isInside(targetDir, source)) {
          toast(copy ? t("Cannot copy {0} into itself.", basename(source)) : t("Cannot move {0} into itself.", basename(source)), "error");
          continue;
        }
        if (copy) {
          const willEdits = await extensionService.willFileOperation("create", [{ path: target }]);
          if (willEdits.length) await applyWorkspaceEdits(willEdits);
          const result = await extensionService.call("providerCopy", source, target);
          if (!result.success) {
            toast(result.error ?? t("Copy failed"), "error");
            continue;
          }
          extensionService.didFileOperation("create", [{ path: target }]);
        } else {
          const willEdits = await extensionService.willFileOperation("rename", [{ oldPath: source, newPath: target }]);
          if (willEdits.length) await applyWorkspaceEdits(willEdits);
          const result = await extensionService.call("providerRename", source, target);
          if (!result.success) {
            toast(result.error ?? t("Move failed"), "error");
            continue;
          }
          extensionService.didFileOperation("rename", [{ oldPath: source, newPath: target }]);
          await followFileOperation("rename", [{ oldPath: source, newPath: target }]);
        }
      }
      setTreeRefresh((n) => n + 1);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- followFileOperation is a plain function that works through refs; listing it would rebuild this on every render
    [applyWorkspaceEdits],
  );

  const handleTreeContext = useCallback(
    async (evt: TreeContextAction) => {
      const dir = evt.isDirectory ? evt.path : dirname(evt.path);
      switch (evt.action) {
        case "open":
        case "open-to-side":
          if (!evt.isDirectory) await openFile(evt.path);
          break;
        case "new-file":
          await createEntry("file", dir);
          break;
        case "new-folder":
          await createEntry("folder", dir);
          break;
        case "rename": {
          const newName = await showPrompt({ title: t("Rename"), message: t("Rename {0}", basename(evt.path)), defaultValue: basename(evt.path) });
          if (!newName?.trim() || newName === basename(evt.path)) return;
          const newPath = joinPath(dirname(evt.path), newName.trim());
          // Extensions may rewrite references before the move (workspace.onWillRenameFiles).
          const willEdits = await extensionService.willFileOperation("rename", [{ oldPath: evt.path, newPath }]);
          if (willEdits.length) await applyWorkspaceEdits(willEdits);
          const result = isVirtualDocument(evt.path)
            ? await extensionService.call("providerRename", evt.path, newPath)
            : await api().request.renamePath({ oldPath: evt.path, newPath });
          if (!result.success) {
            toast(result.error ?? t("Rename failed"), "error");
            return;
          }
          extensionService.didFileOperation("rename", [{ oldPath: evt.path, newPath }]);
          await followFileOperation("rename", [{ oldPath: evt.path, newPath }]);
          break;
        }
        case "delete": {
          const choice = await showDialog({
            title: t("Delete"),
            message: t("Are you sure you want to delete '{0}'?", basename(evt.path)),
            detail: evt.isDirectory ? t("The folder and its contents will be permanently deleted.") : t("This cannot be undone."),
            buttons: [
              { label: t("Delete"), role: "danger", value: "delete" },
              { label: t("Cancel"), role: "default", value: "cancel" },
            ],
          });
          if (choice !== "delete") return;
          // Extensions may react before the file goes (workspace.onWillDeleteFiles).
          const willEdits = await extensionService.willFileOperation("delete", [{ path: evt.path }]);
          if (willEdits.length) await applyWorkspaceEdits(willEdits);
          const result = isVirtualDocument(evt.path)
            ? await extensionService.call("providerDelete", evt.path)
            : await api().request.deletePath({ path: evt.path });
          if (!result.success) {
            toast(result.error ?? t("Delete failed"), "error");
            return;
          }
          extensionService.didFileOperation("delete", [{ path: evt.path }]);
          await followFileOperation("delete", [{ path: evt.path }]);
          break;
        }
        case "reveal":
          await api().request.showInFolder({ path: evt.path });
          break;
        case "copy-path":
        case "copy-relative-path": {
          const text = evt.action === "copy-relative-path" ? relativeToRoot(evt.path) : evt.path;
          await navigator.clipboard.writeText(text).catch(() => {});
          toast(t("Copied to clipboard"), "success");
          break;
        }
        case "find-in-folder":
          focusSearch();
          toast(t("Tip: open “files to include” (⋯) and enter {0}/ to search only that folder.", basename(evt.path)), "info");
          break;
        case "open-in-terminal":
          newTerminal({ cwd: evt.isDirectory ? evt.path : dirname(evt.path) });
          break;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- followFileOperation is a plain function that works through refs; listing it would rebuild this on every render
    [openFile, createEntry, applyWorkspaceEdits, focusSearch, relativeToRoot],
  );

  const handleTabAction = useCallback(
    async (action: TabAction, path: string, groupId: string) => {
      const tabs = groupsRef.current[groupId]?.tabs ?? [];
      const index = tabs.findIndex((tab) => tab.path === path);
      switch (action) {
        case "close":
          await closeTabs([path], groupId);
          break;
        case "close-others":
          await closeTabs(
            tabs.filter((tab) => tab.path !== path).map((tab) => tab.path),
            groupId,
          );
          break;
        case "close-right":
          await closeTabs(
            tabs.slice(index + 1).map((tab) => tab.path),
            groupId,
          );
          break;
        case "close-saved":
          await closeTabs(
            tabs.filter((tab) => !tab.dirty).map((tab) => tab.path),
            groupId,
          );
          break;
        case "close-all":
          await closeTabs(
            tabs.map((tab) => tab.path),
            groupId,
          );
          break;
        case "split-right":
        case "split-down": {
          if (groupsRef.current[groupId]?.activePath !== path) await openFile(path, { groupId });
          await splitEditor(action === "split-right" ? "right" : "bottom", groupId);
          break;
        }
        case "copy-path":
        case "copy-relative-path": {
          const text = action === "copy-relative-path" && workspaceRoot ? path.slice(workspaceRoot.length + 1).replace(/\\/g, "/") : path;
          await navigator.clipboard.writeText(text).catch(() => {});
          toast(t("Copied to clipboard"), "success");
          break;
        }
        case "reveal-in-sidebar":
          showView("explorer");
          setTreeReveal({ path, token: Date.now() });
          break;
        case "reveal":
          await api().request.showInFolder({ path });
          break;
        case "terminal-rename":
          terminalAction("rename", terminalIdOf(path));
          break;
        case "terminal-move-to-panel":
          moveTerminalToPanel(terminalIdOf(path));
          break;
        case "keep-open":
          setTabs((prev) => prev.map((tab) => (tab.path === path ? { ...tab, preview: false } : tab)), groupId);
          break;
        case "reopen-with":
          reopenWithEditor(path, groupId);
          break;
      }
    },
    // splitEditor reads refs only
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [closeTabs, openFile, reopenWithEditor, workspaceRoot, showView, setTabs],
  );

  /* ── resizing ─────────────────────────────────────────────────────────── */

  const onSidebarResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    const onMove = (ev: MouseEvent) => setSidebarWidth(Math.min(600, Math.max(170, startWidth + ev.clientX - startX)));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const onAuxBarResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = auxBarWidth;
    const onMove = (ev: MouseEvent) => setAuxBarWidth(Math.min(800, Math.max(200, startWidth - (ev.clientX - startX))));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  /** The sash between the Explorer's files and the extension views under them. */
  const onExplorerViewsResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const panel = (e.target as HTMLElement).closest(".sidebar-panel") as HTMLElement | null;
    const onMove = (ev: MouseEvent) => {
      if (!panel) return;
      const rect = panel.getBoundingClientRect();
      setExplorerViewsHeight(Math.round(Math.min(rect.height - 100, Math.max(80, rect.bottom - ev.clientY))));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const onPanelResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const main = (e.target as HTMLElement).closest(".main") as HTMLElement | null;
    const onMove = (ev: MouseEvent) => {
      if (!main) return;
      const rect = main.getBoundingClientRect();
      if (panelPosition === "bottom") setPanelHeight(Math.min(rect.height - 80, Math.max(100, rect.bottom - ev.clientY)));
      else if (panelPosition === "right") setPanelWidth(Math.min(rect.width - 160, Math.max(200, rect.right - ev.clientX)));
      else setPanelWidth(Math.min(rect.width - 160, Math.max(200, ev.clientX - rect.left)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  /* ── derived view data ────────────────────────────────────────────────── */

  const decorations: TreeDecorations = useMemo(() => {
    const gitMap = new Map<string, { letter: string; className: string }>();
    for (const file of git?.files ?? []) {
      const code = file.index === "?" ? "?" : file.worktree !== " " ? file.worktree : file.index;
      const decoration = gitDecoration(code);
      if (decoration) gitMap.set(lowerKey(file.path), decoration);
    }
    const problems = new Map<string, "error" | "warning">();
    for (const [path, list] of allDiagnostics) {
      if (list.some((d) => d.severity === "error")) problems.set(lowerKey(path), "error");
      else if (list.some((d) => d.severity === "warning")) problems.set(lowerKey(path), "warning");
    }
    return { git: gitMap, problems, fileDecorations: ext.fileDecorations };
  }, [git, allDiagnostics, ext.fileDecorations]);

  /** The explorer asks the host for extension decorations of the rows it shows. */
  const requestTreeDecorations = useCallback((paths: string[]) => extensionService.requestFileDecorations(paths), []);

  // Same file name in two tabs: show the folder to tell them apart.
  const withHints = (list: TabInfo[]) => {
    const counts = new Map<string, number>();
    for (const tab of list) counts.set(tab.name, (counts.get(tab.name) ?? 0) + 1);
    return list.map((tab) =>
      (counts.get(tab.name) ?? 0) > 1 && !isUntitled(tab.path) && !isTerminalTab(tab.path) && !isDiffTab(tab.path)
        ? { ...tab, hint: basename(dirname(tab.path)) }
        : tab,
    );
  };

  const errorCount = [...allDiagnostics.values()].reduce((n, list) => n + list.filter((d) => d.severity === "error").length, 0);
  const warningCount = [...allDiagnostics.values()].reduce((n, list) => n + list.filter((d) => d.severity === "warning").length, 0);
  const activeDoc = activePath ? docs.current.get(parseDiffTab(activePath)?.modified ?? activePath) : undefined;
  const activeIndentation = indentationFor(activePath ? (parseDiffTab(activePath)?.modified ?? activePath) : null, settings);
  const editorActive = !!activePath && !isSpecialTab(activePath);
  const paletteCommands = useMemo(() => [...allCommands.values()], [allCommands]);
  const visiblePaletteCommands = quick ? paletteCommands.filter((command) => command.enabled?.() !== false) : paletteCommands;
  /** Where the sidebar's New File / New Folder buttons create: the local root, or the first provided root. */
  const newEntryRoot = workspaceRoot ?? explorerRootEntries[0]?.path ?? null;
  /** Workspace folders of provided file systems (Quick Open / Find in Files walk them). */
  const providerRootPaths = useMemo(() => explorerRootEntries.filter((root) => root.scheme !== "file").map((root) => root.path), [explorerRootEntries]);
  const showActivityBar = settings["workbench.activityBar.visible"] && !zenMode;
  const showSidebar = sidebarVisible && !zenMode;
  const showPanelArea = panelVisible && !zenMode;
  const scmCount = git?.files.length ?? 0;

  const activity: { view: SideView; title: string; command: string; icon: React.ReactNode; badge?: number; extra?: React.ReactNode }[] = [
    {
      view: "explorer",
      title: t("Explorer"),
      command: "workbench.view.explorer",
      icon: <Files size={22} strokeWidth={1.5} />,
    },
    {
      view: "search",
      title: t("Search"),
      command: "workbench.view.search",
      icon: <Search size={22} strokeWidth={1.5} />,
    },
    {
      view: "scm",
      title: t("Source Control"),
      command: "workbench.view.scm",
      badge: scmCount,
      icon: <GitBranch size={22} strokeWidth={1.5} />,
    },
    {
      view: "debug",
      title: t("Run and Debug"),
      command: "workbench.view.debug",
      icon: <Bug size={22} strokeWidth={1.5} />,
    },
    {
      view: "outline",
      title: t("Outline"),
      command: "outline.focus",
      icon: <ListTree size={22} strokeWidth={1.5} />,
    },
    {
      view: "extensions",
      title: t("Extensions"),
      command: "workbench.view.extensions",
      badge: ext.crashed ? 1 : undefined,
      icon: <Blocks size={22} strokeWidth={1.5} />,
    },
  ];
  const visibleViews = (views: typeof viewLayout.explorerViews) => views.filter((view) => extensionService.when(view.when, contextKey));
  // View containers of extensions sit between the built-in views and Extensions; like VS Code,
  // a container whose views are all hidden (`when`) is not shown.
  const sideContainers = viewLayout.containers.filter((container) => container.location === "activitybar" && visibleViews(container.views).length > 0);
  const auxContainers = viewLayout.containers.filter((container) => container.location === "secondarySidebar" && visibleViews(container.views).length > 0);
  const activeAuxContainer = auxContainers.find((container) => container.id === auxBarView) ?? auxContainers[0];
  const featureViews = useMemo(() => featureSidebarViews(), []);
  const showAuxBarArea = auxBarVisible && !zenMode && auxContainers.length > 0;

  // Walkthrough onView events: the visible side bar / panel surfaces and every view they contain
  // (built-in ones, contributed tree/webview views and the features' own surfaces).
  useEffect(() => {
    const ids: string[] = [];
    const addViews = (views: { id: string; when?: string }[] | undefined) => {
      for (const view of views ?? []) if (extensionService.when(view.when, contextKey)) ids.push(view.id);
    };
    if (showSidebar) {
      ids.push(sideView);
      if (sideView === "explorer") addViews(viewLayout.explorerViews);
      else if (sideView.startsWith(FEATURE_VIEW_PREFIX)) ids.push(sideView.slice(FEATURE_VIEW_PREFIX.length));
      else if (sideView.startsWith("view:")) addViews(sideContainers.find((container) => `view:${container.id}` === sideView)?.views);
    }
    if (showAuxBarArea) addViews(activeAuxContainer?.views);
    if (showPanelArea) {
      ids.push(panelTab);
      if (panelTab.startsWith(FEATURE_VIEW_PREFIX)) ids.push(panelTab.slice(FEATURE_VIEW_PREFIX.length));
      else if (panelTab.startsWith("view:"))
        addViews(viewLayout.containers.find((container) => container.location === "panel" && `view:${container.id}` === panelTab)?.views);
    }
    setVisibleViews(ids);
    refreshContext();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSidebar, showAuxBarArea, showPanelArea, sideView, panelTab, activePath, viewLayout, contextKey]);

  // The side bar shows a container that is not there (gone, or all its views hidden): back to the
  // Explorer — after a moment, so `when` context keys extensions set while starting have arrived.
  const sideViewMissing =
    ext.ready &&
    sideView.startsWith("view:") &&
    !sideView.startsWith(FEATURE_VIEW_PREFIX) &&
    !sideContainers.some((container) => `view:${container.id}` === sideView);
  useEffect(() => {
    if (!sideViewMissing) return;
    const timer = setTimeout(() => setSideView("explorer"), 3000);
    return () => clearTimeout(timer);
  }, [sideViewMissing]);
  const viewBadge = (views: { id: string }[]) =>
    webviews
      .filter((webview) => webview.kind === "view" && views.some((view) => view.id === webview.viewType))
      .reduce((sum, webview) => sum + (webview.badge?.value ?? 0), 0) + views.reduce((sum, view) => sum + (treeViews.get(view.id)?.badge?.value ?? 0), 0);
  activity.splice(
    activity.length - 1,
    0,
    ...sideContainers.map((container) => ({
      view: `view:${container.id}` as SideView,
      title: container.title,
      command: `workbench.view.extension.${container.id}`,
      badge: viewBadge(container.views) || undefined,
      icon: <ContainerIcon url={container.iconUrl} title={container.title} />,
    })),
  );

  // Side bar views of feature plug-ins (src/mainview/features) sit with the extensions' containers.
  activity.splice(
    activity.length - 1,
    0,
    ...featureViews.map((view) => ({
      view: featureViewId(view.id) as SideView,
      title: view.title,
      command: `workbench.view.feature.${view.id}`,
      icon: <FeatureIconView icon={view.icon} />,
      extra: view.badge ? <FeatureActivityBadge id={view.id} /> : undefined,
    })),
  );

  // The user's order (dragged items take the slots of the dragged items; new ones keep their default place)
  // and hidden items of the activity bar.
  const activityOrder = settings["workbench.activityBar.order"];
  const activityHidden = new Set(settings["workbench.activityBar.hidden"]);
  const orderedActivity = (() => {
    const rank = new Map(activityOrder.map((view, index) => [view, index]));
    const ranked = activity.filter((item) => rank.has(item.view)).sort((a, b) => rank.get(a.view)! - rank.get(b.view)!);
    let next = 0;
    return activity.map((item) => (rank.has(item.view) ? ranked[next++]! : item));
  })();
  const shownActivity = orderedActivity.filter((item) => !activityHidden.has(item.view));
  const moveActivity = (view: string, target: string, after: boolean) => {
    if (view === target) return;
    const order = orderedActivity.map((item) => item.view as string).filter((id) => id !== view);
    const index = order.indexOf(target);
    if (index < 0) return;
    order.splice(after ? index + 1 : index, 0, view);
    updateSetting("workbench.activityBar.order", order);
  };
  const setActivityHidden = (view: string, hidden: boolean) => {
    const next = new Set(activityHidden);
    if (hidden) next.add(view);
    else next.delete(view);
    updateSetting("workbench.activityBar.hidden", [...next]);
    if (hidden && sideView === view) setSidebarVisible(false);
  };
  const activityMenu = (x: number, y: number, item?: (typeof activity)[number]) => {
    const lastShown = shownActivity.length <= 1;
    void showContextMenu(x, y, [
      ...(item
        ? [
            { type: "item" as const, label: t("Hide '{0}'", item.title), action: "hide", disabled: lastShown, run: () => setActivityHidden(item.view, true) },
            { type: "separator" as const },
          ]
        : []),
      ...orderedActivity.map((entry) => {
        const shown = !activityHidden.has(entry.view);
        return {
          type: "item" as const,
          label: entry.title,
          action: entry.view,
          checked: shown,
          disabled: shown && lastShown,
          run: () => setActivityHidden(entry.view, shown),
        };
      }),
      { type: "separator" },
      {
        type: "item",
        label: t("Reset Activity Bar"),
        action: "reset",
        disabled: !activityOrder.length && !activityHidden.size,
        run: () => {
          updateSetting("workbench.activityBar.order", []);
          updateSetting("workbench.activityBar.hidden", []);
        },
      },
      { type: "item", label: t("Hide Activity Bar"), action: "hideBar", run: () => updateSetting("workbench.activityBar.visible", false) },
    ]);
  };

  const sidebarTitle = sideView.startsWith("view:")
    ? (sideContainers.find((container) => `view:${container.id}` === sideView)?.title ??
      featureViews.find((view) => featureViewId(view.id) === sideView)?.title ??
      "")
    : t(
        { explorer: "Explorer", search: "Search", scm: "Source Control", debug: "Run and Debug", outline: "Outline", extensions: "Extensions" }[
          sideView as "explorer"
        ],
      );

  const extensionsMenu = (x: number, y: number) =>
    void showContextMenu(x, y, [
      { type: "item", label: t("Install from VSIX…"), action: "workbench.extensions.action.installVSIX" },
      { type: "item", label: t("Install Extension from Location… (development)"), action: "workbench.extensions.action.installExtensionFromLocation" },
      { type: "separator" },
      { type: "item", label: t("Restart Extension Host"), action: "workbench.action.restartExtensionHost" },
      { type: "item", label: t("Show Extension Host Log"), action: "workbench.action.showExtensionHostLog" },
      { type: "item", label: t("Open Extensions Folder"), action: "workbench.extensions.action.openExtensionsFolder" },
    ]).then((action) => action && runCommand(action));

  const gridAreaRef = useRef<HTMLDivElement>(null);

  const onGridResizeStart = (e: React.MouseEvent, splitId: string, index: number, direction: "row" | "column", span: number) => {
    e.preventDefault();
    const area = gridAreaRef.current?.getBoundingClientRect();
    if (!area) return;
    // The split's own size in pixels: deltas are fractions of it.
    const total = (direction === "row" ? area.width : area.height) * span;
    let last = direction === "row" ? e.clientX : e.clientY;
    const onMove = (ev: MouseEvent) => {
      const position = direction === "row" ? ev.clientX : ev.clientY;
      const delta = (position - last) / total;
      last = position;
      updateGrid((prev) => resizeSplit(prev, splitId, index, delta));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const dragAccepts = [TAB_DRAG_TYPE, FILE_DRAG_TYPE, TERMINAL_DRAG_TYPE];
  const singleGroup = leafIds(grid).length === 1;

  function renderGroup(groupId: string) {
    const group = groups[groupId];
    if (!group) return null;
    const isActive = groupId === activeGroupId;
    const path = group.activePath;
    const terminalId = isTerminalTab(path) ? terminalIdOf(path) : null;
    const webviewId = isWebviewTab(path) ? webviewIdOf(path) : null;
    const featureEditor = isFeatureEditorTab(path);
    const diff = parseDiffTab(path);
    const diffDocument = diff ? docs.current.get(diff.modified) : undefined;
    const showsEditor = !!path && !terminalId && !webviewId && !featureEditor && !diff;
    return (
      <div
        key={groupId}
        className={`editor-group${isActive ? " active" : ""}${singleGroup ? " single" : ""}`}
        onMouseDownCapture={() => focusGroup(groupId)}
        onFocusCapture={() => focusGroup(groupId)}
      >
        {group.tabs.length > 0 && !zenMode && (
          <TabBar
            tabs={withHints(group.tabs)}
            activePath={path}
            groupId={groupId}
            onSelect={(target) => {
              if (target !== path || !isActive) void openFile(target, { groupId });
            }}
            onClose={(target) => void closeTabs([target], groupId)}
            onPin={(target) => setTabs((prev) => prev.map((tab) => (tab.path === target ? { ...tab, preview: false } : tab)), groupId)}
            onAction={(action, target) => void handleTabAction(action, target, groupId)}
            onReorder={(from, to) =>
              setTabs((prev) => {
                const next = [...prev];
                const [moved] = next.splice(from, 1);
                next.splice(to, 0, moved!);
                return next;
              }, groupId)
            }
            onNewUntitled={() => {
              focusGroup(groupId);
              void newUntitled();
            }}
            onExternalDrop={(data, copy) => void dropIntoGroup(groupId, "center", data, copy)}
          />
        )}
        {showsEditor && settings["breadcrumbs.enabled"] && !zenMode && (
          <Breadcrumbs
            path={path}
            workspaceRoot={workspaceRoot}
            symbols={isActive ? symbols : null}
            cursorLine={isActive ? (cursor?.line ?? null) : null}
            onRevealFolder={(folder) => {
              showView("explorer");
              setTreeReveal({ path: folder, token: Date.now() });
            }}
            onRevealSymbol={revealSymbol}
            onShowSymbols={() => setQuick({ kind: "quick", value: "@" })}
          />
        )}
        {showsEditor && docs.current.get(path!)?.readOnlyMessage && (
          <div className="editor-readonly-banner" title={docs.current.get(path!)!.readOnlyMessage}>
            <div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(docs.current.get(path!)!.readOnlyMessage!) }} />
          </div>
        )}
        <div className="editor-host">
          {!path && singleGroup && <Welcome recent={recent} keys={keys} onRun={(id) => runCommand(id)} onOpenRecent={(folder) => void openWorkspace(folder)} />}
          {!group.tabs.length && !singleGroup && (
            <div className="empty-group">
              <button type="button" className="icon-btn empty-group-close" title={t("Close Editor Group")} onClick={() => void closeGroup(groupId)}>
                <X size={16} />
              </button>
              <div className="empty-group-hint">
                <LayoutPanelLeft size={40} strokeWidth={1} />
                <p>{t("Drop a tab, file or terminal here")}</p>
                <p className="muted">
                  {(() => {
                    const [before, after = ""] = t("or open one with {0}").split("{0}");
                    return (
                      <>
                        {before}
                        <kbd>{keys.get("workbench.action.quickOpen") ?? "Ctrl+P"}</kbd>
                        {after}
                      </>
                    );
                  })()}
                </p>
              </div>
            </div>
          )}
          <CodeMirrorEditor
            onReady={(editor) => registerEditor(groupId, editor)}
            onDispose={(editor) => unregisterEditor(groupId, editor)}
            hidden={!showsEditor}
          />
          {terminalId && (
            <div className="editor-terminal">
              <TerminalHost id={terminalId} editor />
            </div>
          )}
          {featureEditor && (
            <div className="editor-feature">
              <FeatureEditorView tabPath={path!} />
            </div>
          )}
          {webviewId && (
            <div className="editor-webview">
              <WebviewSlot slotKey={webviewId} placeholder={webviews.find((webview) => webview.id === webviewId)?.restoring ? t("Restoring…") : undefined} />
            </div>
          )}
          {diff && (
            <DiffEditor
              key={path}
              original={diff.original}
              modified={diff.modified}
              language={diffDocument?.language ?? "plaintext"}
              readOnly={!!diffDocument?.readOnly}
              initialSelection={diffSelections.current.get(path ?? "")}
              load={loadDiffContent}
              onEdit={editDiffDocument}
              onFocus={() => focusGroup(groupId)}
              autoFocus={diffAutoFocus.current.has(path ?? "")}
            />
          )}
          {(dragKind === "tab" || dragKind === "file" || dragKind === "terminal") && (
            <EditorDropTarget accepts={dragAccepts} onDrop={(zone, data, copy) => void dropIntoGroup(groupId, zone, data, copy)} />
          )}
        </div>
      </div>
    );
  }

  /** Groups positioned from the layout; rendered flat in creation order so none re-mounts. */
  function renderGrid() {
    const { leaves, sashes } = layoutGrid(grid);
    const percent = (value: number) => `${value * 100}%`;
    const ordered = [...leaves].sort((a, b) => Number(a.groupId.slice(1)) - Number(b.groupId.slice(1)));
    return (
      <>
        {ordered.map(({ groupId, rect }) => (
          <div
            key={groupId}
            className="editor-grid-cell"
            style={{ left: percent(rect.x), top: percent(rect.y), width: percent(rect.w), height: percent(rect.h) }}
          >
            {renderGroup(groupId)}
          </div>
        ))}
        {sashes.map((sash) => (
          <div
            key={`${sash.splitId}:${sash.index}`}
            className={`editor-split-sash sash-${sash.direction}`}
            style={
              sash.direction === "row"
                ? { left: percent(sash.rect.x), top: percent(sash.rect.y), height: percent(sash.rect.h) }
                : { left: percent(sash.rect.x), top: percent(sash.rect.y), width: percent(sash.rect.w) }
            }
            onMouseDown={(e) => onGridResizeStart(e, sash.splitId, sash.index, sash.direction, sash.span)}
            onDoubleClick={() => updateGrid((prev) => evenSizes(prev))}
          />
        ))}
      </>
    );
  }

  return (
    <div className={`app${zenMode ? " zen" : ""}${debugging ? " debugging" : ""}`}>
      <TitleBar
        commands={commands}
        keys={keys}
        centerLabel={workspaceRoot ? basename(workspaceRoot) : "Lumen"}
        onCommandCenter={() => setQuick({ kind: "quick", value: "" })}
      />

      <div className="workspace">
        {showActivityBar && (
          <nav
            className="activity-bar"
            aria-label={t("Activity")}
            onContextMenu={(e) => {
              e.preventDefault();
              activityMenu(e.clientX, e.clientY);
            }}
          >
            {shownActivity.map((item) => (
              <button
                key={item.view}
                className={`activity-btn${showSidebar && sideView === item.view ? " active" : ""}${activityDrop?.view === item.view ? ` drop-${activityDrop.after ? "after" : "before"}` : ""}`}
                type="button"
                title={`${item.title}${keys.get(item.command) ? ` (${keys.get(item.command)})` : ""}`}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(ACTIVITY_DRAG_TYPE, item.view);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes(ACTIVITY_DRAG_TYPE)) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  const rect = e.currentTarget.getBoundingClientRect();
                  const after = e.clientY > rect.top + rect.height / 2;
                  if (activityDrop?.view !== item.view || activityDrop.after !== after) setActivityDrop({ view: item.view, after });
                }}
                onDragLeave={() => setActivityDrop((drop) => (drop?.view === item.view ? null : drop))}
                onDrop={(e) => {
                  const view = e.dataTransfer.getData(ACTIVITY_DRAG_TYPE);
                  setActivityDrop(null);
                  if (!view) return;
                  e.preventDefault();
                  const rect = e.currentTarget.getBoundingClientRect();
                  moveActivity(view, item.view, e.clientY > rect.top + rect.height / 2);
                }}
                onDragEnd={() => setActivityDrop(null)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  activityMenu(e.clientX, e.clientY, item);
                }}
                onClick={() => {
                  if (showSidebar && sideView === item.view) setSidebarVisible(false);
                  else showView(item.view);
                }}
              >
                {item.icon}
                {item.badge ? <span className="activity-badge">{item.badge > 99 ? "99+" : item.badge}</span> : null}
                {item.extra}
              </button>
            ))}
            <div className="activity-spacer" />
            <button
              className="activity-btn"
              type="button"
              title={t("Manage — Settings ({0})", keys.get("workbench.action.openSettings") ?? "")}
              onClick={() => setSettingsOpen(true)}
            >
              <Settings size={21} strokeWidth={1.5} />
            </button>
          </nav>
        )}

        {showSidebar && (
          <>
            <aside className="sidebar" style={{ width: sidebarWidth }}>
              <div className="sidebar-header">
                <span>{sidebarTitle}</span>
                <div className="sidebar-actions">
                  {sideView === "explorer" && newEntryRoot && (
                    <>
                      <button className="icon-btn" type="button" title={t("New File…")} onClick={() => void createEntry("file", newEntryRoot)}>
                        <FilePlus size={16} strokeWidth={1.75} />
                      </button>
                      <button className="icon-btn" type="button" title={t("New Folder…")} onClick={() => void createEntry("folder", newEntryRoot)}>
                        <FolderPlus size={16} strokeWidth={1.75} />
                      </button>
                      <button className="icon-btn" type="button" title={t("Refresh Explorer")} onClick={() => setTreeRefresh((n) => n + 1)}>
                        <RefreshCw size={15} strokeWidth={1.75} />
                      </button>
                      <button className="icon-btn" type="button" title={t("Collapse Folders in Explorer")} onClick={() => setTreeCollapse((n) => n + 1)}>
                        <ListCollapse size={16} strokeWidth={1.75} />
                      </button>
                    </>
                  )}
                  {sideView === "scm" && (
                    <button className="icon-btn" type="button" title={t("Refresh")} onClick={() => void refreshGit()}>
                      <RefreshCw size={15} strokeWidth={1.75} />
                    </button>
                  )}
                  {sideView === "outline" && (
                    <button className="icon-btn" type="button" title={t("Collapse All")} onClick={() => setOutlineCollapse((n) => n + 1)}>
                      <ListCollapse size={16} strokeWidth={1.75} />
                    </button>
                  )}
                  {sideView === "extensions" && (
                    <>
                      <button className="icon-btn" type="button" title={t("Refresh")} onClick={() => void refreshExtensions()}>
                        <RefreshCw size={15} strokeWidth={1.75} />
                      </button>
                      <button
                        className="icon-btn"
                        type="button"
                        title={t("More Actions…")}
                        onClick={(e) => {
                          const rect = e.currentTarget.getBoundingClientRect();
                          extensionsMenu(rect.left, rect.bottom + 2);
                        }}
                      >
                        <Ellipsis size={16} strokeWidth={1.75} />
                      </button>
                    </>
                  )}
                </div>
              </div>
              <div className="sidebar-panel" hidden={sideView !== "explorer"}>
                {workspaceRoot && (
                  <div className="workspace-label" title={workspaceRoot}>
                    {basename(workspaceRoot)}
                  </div>
                )}
                <FileTreeView
                  workspaceRoot={workspaceRoot}
                  activePath={activePath}
                  refreshKey={treeRefresh}
                  reveal={treeReveal}
                  collapseToken={treeCollapse}
                  decorations={decorations}
                  onPaths={requestTreeDecorations}
                  onOpenFile={(path, options) => void openFile(path, { preview: options.preview, focus: !options.preview })}
                  onOpenFolder={() => void pickFolder()}
                  onContextAction={(e) => void handleTreeContext(e)}
                  onTransfer={(paths, targetDir, copy) => void transferProviderEntries(paths, targetDir, copy)}
                />
                {visibleViews(viewLayout.explorerViews).length > 0 && (
                  <>
                    <div
                      className="explorer-views-sash"
                      title={t("Drag to resize · Double-click to reset")}
                      onMouseDown={onExplorerViewsResizeStart}
                      onDoubleClick={() => setExplorerViewsHeight(null)}
                    />
                    <div className="explorer-views" style={explorerViewsHeight ? { flexBasis: explorerViewsHeight } : undefined}>
                      <ViewContainerView views={visibleViews(viewLayout.explorerViews)} webviews={webviews} alwaysHeaders />
                    </div>
                  </>
                )}
                {/* Features' sections (Timeline) follow the file of the active editor (a notebook's too). */}
                <FeatureExplorerSections
                  activePath={activePath ? (parseFeatureEditorTab(activePath)?.path ?? (isSpecialTab(activePath) ? null : activePath)) : null}
                />
              </div>
              {sideContainers.map((container) => (
                <div key={container.id} className="sidebar-panel" hidden={sideView !== `view:${container.id}`}>
                  <ViewContainerView views={visibleViews(container.views)} webviews={webviews} />
                </div>
              ))}
              <FeatureSidebarPanels sideView={sideView} />
              <div className="sidebar-panel" hidden={sideView !== "search"}>
                <SearchView
                  workspaceRoot={workspaceRoot}
                  providerRoots={providerRootPaths}
                  focusToken={searchFocus}
                  replaceToken={searchReplace}
                  initialQuery={searchSeed}
                  onOpenResult={(t) =>
                    void openFile(t.path, { preview: true, line: t.line, character: t.column, end: { line: t.line, character: t.column + t.length } })
                  }
                  replaceInOpenDocuments={replaceInOpenDocuments}
                  onReplaced={() => setTreeRefresh((n) => n + 1)}
                />
              </div>
              <div className="sidebar-panel" hidden={sideView !== "scm"}>
                <ScmView
                  status={git}
                  workspaceRoot={workspaceRoot}
                  busy={gitBusy}
                  syncing={gitSyncing}
                  onOpen={(file) => void openFile(file.path)}
                  onOpenChanges={(file, staged) => void scmOpenChanges(file, staged)}
                  onBranch={() => void checkoutPicker()}
                  onFetch={() => void gitRemoteAction("fetch")}
                  onPull={() => void gitRemoteAction("pull")}
                  onPush={() => void gitRemoteAction("push")}
                  onSync={() => void gitRemoteAction("sync")}
                  loadLog={loadGitLog}
                  loadCommitFiles={loadCommitFiles}
                  onOpenCommitFile={(commit, file) => void openCommitChange(commit, file.path, file.oldPath)}
                  onCopyHash={(commit) => void navigator.clipboard.writeText(commit.hash).catch(() => {})}
                  onStage={(files) => void gitAction((root) => api().request.gitStage({ root, paths: files.map((f) => f.path) }))}
                  onUnstage={(files) => void gitAction((root) => api().request.gitUnstage({ root, paths: files.map((f) => f.path) }))}
                  onDiscard={(files) =>
                    void showDialog({
                      title: t("Discard Changes"),
                      message:
                        files.length === 1
                          ? t("Are you sure you want to discard changes in {0}?", basename(files[0]!.path))
                          : t("Are you sure you want to discard ALL changes in {0} files?", files.length),
                      detail: files.some((f) => f.index === "?") ? t("Untracked files will be DELETED. This is IRREVERSIBLE!") : t("This is IRREVERSIBLE!"),
                      buttons: [
                        { label: t("Discard"), role: "danger", value: "discard" },
                        { label: t("Cancel"), role: "default", value: "cancel" },
                      ],
                    }).then((choice) => {
                      if (choice === "discard") {
                        void gitAction((root) => api().request.gitDiscard({ root, files: files.map((f) => ({ path: f.path, untracked: f.index === "?" })) }));
                      }
                    })
                  }
                  onCommit={async (message) => {
                    const staged = git?.files.some((f) => f.index !== " " && f.index !== "?") ?? false;
                    let stageAll = false;
                    if (!staged) {
                      const choice = await showDialog({
                        title: t("Commit"),
                        message: t("There are no staged changes to commit."),
                        detail: t("Would you like to stage all your changes and commit them directly?"),
                        buttons: [
                          { label: t("Yes"), role: "primary", value: "yes" },
                          { label: t("Cancel"), role: "default", value: "cancel" },
                        ],
                      });
                      if (choice !== "yes") return false;
                      stageAll = true;
                    }
                    const ok = await gitAction((root) => api().request.gitCommit({ root, message, stageAll }));
                    if (ok) {
                      toast(t("Committed"), "success");
                      const current = editorRef.current?.getCurrent()?.path;
                      if (current) void loadGitBase(current);
                    }
                    return ok;
                  }}
                  onRefresh={() => void refreshGit()}
                />
              </div>
              <div className="sidebar-panel" hidden={sideView !== "debug"}>
                <DebugView
                  workspaceRoot={workspaceRoot}
                  onStart={(config) => void startDebug({ config })}
                  onOpenLaunchJson={() => void openLaunchJson()}
                  onReveal={(path, line, column) => void revealDebugLocation(path, line, column, true)}
                />
              </div>
              <div className="sidebar-panel" hidden={sideView !== "outline"}>
                <OutlineView symbols={activePath ? symbols : null} cursorLine={cursor?.line ?? null} onReveal={revealSymbol} collapseToken={outlineCollapse} />
              </div>
              <div className="sidebar-panel" hidden={sideView !== "extensions"}>
                {ext.crashed && (
                  <div className="ext-crashed">
                    {t("The extension host stopped: {0}", ext.crashed)}
                    <button type="button" className="ext-install" onClick={() => void extensionService.restart()}>
                      {t("Restart")}
                    </button>
                  </div>
                )}
                <ExtensionsView
                  visible={showSidebar && sideView === "extensions"}
                  installed={installedExtensions}
                  activation={ext.activation}
                  busy={extensionBusy}
                  focusToken={extensionsFocus}
                  onInstall={(entry) => void installFromMarketplace(entry)}
                  onAction={(action, extension) => void extensionAction(action, extension)}
                  onShowDetails={setExtensionTarget}
                />
              </div>
            </aside>
            <div className="resizer" title={t("Resize sidebar")} onMouseDown={onSidebarResizeStart} />
          </>
        )}

        <main className={`main panel-at-${panelPosition}${panelMaximized && showPanelArea ? " panel-maximized" : ""}`}>
          {dragKind === "panel" && <DockOverlay kind="panel" panelPosition={panelPosition} onDrop={onDock} />}
          <DebugToolbar keys={keys} />
          <div className="editor-area editor-grid" ref={gridAreaRef}>
            {renderGrid()}
          </div>

          {showPanelArea && !panelMaximized && <div className="panel-resizer" title={t("Resize panel")} onMouseDown={onPanelResizeStart} />}
          <div
            className="panel-container"
            hidden={!showPanelArea}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(EDITOR_TERMINAL_DRAG_TYPE)) return;
              e.preventDefault();
              e.currentTarget.classList.add("terminal-drop");
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) e.currentTarget.classList.remove("terminal-drop");
            }}
            onDrop={(e) => {
              e.currentTarget.classList.remove("terminal-drop");
              const id = e.dataTransfer.getData(EDITOR_TERMINAL_DRAG_TYPE);
              if (!id) return;
              e.preventDefault();
              moveTerminalToPanel(id);
            }}
            style={panelMaximized ? undefined : panelPosition === "bottom" ? { height: panelHeight } : { width: panelWidth }}
          >
            <Panel
              tab={panelTab}
              position={panelPosition}
              onMove={movePanel}
              onTab={(tab) => (tab === "terminal" ? showPanel("terminal") : setPanelTab(tab))}
              onClose={() => {
                setPanelVisible(false);
                setPanelMaximized(false);
              }}
              maximized={panelMaximized}
              onToggleMaximize={() => setPanelMaximized((v) => !v)}
              diagnostics={allDiagnostics}
              references={references}
              workspaceRoot={workspaceRoot}
              onOpenLocation={(path, line, character) => void openFile(path, { line, character })}
              terminal={<TerminalPanelView visible={showPanelArea && panelTab === "terminal"} onAction={terminalAction} />}
              extraTabs={[
                { id: "view:debug-console" as const, label: t("Debug Console"), content: <DebugConsole /> },
                ...viewLayout.containers
                  .filter((container) => container.location === "panel" && visibleViews(container.views).length > 0)
                  .map((container) => ({
                    id: `view:${container.id}` as const,
                    label: container.title,
                    badge: viewBadge(container.views) || undefined,
                    content: <ViewContainerView views={visibleViews(container.views)} webviews={webviews} />,
                  })),
              ]}
              onSelectOutput={(name) => extensionService.showOutput(name)}
              onClearOutput={(name) => extensionService.clearOutput(name)}
              terminalActions={
                <>
                  <button type="button" className="icon-btn" title={t("New Terminal ({0})", "Ctrl+Shift+`")} onClick={() => newTerminal()}>
                    <Plus size={16} strokeWidth={1.75} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title={t("Launch Profile…")}
                    onClick={() => pickProfile((profileId) => newTerminal({ profileId }))}
                  >
                    <ChevronDown size={15} strokeWidth={1.75} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title={t("Split Terminal ({0})", "Ctrl+Shift+5")}
                    onClick={() => newTerminal({ splitWith: terminals.activeId ?? undefined })}
                  >
                    <SquareSplitHorizontal size={15} strokeWidth={1.75} />
                  </button>
                  <button type="button" className="icon-btn" title={t("Clear Terminal")} onClick={() => terminalService.clear(terminals.activeId)}>
                    <Eraser size={15} strokeWidth={1.75} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title={t("Kill Terminal")}
                    disabled={!terminals.activeId}
                    onClick={() => terminals.activeId && terminalAction("kill", terminals.activeId)}
                  >
                    <Trash2 size={15} strokeWidth={1.75} />
                  </button>
                </>
              }
            />
          </div>
        </main>

        {showAuxBarArea && (
          <>
            <div className="resizer" title={t("Resize secondary side bar")} onMouseDown={onAuxBarResizeStart} />
            <aside className="aux-sidebar" style={{ width: auxBarWidth }}>
              <div className="aux-sidebar-header">
                <div className="aux-sidebar-tabs" role="tablist">
                  {auxContainers.map((container) => (
                    <button
                      key={container.id}
                      type="button"
                      role="tab"
                      aria-selected={container === activeAuxContainer}
                      className={`aux-sidebar-tab${container === activeAuxContainer ? " active" : ""}`}
                      title={container.title}
                      onClick={() => setAuxBarView(container.id)}
                    >
                      {container.title}
                      {viewBadge(container.views) ? <span className="badge">{viewBadge(container.views)}</span> : null}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="icon-btn"
                  title={t("Hide Secondary Side Bar ({0})", keys.get("workbench.action.toggleAuxiliaryBar") ?? "")}
                  onClick={() => setAuxBarVisible(false)}
                >
                  <X size={16} strokeWidth={1.75} />
                </button>
              </div>
              {auxContainers.map((container) => (
                <div key={container.id} className="sidebar-panel" hidden={container !== activeAuxContainer}>
                  <ViewContainerView views={visibleViews(container.views)} webviews={webviews} />
                </div>
              ))}
            </aside>
          </>
        )}
      </div>

      {settings["workbench.statusBar.visible"] && !zenMode && (
        <StatusBar
          branch={git?.isRepo ? git.branch : null}
          sync={git?.upstream ? "sync" : git?.hasRemote && git.branch !== "(detached)" ? "publish" : null}
          syncing={gitSyncing}
          ahead={git?.ahead ?? 0}
          behind={git?.behind ?? 0}
          changes={scmCount}
          errors={errorCount}
          warnings={warningCount}
          cursor={editorActive ? cursor : null}
          blame={
            editorActive && cursor?.blame && settings["git.blame.statusBarItem.enabled"]
              ? { text: blameText(cursor.blame, false), title: blameTooltip(cursor.blame) }
              : null
          }
          indentation={
            editorActive ? (activeIndentation.insertSpaces ? t("Spaces: {0}", activeIndentation.tabSize) : t("Tab Size: {0}", activeIndentation.tabSize)) : null
          }
          eol={editorActive ? (activeDoc?.eol ?? null) : null}
          encoding={editorActive && activeDoc && activePath && !isVirtualDocument(activePath) ? encodingShortName(activeDoc.encoding ?? "utf8") : null}
          onEncoding={encodingPicker}
          language={activeLanguage && editorActive ? languageLabel(activeLanguage) : null}
          lsp={activeLanguage && editorActive && isSmart(activeLanguage) ? lspStatusLabel(activeLanguage) : null}
          message={statusMessage}
          autoSave={settings["files.autoSave"] !== "off"}
          onBranch={() => void checkoutPicker()}
          onSync={() => void gitRemoteAction("sync")}
          onBlame={() => {
            const blame = cursor?.blame;
            const path = editorRef.current?.getCurrent()?.path;
            if (blame && path && !blame.uncommitted) void openCommitChange({ hash: blame.hash, shortHash: blame.hash.slice(0, 7) }, path);
          }}
          onProblems={() => showPanel("problems", true)}
          onGotoLine={() => setQuick({ kind: "quick", value: ":" })}
          onIndentation={indentationPicker}
          onEol={eolPicker}
          onLanguage={changeLanguagePicker}
          onToggleTerminal={() => showPanel("terminal", true)}
          terminalActive={showPanelArea && panelTab === "terminal"}
          extensionItems={ext.statusItems}
          progress={ext.progress}
          onExtensionItem={(item: HostStatusBarItem) => item.command && runCommand(item.command.command, false, item.command.arguments?.[0])}
        />
      )}

      <QuickInput
        request={quick}
        onClose={() => {
          setQuick(null);
          requestAnimationFrame(() => {
            if (!document.querySelector(".modal-overlay") && !document.activeElement?.closest(".terminal-instance, .sidebar")) editorRef.current?.focus();
          });
        }}
        workspaceRoot={workspaceRoot}
        listFiles={async () => {
          const local = workspaceRoot ? (await api().request.listWorkspaceFiles({ root: workspaceRoot })).files : [];
          // VS Code searches provided schemes only through providers: walk their workspace folders instead.
          const provided = providerRootPaths.length ? await extensionService.call("providerListFiles", providerRootPaths, 20000).catch(() => []) : [];
          return [...local, ...provided];
        }}
        recentEditors={mru.current.filter((path) => path !== activePath)}
        commands={visiblePaletteCommands}
        keys={keys}
        recentCommands={quick ? recentCommandIds() : []}
        lineCount={activePath ? (editorRef.current?.view?.state.doc.lines ?? null) : null}
        currentLine={cursor?.line ?? null}
        loadSymbols={async () => flattenSymbols((await loadSymbols()) ?? [])}
        loadWorkspaceSymbols={async (query) => extensionService.call("provideWorkspaceSymbols", query)}
        onOpenFile={(path) => void openFile(path)}
        onRunCommand={(id) => runCommand(id, true)}
        onGotoLine={(line, column) => {
          pushNavigation();
          editorRef.current?.revealPosition(line - 1, column - 1);
        }}
        onGotoSymbol={revealSymbol}
        onGotoWorkspaceSymbol={gotoWorkspaceSymbol}
      />

      {groups[MODAL_GROUP] && (
        <div className="modal-overlay modal-editor-overlay" onMouseDown={(e) => e.target === e.currentTarget && void closeModalEditor()}>
          <div className={`modal-editor-part${modalMaximized ? " maximized" : ""}`} role="dialog" aria-modal="true" aria-label={t("Modal Editor")}>
            <div className="modal-editor-header" onDoubleClick={(e) => e.target === e.currentTarget && setModalMaximized((value) => !value)}>
              <span className="modal-editor-title">{groups[MODAL_GROUP].tabs.find((tab) => tab.path === groups[MODAL_GROUP]!.activePath)?.name ?? ""}</span>
              <ModalEditorTitleActions path={groups[MODAL_GROUP].activePath} maximized={modalMaximized} />
              <button type="button" className="icon-btn" title={t("Move into Editor Area")} onClick={() => void moveModalEditorToEditorArea()}>
                <LayoutPanelLeft size={14} />
              </button>
              <button
                type="button"
                className="icon-btn"
                title={modalMaximized ? t("Restore") : t("Maximize")}
                onClick={() => setModalMaximized((value) => !value)}
              >
                {modalMaximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
              <button type="button" className="icon-btn" title={t("Close")} onClick={() => void closeModalEditor()}>
                <X size={14} />
              </button>
            </div>
            <div className="modal-editor-body">{renderGroup(MODAL_GROUP)}</div>
          </div>
        </div>
      )}
      <SettingsEditor open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ExtensionDetails
        target={extensionTarget}
        activation={ext.activation}
        busy={extensionBusy}
        onClose={() => setExtensionTarget(null)}
        onInstall={(target) => target.marketplace && void installFromMarketplace(target.marketplace)}
        onAction={(action, extension) => void extensionAction(action, extension)}
      />
      <ShortcutsEditor
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
        commands={paletteCommands}
        bindings={bindings}
        overrides={overrides}
        onChangeOverrides={(next) => {
          setOverrides(next);
          saveKeybindingOverrides(next);
        }}
      />
      <ProcessExplorer open={processExplorerOpen} onClose={() => setProcessExplorerOpen(false)} />
    </div>
  );
}
