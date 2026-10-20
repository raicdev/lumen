export { defineViewRPC } from "./rpc.ts";
export type { ShellBridge, ViewRPC, ViewRPCOptions, WindowControls, WindowState } from "./rpc.ts";
export type { MenuEntry, MenuGroup } from "../shared/menu.ts";

/**
 * True when the page runs inside Lumen Shell (as opposed to a plain browser,
 * where `defineViewRPC()` gives you graceful failures for UI development).
 */
export function isShellAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.__lumen?.invoke === "function";
}
