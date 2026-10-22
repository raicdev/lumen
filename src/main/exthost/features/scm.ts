import { readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import type { ExtensionHost } from "../host.ts";
import type { HostFeature } from "./contract.ts";
import { Disposable, Uri } from "../types.ts";
import type { Command } from "../types.ts";
import { keyOfUri } from "../documents.ts";
import type { ScmCommandData, ScmControlData, ScmGroupData, ScmResourceData, ScmSnapshot, ScmViewMessage } from "../../../shared/scm-protocol.ts";

/**
 * scm.* namespace: extension source controls (createSourceControl, resource
 * groups, input box, quick diff, status bar commands) shown in the Source
 * Control view next to the built-in git UI, and window.withScmProgress.
 */

type ResourceDecorations = { strikeThrough?: boolean; faded?: boolean; tooltip?: string; iconPath?: unknown; color?: unknown };
type ResourceState = { resourceUri: Uri; command?: Command; decorations?: ResourceDecorations; contextValue?: string };
type Validation = { message: string; type: number } | undefined | null;
type QuickDiffProvider = { provideOriginalResource?(uri: Uri, token: unknown): Uri | undefined | null | Promise<Uri | undefined | null> };

/** The icon of a resource (`decorations.iconPath`, as a data or http URL per theme kind). Part of the resource data. */
export type ScmResourceIcon = { light?: string; dark?: string; codicon?: string };

const ICON_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const iconCache = new Map<string, string | undefined>();

/** An icon file as a data URL (cached; small images only, like tree item icons). */
function imageUrl(path: string): string | undefined {
  if (iconCache.has(path)) return iconCache.get(path);
  let url: string | undefined;
  const type = ICON_TYPES[extname(path).toLowerCase()];
  try {
    if (type && statSync(path).size <= 512 * 1024) url = `data:${type};base64,${readFileSync(path).toString("base64")}`;
  } catch {
    /* missing icon */
  }
  iconCache.set(path, url);
  return url;
}

/** One `iconPath` value: a path (absolute, relative to the extension), a file/data/http URI, or a theme icon. */
function iconUrl(value: unknown, base: string | undefined): string | undefined {
  if (typeof value === "string") {
    if (/^(data|https?):/i.test(value)) return value;
    if (/^\w[\w+.-]+:/.test(value) && !/^[a-zA-Z]:[\\/]/.test(value)) {
      const uri = Uri.parse(value);
      if (uri.scheme === "file") return imageUrl(uri.fsPath);
      return /^(data|https?)$/.test(uri.scheme) ? value : undefined;
    }
    return imageUrl(base && !isAbsolute(value) ? resolve(base, value) : value);
  }
  if (Uri.isUri(value)) {
    if (value.scheme === "file") return imageUrl(value.fsPath);
    return /^(data|https?)$/.test(value.scheme) ? value.toString(true) : undefined;
  }
  return undefined;
}

/** `SourceControlResourceDecorations.iconPath` in wire form: light/dark variants are both sent, the view picks one. */
function iconOf(value: unknown, base: string | undefined): ScmResourceIcon | undefined {
  if (!value) return undefined;
  if (typeof (value as { id?: unknown }).id === "string") return { codicon: (value as { id: string }).id };
  if (typeof value === "string" || Uri.isUri(value)) {
    const url = iconUrl(value, base);
    return url ? { light: url, dark: url } : undefined;
  }
  if (typeof value === "object") {
    const light = iconUrl((value as { light?: unknown }).light, base);
    const dark = iconUrl((value as { dark?: unknown }).dark, base);
    if (light || dark) return { light, dark };
  }
  return undefined;
}

/** `SourceControlInputBox`: changes made by the extension are pushed to the view; typing in the view only updates `value`. */
class InputBox {
  #value = "";
  #placeholder = "";
  #visible = true;
  #enabled = true;
  validateInput: ((value: string, cursorPosition: number) => Validation | Promise<Validation>) | undefined;
  /** Bumped when the extension (not the view) set the value, so the view knows to adopt it. */
  rev = 0;
  validation: { message: string; type: number } | undefined;
  readonly #changed: () => void;

  constructor(changed: () => void) {
    this.#changed = changed;
  }
  get value(): string {
    return this.#value;
  }
  set value(next: string) {
    const value = String(next ?? "");
    if (value === this.#value) return;
    this.#value = value;
    this.rev++;
    this.#changed();
  }
  get placeholder(): string {
    return this.#placeholder;
  }
  set placeholder(next: string) {
    this.#placeholder = String(next ?? "");
    this.#changed();
  }
  get visible(): boolean {
    return this.#visible;
  }
  set visible(next: boolean) {
    this.#visible = !!next;
    this.#changed();
  }
  get enabled(): boolean {
    return this.#enabled;
  }
  set enabled(next: boolean) {
    this.#enabled = !!next;
    this.#changed();
  }
  /** The user typed in the view. */
  typed(value: string): void {
    this.#value = value;
  }
}

class ResourceGroup {
  readonly id: string;
  #label: string;
  #hideWhenEmpty = false;
  #resourceStates: ResourceState[] = [];
  readonly handle: number;
  disposed = false;
  readonly #changed: () => void;
  readonly #onDispose: (group: ResourceGroup) => void;

  constructor(handle: number, id: string, label: string, changed: () => void, onDispose: (group: ResourceGroup) => void) {
    this.handle = handle;
    this.id = id;
    this.#label = label;
    this.#changed = changed;
    this.#onDispose = onDispose;
  }
  get label(): string {
    return this.#label;
  }
  set label(value: string) {
    this.#label = String(value ?? "");
    this.#changed();
  }
  get hideWhenEmpty(): boolean {
    return this.#hideWhenEmpty;
  }
  set hideWhenEmpty(value: boolean) {
    this.#hideWhenEmpty = !!value;
    this.#changed();
  }
  get resourceStates(): ResourceState[] {
    return this.#resourceStates;
  }
  set resourceStates(value: ResourceState[]) {
    this.#resourceStates = Array.isArray(value) ? [...value] : [];
    this.#changed();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.#onDispose(this);
  }
}

class SourceControl {
  readonly handle: number;
  readonly extensionId: string;
  readonly id: string;
  readonly rootUri: Uri | undefined;
  /** Folder of the extension (relative `iconPath` strings resolve against it). */
  readonly location: string | undefined;
  readonly inputBox: InputBox;
  readonly groups: ResourceGroup[] = [];
  disposed = false;
  #label: string;
  #count: number | undefined;
  #quickDiffProvider: QuickDiffProvider | undefined;
  #commitTemplate: string | undefined;
  #acceptInputCommand: Command | undefined;
  #statusBarCommands: Command[] | undefined;
  readonly #state: ScmState;

  constructor(state: ScmState, extensionId: string, id: string, label: string, rootUri: Uri | undefined, location?: string) {
    this.#state = state;
    this.handle = state.nextHandle++;
    this.extensionId = extensionId;
    this.id = id;
    this.#label = label;
    this.rootUri = rootUri ? Uri.revive(rootUri as never) : undefined;
    this.location = location;
    this.inputBox = new InputBox(() => state.schedule());
  }
  get label(): string {
    return this.#label;
  }
  set label(value: string) {
    this.#label = String(value ?? "");
    this.#state.schedule();
  }
  get count(): number | undefined {
    return this.#count;
  }
  set count(value: number | undefined) {
    this.#count = value;
    this.#state.schedule();
  }
  get quickDiffProvider(): QuickDiffProvider | undefined {
    return this.#quickDiffProvider;
  }
  set quickDiffProvider(value: QuickDiffProvider | undefined) {
    this.#quickDiffProvider = value;
    this.#state.schedule();
  }
  get commitTemplate(): string | undefined {
    return this.#commitTemplate;
  }
  set commitTemplate(value: string | undefined) {
    this.#commitTemplate = value;
    // Like VS Code: the template fills an empty input box.
    if (value && !this.inputBox.value) this.inputBox.value = value;
    this.#state.schedule();
  }
  get acceptInputCommand(): Command | undefined {
    return this.#acceptInputCommand;
  }
  set acceptInputCommand(value: Command | undefined) {
    this.#acceptInputCommand = value;
    this.#state.schedule();
  }
  get statusBarCommands(): Command[] | undefined {
    return this.#statusBarCommands;
  }
  set statusBarCommands(value: Command[] | undefined) {
    this.#statusBarCommands = value;
    this.#state.schedule();
  }
  createResourceGroup(id: string, label: string): ResourceGroup {
    const group = new ResourceGroup(
      this.#state.nextHandle++,
      String(id),
      String(label),
      () => this.#state.schedule(),
      (disposed) => {
        const index = this.groups.indexOf(disposed);
        if (index >= 0) this.groups.splice(index, 1);
        this.#state.schedule();
      },
    );
    this.groups.push(group);
    this.#state.schedule();
    return group;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.#state.controls.delete(this.handle);
    this.#state.schedule();
  }
}

class ScmState {
  controls = new Map<number, SourceControl>();
  nextHandle = 1;
  busy = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  readonly host: ExtensionHost;
  constructor(host: ExtensionHost) {
    this.host = host;
  }

  /** Coalesce bursts of changes (an extension rebuilding its resource groups) into one message. */
  schedule(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.host.postFeature("scm", { kind: "state", snapshot: this.snapshot() });
    }, 30);
  }

  snapshot(): ScmSnapshot {
    return { controls: [...this.controls.values()].map(controlData), busy: this.busy };
  }
}

