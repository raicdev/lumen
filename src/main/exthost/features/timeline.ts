import { execFile } from "node:child_process";
import { dirname, relative } from "node:path";
import type { ExtensionHost } from "../host.ts";
import type { HostFeature } from "./contract.ts";
import * as T from "../types.ts";
import { keyOfUri, uriOfKey } from "../documents.ts";
import type { TimelineItemWire, TimelinePage, TimelineSourceWire, TimelineViewMessage } from "../../../shared/timeline.ts";

/**
 * Host side of the "timeline" area: the proposed timeline API
 * (`workspace.registerTimelineProvider`, `registerWorkspaceTimelineProvider`,
 * `TimelineItem`, `TimelineTriggerKind`) and Lumen's own "Git History" source
 * (`git-history`, items `git:file:commit` like VS Code's git extension, so
 * extensions' timeline menus apply to them). The window's Timeline section
 * asks for the items of the active file and runs their commands.
 */

const AREA = "timeline";
export const GIT_SOURCE = "git-history";
/** Read-only file contents at a commit: `lumen-git-revision:/<path>?<sha>`. */
export const REVISION_SCHEME = "lumen-git-revision";
const MAX_ITEMS = 2000;

export const TimelineTriggerKind = Object.freeze({ Invoke: 1, Automatic: 2, 1: "Invoke", 2: "Automatic" });

export class TimelineItem {
  timestamp: number;
  label: string;
  id?: string;
  iconPath?: unknown;
  description?: string;
  tooltip?: string | T.MarkdownString;
  detail?: string;
  command?: T.Command;
  contextValue?: string;
  resourceUri?: T.Uri;
  accessibilityInformation?: unknown;
  constructor(label: string, timestamp: number) {
    this.label = label;
    this.timestamp = timestamp;
  }
}

type Timeline = { items: readonly TimelineItem[]; paging?: { cursor: string | undefined } };
type TimelineOptions = { cursor?: string; limit?: number | { timestamp: number; id?: string }; triggerKind?: number };
type Provider = {
  id: string;
  label: string;
  onDidChangeTimeline?: T.Event<{ id?: string; uri?: T.Uri; reset?: boolean } | undefined>;
  provideTimeline(uri: T.Uri, options: TimelineOptions, token: T.CancellationToken): Timeline | undefined | null | Promise<Timeline | undefined | null>;
};
type WorkspaceProvider = {
  id: string;
  label: string;
  onDidChangeWorkspaceTimeline?: T.Event<unknown>;
  provideWorkspaceTimeline(options: TimelineOptions, token: T.CancellationToken): Timeline | undefined | null | Promise<Timeline | undefined | null>;
};
type Registration = { provider: Provider; schemes: string[] | null; extensionId: string } | { workspace: WorkspaceProvider; extensionId: string };

type State = { registrations: Registration[]; items: Map<string, { item: TimelineItem; source: string; uri: string | null }>; seq: number };

const states = new WeakMap<ExtensionHost, State>();

function stateOf(host: ExtensionHost): State {
  let state = states.get(host);
  if (!state) states.set(host, (state = { registrations: [], items: new Map(), seq: 0 }));
  return state;
}

const idOf = (registration: Registration) => ("workspace" in registration ? registration.workspace.id : registration.provider.id);
const labelOf = (registration: Registration) => ("workspace" in registration ? registration.workspace.label : registration.provider.label);

function changed(host: ExtensionHost, source: string, uri?: T.Uri, reset?: boolean): void {
  host.postFeature(AREA, { kind: "changed", source, path: uri ? keyOfUri(uri) : undefined, reset: !!reset });
}

function register(host: ExtensionHost, registration: Registration): T.Disposable {
  const state = stateOf(host);
  state.registrations.push(registration);
  const event = "workspace" in registration ? registration.workspace.onDidChangeWorkspaceTimeline : registration.provider.onDidChangeTimeline;
  const subscription =
    typeof event === "function"
      ? event((change) => {
          const detail = change as { uri?: T.Uri; reset?: boolean } | undefined;
          changed(host, idOf(registration), detail?.uri ? T.Uri.revive(detail.uri) : undefined, detail?.reset);
        })
      : undefined;
  host.postFeature(AREA, { kind: "sources" });
  return new T.Disposable(() => {
    const index = state.registrations.indexOf(registration);
    if (index >= 0) state.registrations.splice(index, 1);
    subscription?.dispose();
    host.postFeature(AREA, { kind: "sources" });
  });
}

