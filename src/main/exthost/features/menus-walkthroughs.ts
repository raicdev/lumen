import { readFile, readdir } from "node:fs/promises";
import { extname, relative, resolve, isAbsolute, dirname, join } from "node:path";
import type { HostFeature } from "./contract.ts";
import { NOT_HANDLED } from "./contract.ts";
import type { ExtensionHost } from "../host.ts";
import { Disposable } from "../types.ts";
import { uriOfKey } from "../documents.ts";
import { findWalkthrough, featuredFor, markdownImageSources, parseCompletionEvent, parseWalkthroughs, replaceMarkdownImages } from "../../../shared/menus-walkthroughs.ts";
import type { ResourceLabelFormatter } from "../../../shared/menus-walkthroughs.ts";

/**
 * Host side of the "menus-walkthroughs" area:
 *  - `workbench.action.openWalkthrough` (activates `onWalkthrough:<id>`, tells the window to open it),
 *  - `onCommand:` completion events of walkthrough steps (every command the host runs is reported when a step waits for it),
 *  - media files of walkthroughs (images, svg, markdown) read from the extension folder,
 *  - `workspace.registerResourceLabelFormatter` (resource label formatters registered at runtime).
 * Submenus, the Welcome page and editor menus live in the window (mainview/features/menus-walkthroughs.tsx).
 */

const AREA = "menus-walkthroughs";
export const OPEN_WALKTHROUGH_COMMAND = "workbench.action.openWalkthrough";

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
};

/** Largest media file the window is sent (data URL). */
const MAX_MEDIA_BYTES = 8 * 1024 * 1024;

type HostState = {
  formatters: Set<ResourceLabelFormatter>;
  patched: boolean;
  pending: Set<string>;
  flushing: boolean;
  /** Last `featuredFor` answer by extension set / workspace (see featuredWalkthroughs). */
  featured?: { signature: string; keys: string[] };
};
const states = new WeakMap<ExtensionHost, HostState>();

function stateOf(host: ExtensionHost): HostState {
  let state = states.get(host);
  if (!state) states.set(host, (state = { formatters: new Set(), patched: false, pending: new Set(), flushing: false }));
  return state;
}

function sources(host: ExtensionHost) {
  return [...host.runtimes.values()].map((runtime) => ({ id: runtime.id, manifest: runtime.description.manifest }));
}

/** Commands some walkthrough step waits for (`onCommand:<id>`). */
export function watchedCommands(host: ExtensionHost): Set<string> {
  const out = new Set<string>();
  for (const walkthrough of parseWalkthroughs(sources(host))) {
    for (const step of walkthrough.steps) {
      for (const event of step.completionEvents) {
        const parsed = parseCompletionEvent(event);
        if (parsed?.kind === "command") out.add(parsed.arg);
      }
    }
  }
  return out;
}

function postFormatters(host: ExtensionHost) {
  host.postFeature(AREA, { type: "formatters", formatters: [...stateOf(host).formatters] });
}

/** Reports the commands the host runs (those a walkthrough waits for) to the window, batched per tick. */
function observeCommands(host: ExtensionHost) {
  const state = stateOf(host);
  if (state.patched) return;
  state.patched = true;
  const original = host.executeCommand.bind(host);
  host.executeCommand = async (command: string, args: unknown[] = []) => {
    try {
      return await original(command, args);
    } finally {
      state.pending.add(command);
      if (!state.flushing) {
        state.flushing = true;
        queueMicrotask(() => {
          state.flushing = false;
          const watched = watchedCommands(host);
          const ids = [...state.pending].filter((id) => watched.has(id));
          state.pending.clear();
          if (ids.length) host.postFeature(AREA, { type: "commands", ids });
        });
      }
    }
  };
}

