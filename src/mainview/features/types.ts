import type { ComponentType, ReactNode } from "react";
import type { Extension } from "@codemirror/state";
import type { ExtensionDescription } from "../../shared/extensions";
import type { Settings } from "../lib/settings";
import type { terminalService } from "../lib/terminals";

/**
 * Plug-in point of the window for one area (tasks, scm, notebooks, …): the
 * counterpart of a HostFeature (src/main/exthost/features). Everything is
 * optional. See src/main/exthost/features/README.md.
 */

/** A lucide-react icon component, or a codicon id such as `"beaker"`. */
export type FeatureIcon = ComponentType<{ size?: number; strokeWidth?: number }> | string;

export type FeaturePickItem = { label: string; description?: string; detail?: string; picked?: boolean };

export type ViewFeatureApi = {
  readonly area: string;

  /* host */
  /** A message to the HostFeature of this area (`onViewMessage`). */
  sendToHost(payload: unknown): void;
  /** A request to the HostFeature of this area (`onViewRequest`); rejects when the host does not answer. */
  requestHost<T = unknown>(method: string, args?: unknown[]): Promise<T>;

  /* workbench */
  /** Run a workbench command (palette commands of features included); ones the window does not know go to the extension host. */
  executeCommand(id: string, ...args: unknown[]): void;
  /** Open a file in the editor (the file's editor opener, a custom editor or the text editor). */
  openFile(path: string, options?: { line?: number; character?: number; preview?: boolean; focus?: boolean; beside?: boolean }): Promise<boolean>;
  /** Quick pick; the indexes of the picked items (`null` when cancelled). */
  showQuickPick(
    items: FeaturePickItem[],
    options?: { title?: string; placeholder?: string; canPickMany?: boolean; matchOnDescription?: boolean; matchOnDetail?: boolean },
  ): Promise<number[] | null>;
  showInputBox(options?: { title?: string; prompt?: string; value?: string; placeholder?: string; password?: boolean }): Promise<string | null>;
  /** A notification; the index of the pressed action (`null` when dismissed). */
  showMessage(kind: "info" | "warning" | "error", message: string, actions?: string[]): Promise<number | null>;
  /** Show a side bar view / panel tab of a feature (their `id`). */
  revealSidebarView(id: string): void;
  revealPanelTab(id: string): void;
  /** Re-evaluate `badge()`, `statusBarItems()` and the panel tab list. */
  refresh(): void;
  /** Mark the editor tab an opener renders for `path` as dirty / clean (dot on the tab, "save?" prompt when closing). */
  setEditorDirty(path: string, dirty: boolean): void;

  /* data */
  /** Enabled extensions as loaded by the host, with their manifests (`manifest.contributes`). */
  getExtensions(): ExtensionDescription[];
  /** The window's own settings. */
  getSettings(): Settings;
  onSettingsChange(listener: () => void): () => void;
  /** An extension setting (contributes.configuration), falling back to its default. */
  getExtensionSetting(key: string): unknown;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  theme: {
    /** The value of a theme color id (`"editor.background"`), when the theme sets it. */
    color(id: string): string | undefined;
    isDark(): boolean;
    onChange(listener: () => void): () => void;
  };
  /** The integrated terminals (lib/terminals.ts). */
  terminals: typeof terminalService;
};

export type FeatureCommand = {
  /** Command id (also what extensions and keybindings use). */
  id: string;
  title: string;
  /** Palette prefix: "View" gives "View: Title". */
  category?: string;
  run(api: ViewFeatureApi): unknown;
  checked?(api: ViewFeatureApi): boolean;
  /** Hidden from the palette when it returns false. */
  enabled?(api: ViewFeatureApi): boolean;
};

/** A side bar view with an activity bar button. Gets the command `workbench.view.feature.<id>`. */
export type FeatureSidebarView = {
  /** Unique across all features. */
  id: string;
  title: string;
  icon: FeatureIcon;
  /** Kept mounted while hidden; use `useStore` for state. */
  render(): ReactNode;
  badge?(): number;
};

/** A bottom panel tab. Gets the command `workbench.panel.feature.<id>`. */
export type FeaturePanelTab = {
  id: string;
  title: string;
  render(): ReactNode;
  badge?(): number;
};

/** A collapsible section at the bottom of the Explorer (Timeline), under the file tree. */
export type FeatureExplorerSection = {
  /** Unique across all features. */
  id: string;
  title: string;
  /** The section's body; `activePath` is the file of the active editor. */
  render(context: { activePath: string | null }): ReactNode;
  /** Buttons in the header (shown while the section is open). */
  actions?(context: { activePath: string | null }): ReactNode;
  /** Starts collapsed (until the user opens it once). */
  collapsed?: boolean;
};

/** Renders the whole editor of a file (notebooks): opening a matching file makes a tab of its own instead of a text editor. */
export type FeatureEditorOpener = {
  /** Unique across all features. */
  id: string;
  /** Does this opener handle the file? Called for every file that is opened (keep it cheap: test the extension). */
  match(path: string): boolean;
  /** Rendered in the editor group while the tab is active (it unmounts when another tab is shown). */
  render(path: string, api: ViewFeatureApi): ReactNode;
  /** The tab's title (default: the file name). */
  title?(path: string): string;
  /** Save (Ctrl+S, "Save" when closing a dirty tab); true when saved. Needed when the editor reports itself dirty (`api.setEditorDirty`). */
  save?(path: string, api: ViewFeatureApi): Promise<boolean>;
};

export type FeatureStatusBarItem = {
  id: string;
  side: "left" | "right";
  /** Higher comes first. */
  priority?: number;
  /** Text with `$(codicon)` references; an empty text hides the item. */
  text(): string;
  tooltip?(): string | undefined;
  /** Command run on click (an item without one is plain text). */
  command?: string;
  color?(): string | undefined;
};

export interface ViewFeature {
  readonly area: string;
  /** Once, when the window starts. */
  init?(api: ViewFeatureApi): void;
  /** The extension host (re)started and told the window about the extensions. */
  onHostReady?(api: ViewFeatureApi): void;
  /** A message from the HostFeature of this area (`host.postFeature`). */
  onHostMessage?(payload: unknown, api: ViewFeatureApi): void;
  /** A request from the HostFeature of this area (`host.requestFeatureView`); the result must be JSON-like. */
  onHostRequest?(method: string, args: unknown[], api: ViewFeatureApi): Promise<unknown> | unknown;
  commands?: FeatureCommand[];
  sidebarViews?: FeatureSidebarView[];
  panelTabs?: FeaturePanelTab[];
  explorerSections?: FeatureExplorerSection[];
  editorOpeners?: FeatureEditorOpener[];
  /** CodeMirror extensions added to every text editor (state is per document, like the rest of the editor's extensions). */
  editorExtensions?(path: string, languageId: string, api: ViewFeatureApi): Extension[];
  statusBarItems?: FeatureStatusBarItem[];
}
