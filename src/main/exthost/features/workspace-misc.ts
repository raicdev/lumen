import { access, constants } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { ExtensionHost } from "../host.ts";
import { keyOfUri } from "../documents.ts";
import * as T from "../types.ts";
import { encodeValidation } from "../../../shared/workspace-misc.ts";
import type { FeatureContext, HostFeature } from "./contract.ts";
import { NOT_HANDLED } from "./contract.ts";
import { decodeBytes, encodeText, normalizeEncoding } from "./workspace-misc/encoding.ts";
import { WorkspaceFolders } from "./workspace-misc/folders.ts";

/**
 * Host side of the "workspace-misc" area: workspace.saveAs / decode / encode /
 * updateWorkspaceFolders, env.isAppPortable, window.registerUriHandler (+ the
 * `lumen://<extension id>/...` URIs they receive), input box validation
 * severity, FilePermission on workspace.fs.stat and a few small types.
 */

/* ── types ───────────────────────────────────────────────────────────────── */

const InputBoxValidationSeverity = Object.freeze({ Info: 1, Warning: 2, Error: 3, 1: "Info", 2: "Warning", 3: "Error" });
const QuickInputButtonLocation = Object.freeze({ Title: 1, Inline: 2, Input: 3, 1: "Title", 2: "Inline", 3: "Input" });
const FilePermission = Object.freeze({ Readonly: 1, 1: "Readonly" });

/** A telemetry value the extension vouches for (not redacted by the logger). */
class TelemetryTrustedValue<V = unknown> {
  readonly value: V;
  constructor(value: V) {
    this.value = value;
  }
}

/* ── the API object without features ─────────────────────────────────────── */

type Base = { window: Record<string, any>; workspace: Record<string, any>; env: Record<string, any> };
type CreateApi = (host: ExtensionHost, runtime: FeatureContext["runtime"]) => Record<string, unknown>;

let createApi: CreateApi | null = null;
// api.ts imports the feature registry, which imports this file: load it after the module graph is built.
void import("../api.ts").then((module) => void (createApi = module.createApi));
let building = false;

/**
 * Members this area wraps (workspace.fs, createInputBox, env.openExternal) need
 * the original: build a second API object while this feature contributes
 * nothing, and use its namespaces.
 */
function baseApi(ctx: FeatureContext): Base {
  if (!createApi) throw new Error("The extension API is still loading");
  building = true;
  try {
    return createApi(ctx.host, ctx.runtime) as Base;
  } finally {
    building = false;
  }
}

/* ── per-host state ──────────────────────────────────────────────────────── */

type UriHandler = { handleUri(uri: T.Uri): unknown };
type State = { folders: WorkspaceFolders; handlers: Map<string, UriHandler>; allowed: Set<string> };
const states = new WeakMap<ExtensionHost, State>();

function stateOf(host: ExtensionHost): State {
  let state = states.get(host);
  if (!state) {
    const folders = new WorkspaceFolders(host.workspace);
    host.onDidChangeWorkspaceFolders.event(() => folders.syncRoot(host.workspace));
    state = { folders, handlers: new Map(), allowed: new Set() };
    states.set(host, state);
  }
  return state;
}

/* ── env.isAppPortable ───────────────────────────────────────────────────── */

/** Portable when LUMEN_PORTABLE is set, a `portable` folder sits in the app folder or the user data lives inside it. */
export function isPortable(appRoot: string, userData: string, environment: NodeJS.ProcessEnv = process.env): boolean {
  if (environment.LUMEN_PORTABLE && environment.LUMEN_PORTABLE !== "0") return true;
  if (existsSync(join(appRoot, "portable"))) return true;
  const rel = relative(resolve(appRoot), resolve(userData));
  return !!userData && rel !== "" && !rel.startsWith("..") && !rel.includes(":");
}

/* ── URIs: lumen://<publisher.name>/<path> ───────────────────────────────── */

/**
 * Hand a `lumen://<extension id>/...` URI to the extension's registered handler (activating it on `onUri`).
 * `caller` is the extension that asked (its own URIs pass) or `true` for the user; any other source asks the user first, once per extension.
 */
