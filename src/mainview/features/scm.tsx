import type { ScmHostMessage } from "../../shared/scm-protocol";
import { applySnapshot, resetSnapshot, scmStore, statusCommands } from "./scm-store";
import { quickDiffExtension } from "./scm-gutter";
import type { FeatureCommand, FeatureStatusBarItem, ViewFeature } from "./types";

/**
 * Window side of the "scm" area: keeps the extension source controls the host
 * reports; the Source Control view (components/ScmView) renders them, status
 * bar slots show their status commands and editors get the quick diff gutter.
 */

const STATUS_SLOTS = 4;

const slotCommands: FeatureCommand[] = Array.from({ length: STATUS_SLOTS }, (_, slot) => ({
  id: `lumen.scm.statusBar.${slot}`,
  title: `Run Source Control Status Command ${slot + 1}`,
  category: "Source Control",
  enabled: () => !!statusCommands()[slot],
  run: (api) => {
    const entry = statusCommands()[slot];
    if (entry) api.sendToHost({ kind: "statusCommand", handle: entry.handle, index: entry.index });
  },
}));

const slotItems: FeatureStatusBarItem[] = Array.from({ length: STATUS_SLOTS }, (_, slot) => ({
  id: `scm.status.${slot}`,
  side: "left",
  priority: 5 - slot,
  text: () => statusCommands()[slot]?.title ?? "",
  tooltip: () => statusCommands()[slot]?.tooltip,
  command: `lumen.scm.statusBar.${slot}`,
}));

const isVirtualPath = (path: string) => /^[a-zA-Z][\w+.-]+:/.test(path) && !/^[a-zA-Z]:[\\/]/.test(path);

export const scmView: ViewFeature = {
  area: "scm",
  init: (api) => {
    // Status items and badges follow the snapshot.
    scmStore.subscribe(() => api.refresh());
  },
  onHostReady: (api) => {
    resetSnapshot();
    api.sendToHost({ kind: "ready" });
  },
  onHostMessage: (payload) => {
    const message = payload as ScmHostMessage;
    if (message.kind === "state") applySnapshot(message.snapshot);
  },
  commands: slotCommands,
  statusBarItems: slotItems,
  editorExtensions: (path, _languageId, api) => (isVirtualPath(path) ? [] : quickDiffExtension(path, api)),
};