/** The sources that can give a timeline for `path` (null: the workspace timeline). */
export function timelineSources(host: ExtensionHost, path: string | null): TimelineSourceWire[] {
  const scheme = path ? uriOfKey(path).scheme : null;
  return stateOf(host)
    .registrations.filter((registration) =>
      scheme === null ? "workspace" in registration : !("workspace" in registration) && (!registration.schemes || registration.schemes.includes(scheme)),
    )
    .map((registration) => ({ id: idOf(registration), label: labelOf(registration) }));
}

function iconOf(icon: unknown): TimelineItemWire["icon"] {
  if (!icon) return undefined;
  if (typeof (icon as { id?: unknown }).id === "string") return { codicon: (icon as { id: string }).id };
  const target = T.Uri.isUri(icon) ? icon : ((icon as { dark?: unknown }).dark ?? (icon as { light?: unknown }).light);
  if (T.Uri.isUri(target) && /^(https?|data)$/.test(target.scheme)) return { url: target.toString(true) };
  return undefined;
}

function tooltipOf(item: TimelineItem): string | undefined {
  const tooltip = item.tooltip ?? item.detail;
  if (typeof tooltip === "string") return tooltip;
  return tooltip && typeof (tooltip as { value?: unknown }).value === "string" ? (tooltip as { value: string }).value : undefined;
}

function remember(state: State, item: TimelineItem, source: string, uri: string | null): string {
  const handle = `${source}\u0000${++state.seq}`;
  state.items.set(handle, { item, source, uri });
  while (state.items.size > MAX_ITEMS) state.items.delete(state.items.keys().next().value!);
  return handle;
}

/** One page of a source's timeline for `path` (null: the workspace). */
export async function provideTimeline(
  host: ExtensionHost,
  path: string | null,
  source: string,
  cursor: string | undefined,
  trigger: number,
): Promise<TimelinePage> {
  const state = stateOf(host);
  const registration = state.registrations.find((candidate) => idOf(candidate) === source);
  if (!registration) return { items: [] };
  const token = new T.CancellationTokenSource();
  const options: TimelineOptions = { cursor, limit: 50, triggerKind: trigger };
  let timeline: Timeline | undefined | null;
  try {
    timeline =
      "workspace" in registration
        ? await registration.workspace.provideWorkspaceTimeline(options, token.token)
        : path
          ? await registration.provider.provideTimeline(uriOfKey(path), options, token.token)
          : null;
  } catch (error) {
    host.log("warning", `timeline provider '${source}' failed: ${error instanceof Error ? error.message : String(error)}`, registration.extensionId);
    return { items: [] };
  } finally {
    token.dispose();
  }
  const items = (timeline?.items ?? [])
    .filter((item) => item && typeof item.label === "string")
    .map((item): TimelineItemWire => ({
      handle: remember(state, item, source, path),
      source,
      label: item.label,
      description: item.description,
      tooltip: tooltipOf(item),
      timestamp: Number(item.timestamp) || 0,
      icon: iconOf(item.iconPath),
      contextValue: item.contextValue,
      hasCommand: !!item.command?.command,
    }));
  return { items, cursor: timeline?.paging?.cursor };
}