export async function handleUri(host: ExtensionHost, raw: string, caller?: string | true): Promise<boolean> {
  const fail = (message: string) => {
    void host.requestView("showMessage", "error", message, [], {}).catch(() => undefined);
    return false;
  };
  let uri: T.Uri;
  try {
    uri = T.Uri.parse(raw.trim(), true);
  } catch {
    return fail(`Not a valid URI: ${raw}`);
  }
  if (uri.scheme !== "lumen") return fail(`Not a lumen:// URI: ${raw}`);
  const id = uri.authority.toLowerCase();
  const runtime = host.runtimes.get(id);
  if (!runtime) return fail(`No extension '${uri.authority}' is installed to handle ${raw}`);
  const allowed = stateOf(host).allowed;
  if (caller !== true && caller?.toLowerCase() !== id && !allowed.has(id)) {
    const name = runtime.description.manifest.displayName ?? runtime.id;
    const choice = await host
      .requestView("showMessage", "info", `Allow the '${name}' extension to open this URI?`, ["Allow"], { modal: true, detail: uri.toString() })
      .catch(() => undefined);
    if (choice !== 0) return false;
    allowed.add(id);
  }
  if (!runtime.activated && runtime.activationEvents.some((event) => event === "onUri" || event === "*")) await host.activate(runtime, "onUri");
  const handler = stateOf(host).handlers.get(id);
  if (!handler) return fail(`Extension '${runtime.id}' has no URI handler`);
  try {
    await handler.handleUri(uri);
    return true;
  } catch (error) {
    host.log("error", `URI handler failed for ${raw}: ${error instanceof Error ? error.message : String(error)}`, runtime.id);
    return fail(`Extension '${runtime.id}' failed to handle ${raw}`);
  }
}

/* ── showInputBox with validation severity ───────────────────────────────── */

type Validation = { message: string; severity: number } | null;

/** A validateInput / validationMessage result: a string (Error), `{ message, severity }`, or nothing. */
export function readValidation(result: unknown): Validation {
  if (typeof result === "string") return result ? { message: result, severity: 3 } : null;
  const value = result as { message?: unknown; severity?: unknown } | null | undefined;
  if (!value || typeof value.message !== "string" || !value.message) return null;
  return { message: value.message, severity: typeof value.severity === "number" ? value.severity : 3 };
}

function showInputBoxWith(host: ExtensionHost) {
  return async (options: any = {}, token?: T.CancellationToken) => {
    const id = host.nextId();
    const validate = typeof options.validateInput === "function" ? (options.validateInput as (value: string) => unknown) : null;
    const run = async (value: string) => readValidation(await Promise.resolve(validate!(value)).catch(() => null));
    if (validate) {
      host.quickInputs.set(id, async (event) => {
        if (event.type !== "inputBoxValue") return;
        const result = await run(event.value);
        host.post({ type: "inputBoxValidation", id, message: encodeValidation(result?.message, result?.severity) });
      });
    }
    try {
      for (;;) {
        const value = await host.requestView("showInputBox", {
          title: options.title,
          prompt: options.prompt,
          value: options.value,
          placeholder: options.placeHolder ?? options.placeholder,
          password: options.password,
          id,
        });
        if (value === null || value === undefined || token?.isCancellationRequested) return undefined;
        if (!validate) return value;
        const result = await run(value);
        // Info and Warning are shown but do not stop the input from being accepted.
        if (!result || result.severity !== 3) return value;
        options = { ...options, value, prompt: result.message };
      }
    } finally {
      host.quickInputs.delete(id);
    }
  };
}

/* ── workspace.saveAs ────────────────────────────────────────────────────── */

async function saveAs(host: ExtensionHost, target: T.Uri): Promise<T.Uri | undefined> {
  const uri = T.Uri.revive(target);
  if (!uri) return undefined;
  const key = keyOfUri(uri);
  const defaultPath = uri.scheme === "file" ? uri.fsPath : undefined;
  const chosen = await host.requestMain("showSaveDialog", { defaultPath });
  if (!chosen) return undefined;
  return (await host.requestView("saveDocumentAs", key, chosen)) ? T.Uri.file(chosen) : undefined;
}

