import { platform } from "./native/index.ts";

/** Shell helpers (reveal in file manager, open with the default app). */
export const shell = {
  showItemInFolder(path: string): void {
    platform().showItemInFolder(path);
  },

  openPath(path: string): void {
    platform().openPath(path);
  },
};