async function runItem(host: ExtensionHost, handle: string): Promise<void> {
  const entry = stateOf(host).items.get(handle);
  const command = entry?.item.command;
  if (!command?.command) return;
  try {
    await host.executeCommand(command.command, command.arguments ?? []);
  } catch (error) {
    host.log("error", `${command.command}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/* ── Lumen's Git History source ──────────────────────────────────────────── */

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }, (error, stdout) => resolve(error ? null : stdout));
  });
}

/** `git log` of a file as a timeline (50 commits a page; the cursor is the number of commits skipped). */
export function gitHistoryProvider(): Provider {
  return {
    id: GIT_SOURCE,
    label: "Git History",
    async provideTimeline(uri, options) {
      if (uri.scheme !== "file") return { items: [] };
      const file = uri.fsPath;
      const skip = Number(options.cursor ?? 0) || 0;
      const out = await git(dirname(file), ["log", "--follow", "-n", "51", `--skip=${skip}`, "--format=%H%x1f%an%x1f%at%x1f%s", "--", file]);
      if (!out) return { items: [] };
      const root = (await git(dirname(file), ["rev-parse", "--show-toplevel"]))?.trim();
      const lines = out.split("\n").filter(Boolean);
      const items = lines.slice(0, 50).map((line) => {
        const [sha = "", author = "", time = "0", subject = ""] = line.split("\u001f");
        const item = new TimelineItem(subject || sha.slice(0, 7), Number(time) * 1000);
        item.id = sha;
        item.description = author;
        item.detail = `${author}, ${new Date(Number(time) * 1000).toLocaleString()}\n\n${subject}\n\n${sha.slice(0, 8)}`;
        item.iconPath = new T.ThemeIcon("git-commit");
        item.contextValue = "git:file:commit";
        if (root) {
          const revision = T.Uri.from({
            scheme: REVISION_SCHEME,
            path: `/${relative(root, file).replace(/\\/g, "/")}`,
            query: `${sha}&root=${encodeURIComponent(root)}`,
          });
          item.command = { command: "vscode.open", title: "Open Revision", arguments: [revision] };
        }
        return item;
      });
      return { items, paging: { cursor: lines.length > 50 ? String(skip + 50) : undefined } };
    },
  };
}

/** The file at a commit (`git show <sha>:<path>`). */
async function revisionContent(uri: T.Uri): Promise<string> {
  const [sha = "", ...rest] = uri.query.split("&");
  const root = decodeURIComponent(rest.find((part) => part.startsWith("root="))?.slice(5) ?? "");
  if (!/^[0-9a-f]{7,40}$/i.test(sha) || !root) return "";
  return (await git(root, ["show", `${sha}:${uri.path.replace(/^\//, "")}`])) ?? "";
}

export const timelineFeature: HostFeature = {
  area: AREA,

  api: ({ host, extensionId }) => ({
    workspace: {
      registerTimelineProvider: (scheme: string | readonly string[], provider: Provider) => {
        if (!provider || typeof provider.provideTimeline !== "function") throw new Error("registerTimelineProvider: provideTimeline is required");
        const schemes = scheme === "*" ? null : (Array.isArray(scheme) ? [...scheme] : [String(scheme)]).filter((entry) => entry !== "*");
        return register(host, { provider, schemes: schemes && schemes.length ? schemes : null, extensionId });
      },
      registerWorkspaceTimelineProvider: (provider: WorkspaceProvider) => {
        if (!provider || typeof provider.provideWorkspaceTimeline !== "function")
          throw new Error("registerWorkspaceTimelineProvider: provideWorkspaceTimeline is required");
        return register(host, { workspace: provider, extensionId });
      },
    },
  }),

  types: { TimelineItem, TimelineTriggerKind },

  init: (host) => {
    register(host, { provider: gitHistoryProvider(), schemes: ["file"], extensionId: "lumen" });
    host.contentProviders.register(null, REVISION_SCHEME, { provideTextDocumentContent: (uri: T.Uri) => revisionContent(uri) });
  },

  // timeline/item/context: the `TimelineItem` of a handle.
  menuArg: (host, ref) => stateOf(host).items.get(String(ref.item))?.item,

  onViewMessage: (host, payload) => {
    const message = payload as TimelineViewMessage;
    if (message.kind === "run") void runItem(host, message.handle);
  },

  onViewRequest: async (host, method, args) => {
    if (method === "sources") return timelineSources(host, (args[0] as string | null) ?? null);
    if (method === "provide")
      return provideTimeline(host, (args[0] as string | null) ?? null, String(args[1]), (args[2] as string | undefined) ?? undefined, Number(args[3]) || 2);
    throw new Error(`timeline: unknown request '${method}'`);
  },
};
