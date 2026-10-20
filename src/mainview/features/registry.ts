import type { Extension } from "@codemirror/state";
import type { ExtensionDescription, HostInputBox, HostQuickPick } from "../../shared/extensions";
import type { Command } from "../lib/commands";
import { extensionService } from "../lib/extensions";
import { api as rpcApi } from "../lib/rpc";
import { getSettings, onSettingsChange } from "../lib/settings";
import { notify } from "../lib/toast";
import { isDarkTheme, onColorThemeChange, themeColor } from "../lib/theme";
import { terminalService } from "../lib/terminals";
import { refreshFeatures } from "./store";
import type { FeatureEditorOpener, FeatureExplorerSection, FeaturePanelTab, FeatureSidebarView, FeatureStatusBarItem, ViewFeature, ViewFeatureApi } from "./types";
import { tasksView } from "./tasks";
import { scmView } from "./scm";
import { testingView } from "./testing";
import { notebooksView } from "./notebooks";
import { authenticationView } from "./authentication";
import { commentsView } from "./comments";
import { chatLmView } from "./chat-lm";
import { terminalView } from "./terminal";
import { languagesExtraView } from "./languages-extra";
import { workspaceMiscView } from "./workspace-misc";
import { iconThemesView } from "./icon-themes";
import { themingContribsView } from "./theming-contribs";
import { issueReporterView } from "./issue-reporter";
import { portsView } from "./ports";
import { timelineView } from "./timeline";
import { menusWalkthroughsView } from "./menus-walkthroughs";

/**
 * Registry of the window's feature plug-ins (one per area). The shell (App,
 * Panel, StatusBar, the editor, lib/extensions) asks it for what the features
 * add; nothing here is specific to an area. See
 * src/main/exthost/features/README.md.
 */

export type { ViewFeature, ViewFeatureApi } from "./types";
export { createStore, refreshFeatures, useStore } from "./store";

export const viewFeatures: readonly ViewFeature[] = [
  tasksView,
  scmView,
  testingView,
  notebooksView,
  authenticationView,
  commentsView,
  chatLmView,
  terminalView,
  languagesExtraView,
  workspaceMiscView,
  iconThemesView,
  themingContribsView,
  issueReporterView,
  portsView,
  timelineView,
  menusWalkthroughsView,
];

/* ── what the App provides ──────────────────────────────────────────────── */

/** The operations of the workbench features can use; App.tsx sets them once (setFeatureBridge). */
export type FeatureBridge = {
  openFile: (path: string, options: { line?: number; character?: number; preview?: boolean; focus?: boolean; beside?: boolean }) => Promise<boolean>;
  showQuickPick: (pick: HostQuickPick) => Promise<number[] | null>;
  showInputBox: (options: HostInputBox) => Promise<string | null>;
  /** Run a workbench command (built-in, feature or extension); false when there is no such command. */
  runCommand: (id: string, args: unknown[]) => boolean;
  /** Show a side bar view / panel tab by its tab id (`view:feature:<id>`). */
  showSideView: (view: string) => void;
  showPanelTab: (tab: string) => void;
  /** Show the dirty dot on a feature editor tab (by tab path). */
  markTabDirty: (tabPath: string, dirty: boolean) => void;
};

let bridge: FeatureBridge | null = null;
let initialised = false;
let pickSeq = 0;

export function setFeatureBridge(next: FeatureBridge): void {
  bridge = next;
}

/* ── ids of the surfaces ─────────────────────────────────────────────────── */

/** Side bar view / panel tab ids of features, as the App's `sideView` and `panelTab` spell them. */
export const FEATURE_VIEW_PREFIX = "view:feature:";
export const featureViewId = (id: string): `view:feature:${string}` => `${FEATURE_VIEW_PREFIX}${id}`;

/** Editor tabs of a feature editor: `feature-editor:<opener id>:<file path>`. */
const FEATURE_EDITOR_PREFIX = "feature-editor:";

export function isFeatureEditorTab(path: string | null | undefined): path is string {
  return !!path && path.startsWith(FEATURE_EDITOR_PREFIX);
}

export function featureEditorTabPath(openerId: string, path: string): string {
  return `${FEATURE_EDITOR_PREFIX}${openerId}:${path}`;
}

