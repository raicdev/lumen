/**
 * Small persisted UI state: recently opened folders and, per workspace, the
 * editors that were open (restored on the next start, like VS Code).
 */

const RECENT_KEY = "lumen.recentFolders";
const LAYOUT_KEY = "lumen.layout";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

export function recentFolders(): string[] {
  return read<string[]>(RECENT_KEY, []);
}

export function addRecentFolder(path: string): void {
  const next = [path, ...recentFolders().filter((p) => p.toLowerCase() !== path.toLowerCase())].slice(0, 12);
  write(RECENT_KEY, next);
}

export function removeRecentFolder(path: string): void {
  write(
    RECENT_KEY,
    recentFolders().filter((p) => p !== path),
  );
}

export function clearRecentFolders(): void {
  write(RECENT_KEY, []);
}

export type EditorSession = {
  /** All open files (every group), for older sessions and fallbacks. */
  tabs: string[];
  active: string | null;
  /** Split editor layout: group id → its files, plus the layout tree. */
  groups?: Record<string, { tabs: string[]; active: string | null }>;
  grid?: unknown;
  activeGroup?: string;
};

export function loadEditorSession(root: string): EditorSession | null {
  return read<EditorSession | null>(`lumen.session:${root.toLowerCase()}`, null);
}

export function saveEditorSession(root: string, session: EditorSession): void {
  write(`lumen.session:${root.toLowerCase()}`, session);
}

export type Layout = {
  sidebarVisible: boolean;
  sidebarWidth: number;
  /** `view:<id>`: a view container contributed by an extension. */
  sideView: "explorer" | "search" | "scm" | "debug" | "outline" | "extensions" | `view:${string}`;
  panelVisible: boolean;
  panelHeight: number;
  /** Width when the panel is docked left or right. */
  panelWidth: number;
  panelPosition: "bottom" | "left" | "right";
  panelTab: "problems" | "terminal" | "references" | "output" | `view:${string}`;
  /** Height of the extension views under the Explorer's files (null: the default share). */
  explorerViewsHeight?: number | null;
  /** The secondary side bar (right): shown, its width and the container it shows. */
  auxBarVisible?: boolean;
  auxBarWidth?: number;
  auxBarView?: string | null;
};

export const DEFAULT_LAYOUT: Layout = {
  sidebarVisible: true,
  sidebarWidth: 260,
  sideView: "explorer",
  panelVisible: false,
  panelHeight: 240,
  panelWidth: 420,
  panelPosition: "bottom",
  panelTab: "terminal",
};

/** A terminal to recreate: its shell, folder, custom name (`title`) and last shown name (`name`). */
export type SavedTerminal = { profileId?: string; cwd?: string; title?: string; name?: string };

/**
 * Everything about a project's window arrangement, saved per project by the
 * main process (app data folder). Terminal tabs in `editors` are stored as
 * "terminal:#<index into terminals.list>".
 */
export type WorkspaceState = {
  version: 1;
  layout: Layout;
  editors: EditorSession;
  terminals: {
    list: SavedTerminal[];
    /** Panel split groups, as indexes into `list`. */
    panelGroups: number[][];
    activePanel: number | null;
  };
  /** Webview panels of extensions (restored by their serializers); tabs refer to them as "webview:#<index>". */
  webviews?: { viewType: string; title: string; state: unknown; options: import("../../shared/extensions").HostWebviewOptions | null }[];
};

export function loadLayout(): Layout {
  return { ...DEFAULT_LAYOUT, ...read<Partial<Layout>>(LAYOUT_KEY, {}) };
}

export function saveLayout(layout: Layout): void {
  write(LAYOUT_KEY, layout);
}
