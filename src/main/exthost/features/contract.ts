import type { ExtensionHost, ExtensionRuntime } from "../host.ts";

/**
 * Plug-in point of the extension host: an "area" (tasks, scm, notebooks, …)
 * adds API members, classes and enums, view messages and built-in commands
 * without touching api.ts or host.ts. Every area owns exactly one file here
 * (`features/<area>.ts`) and its counterpart in the view (mainview/features).
 * See README.md next to this file.
 */

/** Namespaces of the API object a feature can add members to. */
export type FeatureNamespace =
  | "window"
  | "workspace"
  | "languages"
  | "env"
  | "debug"
  | "commands"
  | "extensions"
  | "l10n"
  | "tasks"
  | "scm"
  | "tests"
  | "notebooks"
  | "authentication"
  | "comments"
  | "chat"
  | "lm";

export const FEATURE_NAMESPACES: readonly FeatureNamespace[] = [
  "window",
  "workspace",
  "languages",
  "env",
  "debug",
  "commands",
  "extensions",
  "l10n",
  "tasks",
  "scm",
  "tests",
  "notebooks",
  "authentication",
  "comments",
  "chat",
  "lm",
];

/** What `api()` gets: the host, the extension it builds the API for (one API object per extension) and helpers. */
export type FeatureContext = {
  host: ExtensionHost;
  /** `null` for the anonymous API object used by code that is not an extension. */
  runtime: ExtensionRuntime | null;
  /** `"unknown"` when there is no runtime. */
  extensionId: string;
  /** Log (once per name) that a member is not supported. */
  notSupported: (name: string) => void;
};

/** Members per namespace; they override members of the same name (including the "not supported" fallbacks). */
export type FeatureApi = Partial<Record<FeatureNamespace, object>>;

/** Returned by `executeCommand` when the feature does not handle the command. */
export const NOT_HANDLED: unique symbol = Symbol("lumen.feature.notHandled");

export interface HostFeature {
  /** Area id; also the `area` of `{ type: "feature" }` messages and requests between host and view. */
  readonly area: string;
  /**
   * Members for the namespaces of one extension's API object. Called once per
   * `createApi`, so per-extension state (registrations, disposables owned by
   * the extension id) lives in the closure. Getters are kept as getters.
   */
  api?(ctx: FeatureContext): FeatureApi;
  /** Top-level exports of the module (classes, enums, helpers); override compat stand-ins of the same name. */
  types?: Record<string, unknown>;
  /** Built-in command ids `executeCommand` handles; the view learns about them and routes them to the host. */
  commands?: readonly string[];
  /** The host started (after the view was told about the extensions). Safe place to subscribe to host events. */
  init?(host: ExtensionHost): void;
  /** `{ type: "feature", area, payload }` from the view's ViewFeature (`api.sendToHost`). */
  onViewMessage?(host: ExtensionHost, payload: unknown): void;
  /** `api.requestHost(method, args)` from the view; the result (must be JSON-like) goes back to it. */
  onViewRequest?(host: ExtensionHost, method: string, args: unknown[]): Promise<unknown> | unknown;
  /** The `Tab.input` of an editor tab a view feature renders (`openerId` is its FeatureEditorOpener id, `uri` the file path); undefined to pass. */
  tabInput?(tab: { openerId: string; uri: string; label: string }): unknown;
  /**
   * A `{ $ref: { area, ... } }` argument of a contributed menu command (scm/resourceState/context,
   * testing/item/context, …): the API object it stands for, or undefined when it is gone.
   */
  menuArg?(host: ExtensionHost, ref: Record<string, unknown>): unknown;
  /** A command that no extension registered, before the host falls back to the view. Return `NOT_HANDLED` to pass. */
  executeCommand?(host: ExtensionHost, command: string, args: unknown[]): Promise<unknown> | unknown;
}
