import type {
  RpcApi,
  RpcHandlers,
  RpcHandlersOf,
  RPCSchema,
  ResEnvelope,
} from "../shared/protocol.ts";
import type { MenuGroup } from "../shared/menu.ts";
import { RpcEndpoint, createApi } from "../shared/rpc.ts";

/**
 * JSON for the native bridge. The webview library drops any message holding a
 * raw U+007F (DEL, what Backspace sends to a terminal), so it goes as an escape.
 */
function bridgeJson(envelope: unknown): string {
  return JSON.stringify(envelope).replace(/\x7f/g, "\\u007f");
}

export type WindowState = "normal" | "maximized" | "minimized";

/** Window chrome controls for frameless windows (`frame: false`). */
export type WindowControls = {
  minimize(): void;
  toggleMaximize(): void;
  /** Close through the shell, honouring the close guard. */
  close(): void;
  /** Start moving the window (call while the mouse button is held down). */
  startDrag(): void;
};

/** Shape of the prelude bridge (`window.__lumen`). */
export type ShellBridge = {
  version: number;
  /** The window has no OS title bar; the page draws its own. */
  frameless: boolean;
  windowState: WindowState;
  window: WindowControls;
  setWindowState(state: WindowState): void;
  setMaximizeButtonState(hover: boolean, pressed: boolean): void;
  invoke(channel: string, data: string): Promise<unknown>;
  receive(raw: string): void;
  onEnvelope(listener: (raw: string) => void): void;
  installMenu(groups: MenuGroup[]): void;
  menuAction(action: string): void;
};

declare global {
  interface Window {
    __lumen?: ShellBridge;
    __lumen_invoke?: (channel: string, data: string) => Promise<unknown>;
  }
}

export type ViewRPCOptions<S extends RPCSchema> = {
  handlers?: {
    requests?: Partial<RpcHandlersOf<S, "webview">["requests"]>;
    messages?: Partial<RpcHandlersOf<S, "webview">["messages"]>;
  };
  timeoutMs?: number;
  log?: (message: string) => void;
};

export type ViewRPC<S extends RPCSchema> = RpcApi<S, "main"> & {
  /** The underlying endpoint (escape hatch for untyped channels). */
  readonly endpoint: RpcEndpoint;
  /** Tear down all pending requests (used on page unload). */
  close(): void;
};

function bridge(): ShellBridge {
  const current = window.__lumen;
  if (current) return current;

  // Fallback used when the bundle is opened in a plain browser (UI work without
  // the native shell). Every call fails loudly, nothing crashes.
  const missing = (): never => {
    throw new Error("Lumen Shell bridge is unavailable (page opened outside the shell)");
  };
  return {
    version: 0,
    frameless: false,
    windowState: "normal",
    window: { minimize: () => {}, toggleMaximize: () => {}, close: () => {}, startDrag: () => {} },
    setWindowState: () => {},
    setMaximizeButtonState: () => {},
    invoke: async () => missing(),
    receive: () => {},
    onEnvelope: () => {},
    installMenu: () => {},
    menuAction: () => {},
  };
}

/**
 * Register the renderer side of a typed RPC schema.
 *
 * ```ts
 * const rpc = defineViewRPC<LumenRPC>({
 *   handlers: { requests: { requestCloseCheck }, messages: { menuAction } },
 * });
 * const file = await rpc.request.readFile({ path });
 * ```
 */
export function defineViewRPC<S extends RPCSchema>(options: ViewRPCOptions<S> = {}): ViewRPC<S> {
  const shell = bridge();

  const handlers: RpcHandlers = {
    requests: (options.handlers?.requests ?? {}) as RpcHandlers["requests"],
    messages: {
      ...((options.handlers?.messages ?? {}) as RpcHandlers["messages"]),
      // Framework channel: render the in-page menu bar where needed.
      "__lumen:install-menu": (groups: MenuGroup[]) => shell.installMenu(groups),
    } as RpcHandlers["messages"],
  };

  const endpoint = new RpcEndpoint({
    ns: "webview",
    peerNs: "main",
    handlers,
    timeoutMs: options.timeoutMs ?? 60_000,
    log: options.log ?? ((message) => console.warn(`[lumen-shell] ${message}`)),
    outbound: async (envelope) => {
      const response = await shell.invoke("__lumen:ipc", bridgeJson(envelope));
      return (response ?? null) as ResEnvelope | null;
    },
  });

  shell.onEnvelope((raw) => {
    // Requests from the main process expect their response back over the bridge.
    void endpoint.receive(raw).then((response) => {
      if (response) void shell.invoke("__lumen:ipc", bridgeJson(response)).catch(() => {});
    });
  });

  const api = createApi<S, "main">(endpoint);

  return {
    ...api,
    endpoint,
    close: () => endpoint.close("View was unloaded"),
  };
}
