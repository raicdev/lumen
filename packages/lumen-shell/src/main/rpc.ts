import type { RpcHandlers, RpcHandlersOf, RPCSchema } from "../shared/protocol.ts";
import type { RpcAttachment } from "./window.ts";

export type DefineMainRPCOptions<S extends RPCSchema> = {
  handlers: {
    requests: RpcHandlersOf<S, "main">["requests"];
    messages?: Partial<RpcHandlersOf<S, "main">["messages"]>;
  };
  log?: (message: string) => void;
};

/**
 * Register the main-process side of a typed RPC schema.
 *
 * ```ts
 * const rpc = defineMainRPC<LumenRPC>({ handlers: { requests: { readFile } } });
 * const win = new BrowserWindow({ rpc, url: app.assetUrl("index.html"), width: 1280 });
 * win.webContents.send.terminalData({ id, data });
 * ```
 */
export function defineMainRPC<S extends RPCSchema>(options: DefineMainRPCOptions<S>): RpcAttachment<S> {
  const handlers: RpcHandlers = {
    requests: options.handlers.requests as RpcHandlers["requests"],
    messages: (options.handlers.messages ?? {}) as RpcHandlers["messages"],
  };

  return {
    handlers,
    attach(window) {
      window.setRpcHandlers(handlers);
    },
  };
}