/** The `category` / `step` of the arguments of `workbench.action.openWalkthrough` (a key string or `{ category, step }`). */
export function parseOpenWalkthroughArgs(args: unknown[]): { key: string; step?: string; toSide: boolean } | null {
  const [first, second] = args;
  const options = second && typeof second === "object" ? (second as { toSide?: unknown; inactive?: unknown }) : undefined;
  const toSide = options ? options.toSide === true : second === true;
  if (typeof first === "string") return { key: first, toSide };
  if (first && typeof first === "object") {
    const { category, step } = first as { category?: unknown; step?: unknown };
    if (typeof category === "string") {
      // A step is `<category>#<step id>` in VS Code; accept the bare step id as well.
      const stepId = typeof step === "string" ? step.slice(step.lastIndexOf("#") + 1) : undefined;
      return { key: category, step: stepId, toSide };
    }
  }
  return null;
}

/** VS Code's `onWalkthrough:<id>` and Lumen's older `onWalkthrough:<extension>#<id>` both activate. */
function walkthroughEvents(walkthrough: { key: string; id?: string }): string[] {
  const id = walkthrough.id ?? walkthrough.key.slice(walkthrough.key.indexOf("#") + 1);
  return id ? [`onWalkthrough:${id}`, `onWalkthrough:${walkthrough.key}`] : [`onWalkthrough:${walkthrough.key}`];
}

async function openWalkthrough(host: ExtensionHost, args: unknown[]): Promise<void> {
  const request = parseOpenWalkthroughArgs(args);
  if (!request) {
    // No walkthrough given: VS Code opens the Welcome page.
    host.postFeature(AREA, { type: "welcome" });
    return;
  }
  const walkthrough = findWalkthrough(parseWalkthroughs(sources(host)), request.key);
  if (!walkthrough) throw new Error(`Walkthrough '${request.key}' not found`);
  await Promise.all(walkthroughEvents(walkthrough).map((event) => host.activateByEvent(event)));
  host.postFeature(AREA, { type: "open", key: walkthrough.key, step: request.step, toSide: request.toSide });
}

/** Whether `path` stays inside the extension folder; returns the absolute path. */
function extensionRoot(host: ExtensionHost, extensionId: string): string {
  const runtime = host.runtimes.get(extensionId.toLowerCase());
  if (!runtime) throw new Error(`unknown extension ${extensionId}`);
  return resolve(runtime.description.location);
}

function insideExtension(host: ExtensionHost, extensionId: string, path: string): string {
  const root = extensionRoot(host, extensionId);
  const file = resolve(root, path);
  const inside = relative(root, file);
  if (inside.startsWith("..") || isAbsolute(inside)) throw new Error(`${path} is outside the extension folder`);
  return file;
}

function isExternalMedia(source: string): boolean {
  return /^(?:https?|data|command|mailto):/i.test(source) || source.startsWith("#");
}

/** Reads an image of the extension folder as a data URL (undefined for other files). */
async function readImageDataUrl(host: ExtensionHost, extensionId: string, path: string): Promise<string | undefined> {
  const file = insideExtension(host, extensionId, path);
  const type = IMAGE_TYPES[extname(file).toLowerCase()];
  if (!type) return undefined;
  const data = await readFile(file);
  if (data.byteLength > MAX_MEDIA_BYTES) return undefined;
  return `data:${type};base64,${data.toString("base64")}`;
}

/**
 * A Markdown media file with its relative images embedded as data URLs: images
 * resolve against the file's folder (`base`, absolute), as VS Code does (`transformUris`).
 */
export async function embedMarkdownImages(host: ExtensionHost, extensionId: string, markdown: string, base: string): Promise<string> {
  const images = new Map<string, string | undefined>();
  const root = extensionRoot(host, extensionId);
  for (const source of markdownImageSources(markdown)) {
    if (isExternalMedia(source) || images.has(source)) continue;
    const file = resolve(base, source);
    const inside = relative(root, file);
    if (inside.startsWith("..") || isAbsolute(inside)) {
      images.set(source, undefined);
      continue;
    }
    try {
      images.set(source, await readImageDataUrl(host, extensionId, inside));
    } catch {
      images.set(source, undefined);
    }
  }
  return replaceMarkdownImages(markdown, (source) => images.get(source));
}

