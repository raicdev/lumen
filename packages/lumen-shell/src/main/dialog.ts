import type { NativeHandle } from "./native/webview.ts";
import { platform } from "./native/index.ts";
import type { MessageBoxOptions, OpenDialogOptions, SaveDialogOptions } from "./native/platform.ts";
import { app } from "./app.ts";

function ownerHandle(): NativeHandle | undefined {
  return app.lastWindow?.handle;
}

/** Native (OS) dialogs, owned by the focused window. */
export const dialog = {
  /** Returns the chosen paths (empty when cancelled). */
  async showOpenDialog(options: OpenDialogOptions = {}): Promise<string[]> {
    return platform().showOpenDialog(options, ownerHandle());
  },

  /** Returns the chosen path, or `null` when cancelled. */
  async showSaveDialog(options: SaveDialogOptions = {}): Promise<string | null> {
    return platform().showSaveDialog(options, ownerHandle());
  },

  /** Returns the index of the button the user pressed. */
  async showMessageBox(options: MessageBoxOptions): Promise<{ response: number }> {
    return platform().showMessageBox(options, ownerHandle());
  },
};
