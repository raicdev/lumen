import { defineViewRPC } from "@lumen/shell/view";
import type { LumenRPC } from "../../shared/types";

type CloseCheckHandler = () => Promise<{ allow: boolean; dirtyCount: number }>;

let closeCheckHandler: CloseCheckHandler | null = null;

export function setCloseCheckHandler(handler: CloseCheckHandler) {
  closeCheckHandler = handler;
}

/**
 * Renderer side of the typed IPC bridge (Lumen Shell replaces Electroview).
 * Inbound events keep flowing through the same window CustomEvents, so the UI
 * components do not need to know about the transport.
 */
export const rpc = defineViewRPC<LumenRPC>({
  handlers: {
    requests: {
      requestCloseCheck: async () => {
        if (closeCheckHandler) return await closeCheckHandler();
        return { allow: true, dirtyCount: 0 };
      },
    },
    messages: {
      menuAction: ({ action }) => {
        window.dispatchEvent(new CustomEvent("lumen:menu", { detail: { action } }));
      },
      diagnostics: ({ diagnostics }) => {
        window.dispatchEvent(
          new CustomEvent("lumen:diagnostics", { detail: { diagnostics } }),
        );
      },
      forceQuit: () => {
        window.dispatchEvent(new CustomEvent("lumen:force-quit"));
      },
      terminalData: ({ id, data }) => {
        window.dispatchEvent(
          new CustomEvent("lumen:terminal-data", { detail: { id, data } }),
        );
      },
      workspaceChanged: ({ paths, git }) => {
        window.dispatchEvent(new CustomEvent("lumen:workspace-changed", { detail: { paths, git } }));
      },
      extHost: ({ message }) => {
        window.dispatchEvent(new CustomEvent("lumen:ext-host", { detail: message }));
      },
      terminalExit: ({ id, code }) => {
        window.dispatchEvent(
          new CustomEvent("lumen:terminal-exit", { detail: { id, code } }),
        );
      },
    },
  },
});

/** Typed accessor kept for parity with the previous Electroview helper. */
export function api() {
  return rpc;
}