/** The opener id and file of a feature editor tab. */
export function parseFeatureEditorTab(tabPath: string | null | undefined): { openerId: string; path: string } | null {
  if (!isFeatureEditorTab(tabPath)) return null;
  const rest = tabPath.slice(FEATURE_EDITOR_PREFIX.length);
  const colon = rest.indexOf(":");
  return colon < 0 ? null : { openerId: rest.slice(0, colon), path: rest.slice(colon + 1) };
}

/** Files whose feature editor reports unsaved changes. */
const dirtyEditors = new Set<string>();

export const isFeatureEditorDirty = (tabPath: string): boolean => {
  const parsed = parseFeatureEditorTab(tabPath);
  return !!parsed && dirtyEditors.has(parsed.path);
};

/** Save through the opener of a feature editor tab; false when it cannot save. */
export async function saveFeatureEditor(tabPath: string): Promise<boolean> {
  const parsed = parseFeatureEditorTab(tabPath);
  const opener = parsed ? editorOpenerById(parsed.openerId) : null;
  if (!parsed || !opener?.save) return false;
  return await opener.save(parsed.path, featureApi(opener.area));
}

/* ── the API features get ───────────────────────────────────────────────── */

const apis = new Map<string, ViewFeatureApi>();

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function featureApi(area: string): ViewFeatureApi {
  let value = apis.get(area);
  if (value) return value;
  value = {
    area,
    sendToHost: (payload) => extensionService.post({ type: "feature", area, payload }),
    requestHost: async <T = unknown>(method: string, args: unknown[] = []) => (await extensionService.call("feature", area, method, args)) as T,
    executeCommand: (id, ...args) => {
      if (!bridge?.runCommand(id, args)) extensionService.executeCommand(id, args);
    },
    openFile: async (path, options = {}) => (bridge ? await bridge.openFile(path, options) : false),
    showQuickPick: async (items, options = {}) => {
      if (!bridge) return null;
      return await bridge.showQuickPick({
        id: --pickSeq,
        title: options.title,
        placeholder: options.placeholder,
        items,
        canPickMany: !!options.canPickMany,
        matchOnDescription: options.matchOnDescription,
        matchOnDetail: options.matchOnDetail,
      });
    },
    showInputBox: async (options = {}) => (bridge ? await bridge.showInputBox(options) : null),
    showMessage: (kind, message, actions = []) => notify(kind, message, actions),
    revealSidebarView: (id) => bridge?.showSideView(featureViewId(id)),
    revealPanelTab: (id) => bridge?.showPanelTab(featureViewId(id)),
    refresh: refreshFeatures,
    setEditorDirty: (path, dirty) => {
      if (dirty) dirtyEditors.add(path);
      else dirtyEditors.delete(path);
      const opener = findEditorOpener(path);
      if (opener) bridge?.markTabDirty(featureEditorTabPath(opener.id, path), dirty);
    },
    getExtensions: (): ExtensionDescription[] => extensionService.getSnapshot().extensions,
    getSettings,
    onSettingsChange,
    getExtensionSetting: (key) => extensionService.extensionSetting(key),
    readFile: async (path) => {
      const result = await rpcApi().request.readFile({ path });
      if ("error" in result) throw new Error(result.error);
      return result.content;
    },
    writeFile: async (path, content) => {
      const result = await rpcApi().request.writeFile({ path, content });
      if (!result.success) throw new Error(result.error ?? `Cannot write ${path}`);
    },
    theme: {
      color: (id) => themeColor(id),
      isDark: isDarkTheme,
      onChange: onColorThemeChange,
    },
    terminals: terminalService,
  };
  apis.set(area, value);
  return value;
}

/* ── lifecycle and host traffic ─────────────────────────────────────────── */

function guarded(area: string, what: string, run: () => void): void {
  try {
    run();
  } catch (error) {
    console.error(`[features] ${area}: ${what} failed`, error);
  }
}

/** Run every feature's `init` (once). */
export function initFeatures(): void {
  if (initialised) return;
  initialised = true;
  for (const feature of viewFeatures) guarded(feature.area, "init", () => feature.init?.(featureApi(feature.area)));
}

