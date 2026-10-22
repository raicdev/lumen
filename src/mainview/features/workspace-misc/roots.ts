import { createStore } from "../store";

/** A workspace folder extensions added (workspace.updateWorkspaceFolders), shown by the explorer. */
export type ExplorerRoot = {
  uri: string;
  name: string;
  scheme: string;
  /** The window's document key (`memfs:/`, a local path). */
  path: string;
};

/** Extra explorer roots, as announced by the workspace-misc host feature. */
export const explorerRoots = createStore<ExplorerRoot[]>([]);
