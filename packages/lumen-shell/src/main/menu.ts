import { app } from "./app.ts";
import { platform } from "./native/index.ts";
import type { MenuGroup } from "./native/platform.ts";

/**
 * Application menu.
 *
 * - Windows: installed as a real Win32 menu bar; clicks are emitted as
 *   `menu-action` events on the owning window.
 * - macOS / Linux: rendered inside the page by the shell prelude, which
 *   dispatches the same `menu-action` events.
 *
 * Accelerators are display-only: the page keeps owning keyboard shortcuts so
 * that editor keymaps (CodeMirror) stay authoritative.
 */
export const Menu = {
  setApplicationMenu(menu: MenuGroup[] | null): void {
    const native = platform().name === "win32";
    for (const window of app.windows) {
      if (window.destroyed) continue;
      if (native) platform().setMenu(window.handle, menu);
      else window.webContents.installMenu(menu ?? []);
    }
  },
};

export type { MenuGroup, MenuEntry } from "./native/platform.ts";