/** A media file of a walkthrough: inside the extension's folder only. */
async function readMedia(
  host: ExtensionHost,
  extensionId: string,
  path: string,
): Promise<{ kind: "image"; dataUrl: string } | { kind: "svg"; text: string } | { kind: "text"; text: string }> {
  const file = insideExtension(host, extensionId, path);
  const extension = extname(file).toLowerCase();
  if (extension === ".svg") {
    const data = await readFile(file);
    if (data.byteLength > MAX_MEDIA_BYTES) throw new Error(`${path} is too large`);
    // Inline, so VS Code theme variables (`var(--vscode-…)`) inside the SVG resolve.
    return { kind: "svg", text: data.toString("utf8") };
  }
  if (IMAGE_TYPES[extension]) {
    const data = await readFile(file);
    if (data.byteLength > MAX_MEDIA_BYTES) throw new Error(`${path} is too large`);
    return { kind: "image", dataUrl: `data:${IMAGE_TYPES[extension]};base64,${data.toString("base64")}` };
  }
  if (extension === ".md" || extension === ".markdown" || extension === ".txt") {
    const text = await readFile(file, "utf8");
    return { kind: "text", text: extension === ".txt" ? text : await embedMarkdownImages(host, extensionId, text, dirname(file)) };
  }
  throw new Error(`unsupported media type ${extension || path}`);
}

/** Directories not walked for `featuredFor` (VS Code's search ignores .git, and these dwarf a workspace). */
const FEATURED_SKIP = new Set([".git", "node_modules", "out", "dist", "build", ".venv", "venv", "__pycache__", "target"]);
const FEATURED_MAX_FILES = 50_000;
const FEATURED_TIMEOUT = 3000;

/** Walkthrough keys whose `featuredFor` patterns match a file of the workspace (VS Code's checkGlobFileExists). */
export async function featuredWalkthroughs(host: ExtensionHost): Promise<string[]> {
  const root = host.workspace;
  const candidates = parseWalkthroughs(sources(host)).filter((walkthrough) => walkthrough.featuredFor.length);
  if (!root || !candidates.length) return [];
  const state = stateOf(host);
  const signature = `${root}\0${candidates.map((walkthrough) => `${walkthrough.key}:${walkthrough.featuredFor.join("|")}`).join("\n")}`;
  if (state.featured?.signature === signature) return state.featured.keys;

  const matched = new Set<string>();
  const started = Date.now();
  let files = 0;
  const pending = candidates.filter((walkthrough) => !matched.has(walkthrough.key));
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (!pending.length || files >= FEATURED_MAX_FILES || Date.now() - started > FEATURED_TIMEOUT || depth > 16) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files >= FEATURED_MAX_FILES || Date.now() - started > FEATURED_TIMEOUT) return;
      const file = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!FEATURED_SKIP.has(entry.name) && !entry.name.startsWith(".git")) await visit(file, depth + 1);
        continue;
      }
      files++;
      const path = relative(root, file);
      for (const walkthrough of [...pending]) {
        if (!featuredFor(walkthrough, path)) continue;
        matched.add(walkthrough.key);
        pending.splice(pending.indexOf(walkthrough), 1);
      }
    }
  };
  await visit(root, 0);
  const keys = candidates.filter((walkthrough) => matched.has(walkthrough.key)).map((walkthrough) => walkthrough.key);
  state.featured = { signature, keys };
  return keys;
}

/** Arguments of menu commands that went through the window: `{ $uri: path | uri string }` becomes a `Uri`. */
/** Finds the feature of an area (set by registry.ts, which lists this feature: no import cycle). */
let featureByArea: (area: string) => HostFeature | undefined = () => undefined;

export function setMenuArgFeatures(lookup: (area: string) => HostFeature | undefined): void {
  featureByArea = lookup;
}