/* ── the feature ─────────────────────────────────────────────────────────── */

/** A workspace folder as the explorer sees it (`path` is the window's document key). */
const describeFolder = (folder: { uri: T.Uri; name: string }) => ({
  uri: folder.uri.toString(),
  name: folder.name,
  scheme: folder.uri.scheme,
  path: keyOfUri(folder.uri),
});

/**
 * `files.encoding` for a resource: the `"[<language>]"` section of an open document's
 * language first (user, Lumen, then extension defaults), the global setting otherwise.
 */
function configuredEncoding(host: ExtensionHost, uri?: T.Uri): string | undefined {
  const languageId = uri ? host.documentForUri(uri)?.languageId : undefined;
  if (languageId) {
    for (const source of [host.config.user, host.config.lumen, host.configDefaultOverrides]) {
      const section = source[`[${languageId}]`];
      const value = section && typeof section === "object" ? (section as Record<string, unknown>)["files.encoding"] : undefined;
      if (typeof value === "string") return value;
    }
  }
  const value = host.configValue("files.encoding");
  return typeof value === "string" ? value : undefined;
}

/** decode / encode options: `{ uri?, encoding? }`, or the resource's Uri. */
function encodingOptions(options: { uri?: T.Uri; encoding?: string } | T.Uri | undefined): { uri?: T.Uri; encoding?: string } {
  if (!options) return {};
  if (T.Uri.isUri(options)) return { uri: options as T.Uri };
  return { uri: T.Uri.isUri(options.uri) ? T.Uri.revive(options.uri) : undefined, encoding: options.encoding };
}

