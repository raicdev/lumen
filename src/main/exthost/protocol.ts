import type { ConfigSnapshot, ExtensionDescription, HostMethods, HostToView, MainMethods, ViewToHost } from "../../shared/extensions.ts";

/** Messages between the main thread and the extension host worker. */

export type HostInit = {
  extensions: ExtensionDescription[];
  config: ConfigSnapshot;
  workspace: string | null;
  /** App data folder: globalStorage, workspaceStorage and logs of extensions live below it. */
  userData: string;
  appRoot: string;
  appName: string;
  appVersion: string;
  /** Language ids → labels known to Lumen (languages.getLanguages). */
  languages: string[];
  /** Port and secret path prefix of the webview server (asWebviewUri, cspSource). */
  webviewPort: number;
  webviewToken: string;
};

export type MainToHost =
  | { type: "init"; init: HostInit }
  | { type: "view"; message: ViewToHost }
  | { type: "call"; id: number; method: keyof HostMethods; args: unknown[] }
  | { type: "mainReply"; id: number; result?: unknown; error?: string }
  | { type: "filesChanged"; paths: string[] }
  | { type: "shutdown" };

export type HostToMain =
  | { type: "view"; message: HostToView }
  | { type: "callResult"; id: number; result?: unknown; error?: string }
  | { type: "mainRequest"; id: number; method: keyof MainMethods; args: unknown[] }
  | { type: "shutdownDone" };
