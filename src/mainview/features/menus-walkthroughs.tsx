import type { ResourceLabelFormatter } from "../../shared/menus-walkthroughs";
import type { ViewFeature, ViewFeatureApi } from "./types";
import { installExplorerMenu, installTabMenu, menuEditorExtensions } from "./menus-walkthroughs/editor";
import {
  WALKTHROUGH_PATH_PREFIX,
  checkOpenOnInstall,
  commandExecuted,
  lookupWalkthrough,
  markStepDone,
  openWalkthrough,
  openWelcomePage,
  pickWalkthrough,
  refreshFeatured,
  resetProgress,
  selectStepByKey,
  setApi,
  setRuntimeFormatters,
  startCompletionWatch,
  useWalkthroughs,
} from "./menus-walkthroughs/state";
import { WalkthroughView, clearMediaCache } from "./menus-walkthroughs/WalkthroughView";
import { resolveContributedMenu, runMenuCommand } from "./menus-walkthroughs/menus";
import { flattenMenu } from "../../shared/menus-walkthroughs";

/**
 * Window side of the "menus-walkthroughs" area:
 *  - contributed menus: submenus everywhere (menus.ts), editor/context and editor/title in the text editor,
 *    explorer/context in the explorer's context menu (editor.ts);
 *  - walkthroughs: the page in an editor tab (this file) and on the Welcome page (components/Welcome.tsx),
 *    progress and completion events (state.ts);
 *  - resourceLabelFormatters: labels of non-file resources in the editor's title strip, the tabs and the
 *    breadcrumbs (state.ts `resourceLabel` / `resourceTabLabel`, labels.ts `labelOf`).
 * Styles: feature-menus-walkthroughs.css.
 */

async function showNewFileEntries(api: ViewFeatureApi): Promise<void> {
  const builtIn = [
    { label: "Text File", description: "Built-in", command: "workbench.action.files.newUntitledFile" },
    { label: "File in Explorer…", description: "Built-in", command: "explorer.newFile" },
  ];
  const extensions = api.getExtensions();
  const contributed = flattenMenu(resolveContributedMenu("file/newFile", () => undefined)).map((item) => ({
    label: item.title,
    description: extensions.find((extension) => extension.id.toLowerCase() === item.extensionId.toLowerCase())?.manifest.displayName ?? item.extensionId,
    command: item.command,
  }));
  const entries = [...builtIn, ...contributed];
  const picked = await api.showQuickPick(
    entries.map(({ label, description }) => ({ label, description })),
    { title: "New File…", placeholder: "Select File Type or Enter File Name…", matchOnDescription: true },
  );
  const entry = picked?.[0] !== undefined ? entries[picked[0]] : undefined;
  if (!entry) return;
  if (contributed.includes(entry)) runMenuCommand(entry.command, []);
  else api.executeCommand(entry.command);
}

function WalkthroughEditor({ path }: { path: string }) {
  const walkthroughs = useWalkthroughs();
  const key = path.slice(WALKTHROUGH_PATH_PREFIX.length).toLowerCase();
  const walkthrough = walkthroughs.find((candidate) => candidate.key.toLowerCase() === key);
  if (!walkthrough) return <div className="walkthrough-missing muted">This walkthrough is not available (its extension is disabled or not installed).</div>;
  return <WalkthroughView walkthrough={walkthrough} />;
}

export const menusWalkthroughsView: ViewFeature = {
  area: "menus-walkthroughs",

  init: (api) => {
    setApi(api);
    installExplorerMenu();
    installTabMenu();
    startCompletionWatch();
  },

  onHostReady: (api) => {
    setApi(api);
    clearMediaCache();
    setRuntimeFormatters([]);
    startCompletionWatch();
    refreshFeatured(true);
    checkOpenOnInstall();
  },

  onHostMessage: (payload) => {
    const message = payload as { type: string; key?: string; step?: string; toSide?: boolean; done?: boolean; ids?: string[]; formatters?: ResourceLabelFormatter[] };
    switch (message.type) {
      case "open":
        if (message.key) void openWalkthrough(message.key, message.step, message.toSide === true);
        break;
      case "welcome":
        void openWelcomePage();
        break;
      case "pick":
        void pickWalkthrough();
        break;
      case "mark":
        if (message.key) markStepDone(message.key, message.done !== false);
        break;
      case "select":
        if (message.key) selectStepByKey(message.key);
        break;
      case "reset":
        resetProgress();
        break;
      case "commands":
        for (const id of message.ids ?? []) commandExecuted(id);
        break;
      case "formatters":
        setRuntimeFormatters(message.formatters ?? []);
        break;
    }
  },

  commands: [
    { id: "welcome.showAllWalkthroughs", title: "Open Walkthrough...", category: "Welcome", run: () => pickWalkthrough() },
    { id: "resetGettingStartedProgress", title: "Reset Welcome Page Walkthrough Progress", category: "Developer", run: () => resetProgress() },
    // File > New File…: a text file, a file in the explorer, or what extensions add to file/newFile.
    { id: "welcome.showNewFileEntries", title: "New File…", category: "File", run: (api) => showNewFileEntries(api) },
  ],

  editorOpeners: [
    {
      id: "menus-walkthroughs.walkthrough",
      match: (path) => path.startsWith(WALKTHROUGH_PATH_PREFIX),
      title: (path) => lookupWalkthrough(path.slice(WALKTHROUGH_PATH_PREFIX.length))?.title ?? "Walkthrough",
      render: (path) => <WalkthroughEditor path={path} />,
    },
  ],

  editorExtensions: (path, languageId) => menuEditorExtensions(path, languageId),
};