export const workspaceMiscFeature: HostFeature = {
  area: "workspace-misc",

  // The explorer shows extra workspace folders (including provided file systems) next to the local root.
  init: (host) => {
    const { folders } = stateOf(host);
    const postFolders = () => host.postFeature("workspace-misc", { type: "folders", folders: folders.folders.map(describeFolder) });
    postFolders();
    folders.onDidChange(() => postFolders());
  },

  api: (ctx) => {
    if (building) return {};
    const { host, extensionId } = ctx;
    const state = stateOf(host);
    let base: Base | null = null;
    const original = () => (base ??= baseApi(ctx));
    let fileSystem: Record<string, any> | null = null;

    const relativePath = (pathOrUri: string | T.Uri | { uri: T.Uri }, includeWorkspaceFolder?: boolean) => {
      const given = typeof pathOrUri === "string" ? pathOrUri : (T.Uri.revive((pathOrUri as { uri?: T.Uri }).uri ?? (pathOrUri as T.Uri))?.fsPath ?? "");
      const folder = state.folders.folderOf(T.Uri.file(given));
      if (!folder) return given;
      const rel = relative(folder.uri.fsPath, given).replace(/\\/g, "/");
      const include = includeWorkspaceFolder ?? state.folders.folders.length > 1;
      return include ? (rel ? `${folder.name}/${rel}` : folder.name) : rel;
    };

    return {
      window: {
        showInputBox: showInputBoxWith(host),
        createInputBox: () => {
          const box = original().window.createInputBox();
          // validationMessage may be { message, severity }: the base box only knows strings (severity travels inside, see shared/workspace-misc.ts).
          let value: unknown = box.validationMessage;
          return new Proxy(box, {
            get: (target, property) => (property === "validationMessage" ? value : Reflect.get(target, property)),
            set: (target, property, next) => {
              if (property !== "validationMessage") return Reflect.set(target, property, next);
              value = next;
              const validation = readValidation(next);
              return Reflect.set(target, property, encodeValidation(validation?.message, validation?.severity) ?? undefined);
            },
          });
        },
        registerUriHandler: (handler: UriHandler) => {
          const id = extensionId.toLowerCase();
          if (state.handlers.has(id)) throw new Error(`Protocol handler already registered for extension ${extensionId}`);
          state.handlers.set(id, handler);
          return new T.Disposable(() => {
            if (state.handlers.get(id) === handler) state.handlers.delete(id);
          });
        },
      },

      env: {
        get isAppPortable() {
          return isPortable(host.init.appRoot, host.init.userData);
        },
        openExternal: async (target: T.Uri | string) => {
          const uri = typeof target === "string" ? T.Uri.parse(target, true) : T.Uri.revive(target);
          if (uri?.scheme === "lumen") return handleUri(host, uri.toString(), extensionId);
          return original().env.openExternal(target);
        },
      },

      workspace: {
        get workspaceFolders() {
          const folders = state.folders.folders;
          return folders.length ? folders : undefined;
        },
        get rootPath() {
          return state.folders.folders[0]?.uri.fsPath;
        },
        get name() {
          const folders = state.folders.folders;
          return folders.length > 1 ? "Untitled (Workspace)" : folders[0]?.name;
        },
        getWorkspaceFolder: (uri: T.Uri) => {
          const target = T.Uri.revive(uri);
          return target ? state.folders.folderOf(target) : undefined;
        },
        asRelativePath: relativePath,
        onDidChangeWorkspaceFolders: state.folders.onDidChange,
        updateWorkspaceFolders: (start: number, deleteCount: number | undefined | null, ...toAdd: { uri: T.Uri; name?: string }[]) => {
          const result = state.folders.update(start, deleteCount, toAdd);
          if (result.ok && result.wantedRoot !== undefined) {
            // The window shows one root: ask it to follow (the "lumen.workspace.openFolderPath" window command, see followups).
            const command = result.wantedRoot === null ? "workbench.action.closeFolder" : "lumen.workspace.openFolderPath";
            void host.executeCommand(command, result.wantedRoot === null ? [] : [result.wantedRoot]).catch((error: unknown) => {
              host.log(
                "warning",
                `workspace folder change was not applied to the window: ${error instanceof Error ? error.message : String(error)}`,
                extensionId,
              );
            });
          }
          return result.ok;
        },
        saveAs: (uri: T.Uri) => saveAs(host, uri),
        decode: async (content: Uint8Array, options?: { uri?: T.Uri; encoding?: string } | T.Uri) => {
          const { uri, encoding } = encodingOptions(options);
          return decodeBytes(content, encoding ?? configuredEncoding(host, uri));
        },
        encode: async (content: string, options?: { uri?: T.Uri; encoding?: string } | T.Uri) => {
          const { uri, encoding } = encodingOptions(options);
          return encodeText(content, encoding ?? configuredEncoding(host, uri));
        },
        get fs() {
          if (fileSystem) return fileSystem;
          const wrapped = original().workspace.fs as Record<string, (...args: any[]) => any>;
          fileSystem = {
            ...wrapped,
            stat: async (uri: T.Uri) => {
              const stat = await wrapped.stat!(uri);
              const target = T.Uri.revive(uri);
              if (!stat || stat.permissions !== undefined || target?.scheme !== "file") return stat;
              const writable = await access(target.fsPath, constants.W_OK).then(
                () => true,
                () => false,
              );
              return writable ? stat : { ...stat, permissions: FilePermission.Readonly };
            },
          };
          return fileSystem;
        },
      },
    };
  },

  types: { InputBoxValidationSeverity, QuickInputButtonLocation, FilePermission, TelemetryTrustedValue },

  commands: ["lumen.handleUri"],

  onViewMessage: (host, payload) => {
    const message = payload as { type?: string; uri?: unknown } | null;
    if (message?.type === "uri" && typeof message.uri === "string") void handleUri(host, message.uri, true);
  },

  executeCommand: async (host, command, args) => {
    if (command === "lumen.handleUri") return handleUri(host, String(args[0] ?? ""));
    if (command === "vscode.open") {
      const target = args[0];
      const uri = typeof target === "string" ? T.Uri.parse(target, true) : T.Uri.revive(target as T.Uri);
      if (uri?.scheme === "lumen") return handleUri(host, uri.toString());
    }
    return NOT_HANDLED;
  },
};