/** The host (re)started. */
export function notifyHostReady(): void {
  for (const feature of viewFeatures) guarded(feature.area, "onHostReady", () => feature.onHostReady?.(featureApi(feature.area)));
}

export function dispatchHostMessage(area: string, payload: unknown): void {
  const feature = viewFeatures.find((candidate) => candidate.area === area);
  if (!feature?.onHostMessage) return;
  guarded(area, "onHostMessage", () => feature.onHostMessage?.(payload, featureApi(area)));
}

export async function dispatchHostRequest(area: string, method: string, args: unknown[]): Promise<unknown> {
  const feature = viewFeatures.find((candidate) => candidate.area === area);
  if (!feature?.onHostRequest) throw new Error(`feature '${area}' does not handle '${method}'`);
  return await feature.onHostRequest(method, args, featureApi(area));
}

/* ── surfaces ───────────────────────────────────────────────────────────── */

export type OwnedSidebarView = FeatureSidebarView & { area: string };
export type OwnedPanelTab = FeaturePanelTab & { area: string };
export type OwnedEditorOpener = FeatureEditorOpener & { area: string };
export type OwnedStatusItem = FeatureStatusBarItem & { area: string };

const own = <T extends { id: string }>(feature: ViewFeature, list: T[] | undefined): (T & { area: string })[] => (list ?? []).map((entry) => ({ ...entry, area: feature.area }));

export const featureSidebarViews = (): OwnedSidebarView[] => viewFeatures.flatMap((feature) => own(feature, feature.sidebarViews));
export const featurePanelTabs = (): OwnedPanelTab[] => viewFeatures.flatMap((feature) => own(feature, feature.panelTabs));
export const featureStatusItems = (): OwnedStatusItem[] => viewFeatures.flatMap((feature) => own(feature, feature.statusBarItems));
export const featureExplorerSections = (): (FeatureExplorerSection & { area: string })[] => viewFeatures.flatMap((feature) => own(feature, feature.explorerSections));
const featureEditorOpeners = (): OwnedEditorOpener[] => viewFeatures.flatMap((feature) => own(feature, feature.editorOpeners));

/** The opener that renders the file's editor, if a feature claims it. */
export function findEditorOpener(path: string): OwnedEditorOpener | null {
  for (const opener of featureEditorOpeners()) {
    try {
      if (opener.match(path)) return opener;
    } catch (error) {
      console.error(`[features] ${opener.area}: opener '${opener.id}' failed to match`, error);
    }
  }
  return null;
}

export function editorOpenerById(id: string): OwnedEditorOpener | null {
  return featureEditorOpeners().find((opener) => opener.id === id) ?? null;
}

/** Palette commands of the features, plus "Show <view>" for their side bar views and panel tabs. */
export function featureCommands(): Command[] {
  const list: Command[] = [];
  for (const feature of viewFeatures) {
    const api = featureApi(feature.area);
    for (const command of feature.commands ?? []) {
      list.push({
        id: command.id,
        title: command.title,
        category: command.category,
        run: () => command.run(api),
        checked: command.checked ? () => command.checked!(api) : undefined,
        enabled: command.enabled ? () => command.enabled!(api) : undefined,
      });
    }
    for (const view of feature.sidebarViews ?? []) {
      list.push({ id: `workbench.view.feature.${view.id}`, title: `Show ${view.title}`, category: "View", run: () => bridge?.showSideView(featureViewId(view.id)) });
    }
    for (const tab of feature.panelTabs ?? []) {
      list.push({ id: `workbench.panel.feature.${tab.id}`, title: `Show ${tab.title}`, category: "View", run: () => bridge?.showPanelTab(featureViewId(tab.id)) });
    }
  }
  return list;
}

/** CodeMirror extensions the features add to a text editor of a document. */
export function featureEditorExtensions(path: string, languageId: string): Extension[] {
  const out: Extension[] = [];
  for (const feature of viewFeatures) {
    if (!feature.editorExtensions) continue;
    guarded(feature.area, "editorExtensions", () => out.push(...feature.editorExtensions!(path, languageId, featureApi(feature.area))));
  }
  return out;
}
