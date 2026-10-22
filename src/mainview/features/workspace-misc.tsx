import type { ViewFeature } from "./types";
import { explorerRoots, type ExplorerRoot } from "./workspace-misc/roots";

/** Window side of the "workspace-misc" area: the "Open URI…" command that hands a lumen:// URI to an extension's URI handler, and the extra workspace folders of the explorer. Styles: feature-workspace-misc.css. */
export const workspaceMiscView: ViewFeature = {
  area: "workspace-misc",
  onHostMessage: (payload) => {
    const message = payload as { type?: string; folders?: ExplorerRoot[] } | null;
    if (message?.type === "folders" && Array.isArray(message.folders)) explorerRoots.set(message.folders);
  },
  commands: [
    {
      id: "workbench.action.openUri",
      title: "Open URI…",
      category: "Developer",
      run: async (api) => {
        const uri = await api.showInputBox({
          title: "Open URI",
          prompt: "lumen://<publisher.extension>/<path>?<query>",
          placeholder: "lumen://publisher.extension/path",
        });
        if (uri?.trim()) api.sendToHost({ type: "uri", uri: uri.trim() });
      },
    },
  ],
};