export function reviveMenuArg(value: unknown, host?: ExtensionHost): unknown {
  if (Array.isArray(value)) return value.map((entry) => reviveMenuArg(entry, host));
  if (!value || typeof value !== "object") return value;
  if ("$uri" in value && typeof (value as { $uri: unknown }).$uri === "string") return uriOfKey((value as { $uri: string }).$uri);
  // An API object the host owns (a resource state, a test item, a cell, …): its feature revives it.
  const ref = (value as { $ref?: unknown }).$ref;
  if (ref && typeof ref === "object" && typeof (ref as { area?: unknown }).area === "string") {
    const feature = host ? featureByArea((ref as { area: string }).area) : undefined;
    try {
      return feature?.menuArg?.(host!, ref as Record<string, unknown>);
    } catch (error) {
      host?.log("warning", `menu argument of '${(ref as { area: string }).area}' failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }
  // Plain objects (debug/variables/context, notebook/toolbar, …) may carry resources inside.
  if (Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = reviveMenuArg(entry, host);
    return out;
  }
  return value;
}

function isFormatter(value: unknown): value is ResourceLabelFormatter {
  const formatter = value as ResourceLabelFormatter | undefined;
  return !!formatter && typeof formatter.scheme === "string" && !!formatter.formatting && typeof formatter.formatting.label === "string";
}

export const menusWalkthroughsFeature: HostFeature = {
  area: AREA,

  api: ({ host }) => ({
    workspace: {
      /** Proposed API (resourceLabelFormatter): label of the resources of a scheme / authority. */
      registerResourceLabelFormatter(formatter: ResourceLabelFormatter): Disposable {
        if (!isFormatter(formatter)) throw new Error("registerResourceLabelFormatter: a scheme and formatting.label are required");
        const state = stateOf(host);
        const copy: ResourceLabelFormatter = { ...formatter, formatting: { ...formatter.formatting } };
        state.formatters.add(copy);
        postFormatters(host);
        return new Disposable(() => {
          state.formatters.delete(copy);
          postFormatters(host);
        });
      },
    },
  }),

  commands: [OPEN_WALKTHROUGH_COMMAND, "welcome.markStepComplete", "welcome.markStepIncomplete", "walkthroughs.selectStep", "resetGettingStartedProgress"],

  init: (host) => {
    observeCommands(host);
  },

  executeCommand: async (host, command, args) => {
    if (command === OPEN_WALKTHROUGH_COMMAND) return await openWalkthrough(host, args);
    // VS Code's walkthrough actions: the progress lives in the window.
    if (command === "welcome.markStepComplete" || command === "welcome.markStepIncomplete") {
      const key = args.find((arg): arg is string => typeof arg === "string");
      if (key) host.postFeature(AREA, { type: "mark", key, done: command === "welcome.markStepComplete" });
      return undefined;
    }
    if (command === "walkthroughs.selectStep") {
      const key = args.find((arg): arg is string => typeof arg === "string");
      if (key) host.postFeature(AREA, { type: "select", key });
      return undefined;
    }
    if (command === "resetGettingStartedProgress") {
      host.postFeature(AREA, { type: "reset" });
      return undefined;
    }
    return NOT_HANDLED;
  },

  onViewMessage: (host, payload) => {
    const message = payload as { type?: string; key?: string; command?: string; args?: unknown[] } | null;
    // A command of a contributed menu (editor/context, explorer/context, …) with its resource arguments.
    if (message?.type === "run" && typeof message.command === "string") {
      void host.executeCommand(message.command, (message.args ?? []).map((arg) => reviveMenuArg(arg, host))).catch((error: unknown) => host.log("error", `${message.command}: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    // The user opened a walkthrough in the window: its extension may activate on `onWalkthrough:`.
    if (message?.type === "opened" && typeof message.key === "string") {
      for (const event of walkthroughEvents({ key: message.key })) void host.activateByEvent(event);
    }
  },

  onViewRequest: async (host, method, args) => {
    if (method === "media") {
      const [extensionId, path] = args as [string, string];
      return await readMedia(host, extensionId, path);
    }
    if (method === "featured") return await featuredWalkthroughs(host);
    throw new Error(`unknown request ${method}`);
  },
};