const states = new WeakMap<ExtensionHost, ScmState>();

function stateOf(host: ExtensionHost): ScmState {
  let state = states.get(host);
  if (!state) states.set(host, (state = new ScmState(host)));
  return state;
}

/** The current snapshot of a host's source controls (what the view gets). */
export function scmSnapshot(host: ExtensionHost): ScmSnapshot {
  return stateOf(host).snapshot();
}

function commandData(command: Command | undefined): ScmCommandData | undefined {
  if (!command) return undefined;
  return { title: command.title ?? command.command, tooltip: command.tooltip };
}

function basename(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

function dirname(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index < 0 ? "" : path.slice(0, index);
}

function relativeDir(root: Uri | undefined, key: string): string {
  const dir = dirname(key);
  if (!root || root.scheme !== "file") return dir;
  const norm = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = norm(root.fsPath);
  const target = norm(dir);
  if (target.toLowerCase() === base.toLowerCase()) return "";
  if (target.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return target.slice(base.length + 1);
  return dir;
}

function resourceData(control: SourceControl, state: ResourceState, index: number): (ScmResourceData & { icon?: ScmResourceIcon }) | null {
  const uri = Uri.revive(state?.resourceUri as never);
  if (!uri) return null;
  const path = keyOfUri(uri);
  const tooltip = state.decorations?.tooltip;
  return {
    path,
    label: basename(path),
    description: relativeDir(control.rootUri, path),
    tooltip,
    strikeThrough: state.decorations?.strikeThrough || undefined,
    faded: state.decorations?.faded || undefined,
    contextValue: state.contextValue,
    letter: tooltip ? tooltip.trim().charAt(0).toUpperCase() || undefined : undefined,
    hasCommand: !!state.command?.command,
    index,
    icon: iconOf(state.decorations?.iconPath, control.location),
  };
}

function groupData(control: SourceControl, group: ResourceGroup): ScmGroupData {
  const resources: ScmResourceData[] = [];
  for (const [index, state] of group.resourceStates.entries()) {
    const data = resourceData(control, state, index);
    if (data) resources.push(data);
  }
  return { handle: group.handle, id: group.id, label: group.label, hideWhenEmpty: group.hideWhenEmpty, resources };
}

function controlData(control: SourceControl): ScmControlData {
  const groups = control.groups.map((group) => groupData(control, group));
  const input = control.inputBox;
  return {
    handle: control.handle,
    extensionId: control.extensionId,
    id: control.id,
    label: control.label,
    rootPath: control.rootUri ? keyOfUri(control.rootUri) : undefined,
    count: control.count ?? groups.reduce((sum, group) => sum + group.resources.length, 0),
    inputBox: {
      value: input.value,
      valueRev: input.rev,
      placeholder: input.placeholder,
      visible: input.visible,
      enabled: input.enabled,
      validation: input.validation,
    },
    accept: commandData(control.acceptInputCommand),
    statusBarCommands: (control.statusBarCommands ?? []).map((command) => commandData(command)!),
    groups,
    hasQuickDiff: !!control.quickDiffProvider?.provideOriginalResource,
  };
}

async function runCommand(host: ExtensionHost, command: Command | undefined): Promise<void> {
  if (!command?.command) return;
  try {
    await host.executeCommand(command.command, command.arguments ?? []);
  } catch (error) {
    host.log("error", `Source control command "${command.command}" failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function validate(state: ScmState, control: SourceControl, value: string): Promise<void> {
  const input = control.inputBox;
  if (!input.validateInput) return;
  let result: Validation;
  try {
    result = await input.validateInput(value, value.length);
  } catch {
    result = undefined;
  }
  if (input.value !== value) return;
  input.validation = result ? { message: String(result.message), type: Number(result.type) } : undefined;
  state.schedule();
}

function handleViewMessage(host: ExtensionHost, message: ScmViewMessage): void {
  const state = stateOf(host);
  if (message.kind === "ready") {
    host.postFeature("scm", { kind: "state", snapshot: state.snapshot() });
    return;
  }
  const control = state.controls.get(message.handle);
  if (!control) return;
  switch (message.kind) {
    case "input":
      control.inputBox.typed(message.value);
      void validate(state, control, message.value);
      break;
    case "accept":
      void runCommand(host, control.acceptInputCommand);
      break;
    case "resource":
      void runCommand(host, control.groups.find((group) => group.handle === message.group)?.resourceStates[message.index]?.command);
      break;
    case "statusCommand":
      void runCommand(host, control.statusBarCommands?.[message.index]);
      break;
  }
}

async function originalText(host: ExtensionHost, uri: Uri): Promise<string | null> {
  try {
    if (uri.scheme === "file") return await readFile(uri.fsPath, "utf8");
    const api = host.apiFor(null) as { workspace: { openTextDocument(uri: Uri): Promise<{ getText(): string }> } };
    return (await api.workspace.openTextDocument(uri)).getText();
  } catch {
    return null;
  }
}

function sameOrInside(root: Uri | undefined, path: string): boolean {
  if (!root) return true;
  const base = keyOfUri(root).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const target = path.replace(/\\/g, "/").toLowerCase();
  return target === base || target.startsWith(`${base}/`);
}

/** The base text of a file from the first source control whose quick diff provider knows it. */
export async function scmQuickDiff(host: ExtensionHost, path: string): Promise<string | null> {
  const uri = /^\w[\w+.-]+:/.test(path) && !/^[a-zA-Z]:[\\/]/.test(path) ? Uri.parse(path) : Uri.file(path);
  const token = { isCancellationRequested: false, onCancellationRequested: () => new Disposable(() => {}) };
  for (const control of stateOf(host).controls.values()) {
    const provider = control.quickDiffProvider;
    if (!provider?.provideOriginalResource || !sameOrInside(control.rootUri, path)) continue;
    try {
      const original = await provider.provideOriginalResource(uri, token);
      const revived = original ? Uri.revive(original as never) : undefined;
      if (revived) return await originalText(host, revived);
    } catch (error) {
      host.log(
        "warning",
        `Quick diff provider of ${control.extensionId} failed: ${error instanceof Error ? error.message : String(error)}`,
        control.extensionId,
      );
    }
  }
  return null;
}

export const scmFeature: HostFeature = {
  area: "scm",
  api: ({ host, extensionId, runtime }) => {
    const state = stateOf(host);
    const own: SourceControl[] = [];
    // `scm.inputBox` (deprecated) before the extension created a source control.
    const detached = new InputBox(() => {});
    return {
      scm: {
        createSourceControl: (id: string, label: string, rootUri?: Uri) => {
          const control = new SourceControl(state, extensionId, String(id), String(label), rootUri, runtime?.description.location);
          state.controls.set(control.handle, control);
          own.push(control);
          state.schedule();
          return control;
        },
        /** The input box of this extension's latest source control. */
        get inputBox() {
          return own.findLast((control) => !control.disposed)?.inputBox ?? detached;
        },
      },
      window: {
        withScmProgress: async <R>(task: (progress: { report(value: number): void }) => PromiseLike<R> | R): Promise<R> => {
          state.busy++;
          state.schedule();
          try {
            return await task({ report() {} });
          } finally {
            state.busy--;
            state.schedule();
          }
        },
      },
    };
  },
  onViewMessage: (host, payload) => handleViewMessage(host, payload as ScmViewMessage),
  // scm/* menus: `{ control }`, `{ control, group }` or `{ control, group, index }` (a resource state).
  menuArg: (host, ref) => {
    const control = stateOf(host).controls.get(Number(ref.control));
    if (!control || ref.group === undefined) return control;
    const group = control.groups.find((candidate) => candidate.handle === Number(ref.group));
    if (!group || ref.index === undefined) return group;
    return group.resourceStates[Number(ref.index)];
  },
  onViewRequest: async (host, method, args) => {
    if (method === "quickDiff") return scmQuickDiff(host, String(args[0]));
    if (method === "snapshot") return stateOf(host).snapshot();
    throw new Error(`Unknown scm request: ${method}`);
  },
};
