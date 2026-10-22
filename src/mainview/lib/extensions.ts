import { useSyncExternalStore } from "react";
import { api } from "./rpc";
import { DEFAULT_SETTINGS, getSettings, onSettingsChange, updateSetting, type SettingKey } from "./settings";
import { notify, showProgress } from "./toast";
import { evaluateWhen } from "./when";
import { activeColorTheme, onColorThemeChange } from "./theme";
import type {
  ConfigSnapshot,
  ConfigurationProperty,
  ExtensionDescription,
  HostContentChange,
  HostDecoration,
  HostDecorationType,
  HostFileDecoration,
  HostFileOperation,
  HostMethods,
  HostProvider,
  HostQuickInputButton,
  HostQuickPick,
  HostLanguageConfiguration,
  HostSelection,
  HostStatusBarItem,
  HostToView,
  LanguageContribution,
  ViewContainerContribution,
  ViewContribution,
  ProviderKind,
  ViewMethods,
  ViewToHost,
} from "../../shared/extensions";
import type { Diagnostic, FileEdits } from "../../shared/types";
import { matchesSelector } from "../../shared/glob";
import { setFileSystemSchemes } from "../../shared/file-systems";
import { dispatchHostMessage, notifyHostReady } from "../features/registry";
import { customEditorContributions, type CustomEditorContribution } from "../../shared/extensions";

/**
 * The view's side of extensions: talks to the extension host (through the
 * main process), keeps it in sync with the open documents, answers its UI
 * requests through handlers the app registers, and holds what extensions
 * contributed (commands, status bar items, output, diagnostics, …) as a store
 * React components subscribe to.
 */

export type OutputChannel = { name: string; extensionId?: string; text: string; log: boolean };

export type ContributedCommand = {
  command: string;
  title: string;
  category?: string;
  extensionId: string;
  enablement?: string;
  /** `contributes.menus.commandPalette[].when` */
  paletteWhen?: string;
};

export type ContributedKeybinding = { key: string; command: string; when?: string; args?: unknown; extensionId: string };

export type ContributedSetting = { key: string; property: ConfigurationProperty; title: string; extensionId: string; extensionName: string };

export type ExtensionsSnapshot = {
  /** The host is up and has sent its extension list. */
  ready: boolean;
  crashed: string | null;
  /** Enabled extensions, as loaded by the host. */
  extensions: ExtensionDescription[];
  /** Commands registered at runtime → extension. */
  hostCommands: Map<string, string>;
  providers: HostProvider[];
  statusItems: HostStatusBarItem[];
  activation: Map<string, { ms: number; error?: string }>;
  contextKeys: Record<string, unknown>;
  progress: { id: number; title?: string; message?: string; percent?: number }[];
  /** Extension diagnostics, merged over all collections, by document path. */
  diagnostics: Map<string, Diagnostic[]>;
  /** A live quick pick (window.createQuickPick) to show, if any. */
  quickPick: HostQuickPick | null;
  /** Extension setting values, when they changed (for re-rendering). */
  settingsVersion: number;
  /** URI schemes of file systems extensions provide (memfs:, …). */
  virtualSchemes: string[];
  /** Read-only schemes of those file systems: the provider's message (registerFileSystemProvider). */
  virtualReadOnly: Record<string, string | true>;
  /** Extension file decorations, by lower-cased path (window.registerFileDecorationProvider). */
  fileDecorations: Map<string, HostFileDecoration>;
};

/** Output channels live in their own store: log lines must not re-render the window. */
export type OutputsSnapshot = { channels: OutputChannel[]; active: string | null };

export type ContributedView = ViewContribution & { extensionId: string; containerId: string };

export type ContributedContainer = ViewContainerContribution & {
  location: "activitybar" | "secondarySidebar" | "panel";
  extensionId: string;
  iconUrl?: string;
  views: ContributedView[];
};

/** contributes.debuggers of one extension, normalised for the (future) debug UI. */
export type ContributedDebugger = {
  extensionId: string;
  type: string;
  label?: string;
  languages?: string[];
  program?: string;
  runtime?: string;
  configurationAttributes?: Record<string, unknown>;
  initialConfigurations?: unknown[];
  configurationSnippets?: unknown[];
  variables?: Record<string, string>;
};

type Handlers = { [K in keyof ViewMethods]: (...args: Parameters<ViewMethods[K]>) => Promise<ReturnType<ViewMethods[K]>> | ReturnType<ViewMethods[K]> };

/** What the service needs to know about the app's documents. */
export type DocumentBindings = {
  paths: () => string[];
  content: (path: string) => string | null;
  language: (path: string) => string | undefined;
  dirty: (path: string) => boolean;
  eol: (path: string) => "LF" | "CRLF";
};

const EXTENSION_SETTINGS_KEY = "lumen.extensionSettings";
const MAX_OUTPUT = 1_000_000;
const lower = (path: string) => path.toLowerCase();

function loadExtensionSettings(): Record<string, unknown> {
  try {
    return JSON.parse(localStorage.getItem(EXTENSION_SETTINGS_KEY) ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Offset → 0-based line / character in `text`. */
function positionAt(text: string, offset: number): { line: number; character: number } {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, character: offset - lineStart };
}

/** The single edit that turns `before` into `after` (common prefix / suffix). */
function diff(before: string, after: string): HostContentChange | null {
  if (before === after) return null;
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)) {
    endBefore--;
    endAfter--;
  }
  const from = positionAt(before, start);
  const to = positionAt(before, endBefore);
  return {
    startLine: from.line,
    startCharacter: from.character,
    endLine: to.line,
    endCharacter: to.character,
    rangeOffset: start,
    rangeLength: endBefore - start,
    text: after.slice(start, endAfter),
  };
}

/** VS Code key strings ("ctrl+shift+alt+f", "cmd+k cmd+s") → Lumen's ("Ctrl+Shift+Alt+F"). */
export function normalizeKeybinding(key: string): string {
  const names: Record<string, string> = {
    left: "Left",
    right: "Right",
    up: "Up",
    down: "Down",
    pageup: "PageUp",
    pagedown: "PageDown",
    home: "Home",
    end: "End",
    escape: "Escape",
    enter: "Enter",
    tab: "Tab",
    space: "Space",
    backspace: "Backspace",
    delete: "Delete",
    insert: "Insert",
    oem_1: ";",
    oem_plus: "=",
    oem_comma: ",",
    oem_minus: "-",
    oem_period: ".",
    oem_2: "/",
    oem_3: "`",
    oem_4: "[",
    oem_5: "\\",
    oem_6: "]",
    oem_7: "'",
  };
  return key
    .trim()
    .split(/\s+/)
    .map((chord) => {
      const parts = chord.toLowerCase().split("+").filter(Boolean);
      const keyPart = parts.pop() ?? "";
      const mods = new Set(parts.map((part) => (part === "cmd" || part === "meta" || part === "win" ? "ctrl" : part)));
      const out: string[] = [];
      if (mods.has("ctrl")) out.push("Ctrl");
      if (mods.has("shift")) out.push("Shift");
      if (mods.has("alt")) out.push("Alt");
      const name =
        names[keyPart] ??
        (/^f\d{1,2}$/.test(keyPart)
          ? keyPart.toUpperCase()
          : /^numpad(\d)$/.test(keyPart)
            ? keyPart.slice(6)
            : keyPart.length === 1
              ? keyPart.toUpperCase()
              : keyPart);
      out.push(name);
      return out.join("+");
    })
    .join(" ");
}

const titleOf = (value: string | { value: string } | undefined) => (typeof value === "string" ? value : (value?.value ?? ""));

/** The extension host is restarted automatically after this many crashes within CRASH_WINDOW_MS. */
const AUTO_RESTARTS = 3;
const CRASH_WINDOW_MS = 5 * 60_000;

class ExtensionService {
  #snapshot: ExtensionsSnapshot = {
    ready: false,
    crashed: null,
    extensions: [],
    hostCommands: new Map(),
    providers: [],
    statusItems: [],
    activation: new Map(),
    contextKeys: {},
    progress: [],
    diagnostics: new Map(),
    quickPick: null,
    settingsVersion: 0,
    virtualSchemes: [],
    virtualReadOnly: {},
    fileDecorations: new Map(),
  };
  #listeners = new Set<() => void>();
  #notifyFrame = 0;
  #outputsSnapshot: OutputsSnapshot = { channels: [], active: null };
  #outputListeners = new Set<() => void>();
  #outputsFrame = 0;
  #handlers: Partial<Handlers> = {};
  #bindings: DocumentBindings | null = null;
  #diagnosticsByOwner = new Map<string, Map<string, { path: string; list: Diagnostic[] }>>();
  #sent = new Map<string, { path: string; text: string; version: number; language: string }>();
  #pending = new Set<string>();
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  #extensionSettings = loadExtensionSettings();
  #lastSettings = getSettings();
  #activeEditor = "";
  #activePath: string | null = null;
  #activeTerminal: string | null = null;
  #outputs = new Map<string, OutputChannel>();
  #revealListeners = new Set<(what: "output") => void>();
  #inputValidation = new Map<number, (message: string | null, close?: boolean) => void>();
  #inputButtons = new Map<number, (buttons: HostQuickInputButton[]) => void>();
  readonly decorationTypes = new Map<string, HostDecorationType>();
  /** path (lower case) → decoration type → ranges */
  readonly decorations = new Map<string, Map<string, HostDecoration[]>>();
  #decorationListeners = new Set<(path: string | null) => void>();
  /** Explorer paths asked about, by lower-cased path (to refetch on onDidChangeFileDecorations). */
  #fileDecorationPaths = new Map<string, string>();
  #languageConfigurations = new Map<string, HostLanguageConfiguration>();
  #languageConfigListeners = new Set<(languageId: string) => void>();
  #started = false;
  /** When the extension host crashed recently (see AUTO_RESTARTS). */
  #crashes: number[] = [];

  constructor() {
    window.addEventListener("lumen:ext-host", (e) => this.#onMessage((e as CustomEvent<HostToView>).detail));
    onSettingsChange(() => {
      const next = getSettings();
      const changed = (Object.keys(next) as SettingKey[]).filter((key) => next[key] !== this.#lastSettings[key]);
      this.#lastSettings = next;
      if (changed.length) this.#postConfiguration(changed);
      if (changed.includes("editor.tabSize") || changed.includes("editor.insertSpaces")) this.#postEditorOptions();
    });
    window.addEventListener("focus", () => this.post({ type: "focus", focused: true }));
    window.addEventListener("blur", () => this.post({ type: "focus", focused: false }));
  }

  /* ── store ─────────────────────────────────────────────────────────── */

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = () => this.#snapshot;

  /** Listeners hear about changes once per frame, however many messages the host sent. */
  #update(patch: Partial<ExtensionsSnapshot>) {
    this.#snapshot = { ...this.#snapshot, ...patch };
    if (this.#notifyFrame) return;
    this.#notifyFrame = requestAnimationFrame(() => {
      this.#notifyFrame = 0;
      for (const listener of this.#listeners) listener();
    });
  }

  subscribeOutputs = (listener: () => void) => {
    this.#outputListeners.add(listener);
    return () => this.#outputListeners.delete(listener);
  };

  getOutputs = () => this.#outputsSnapshot;

  #updateOutputs(active = this.#outputsSnapshot.active) {
    this.#outputsSnapshot = { channels: [...this.#outputs.values()], active };
    if (this.#outputsFrame) return;
    this.#outputsFrame = requestAnimationFrame(() => {
      this.#outputsFrame = 0;
      for (const listener of this.#outputListeners) listener();
    });
  }

  /* ── wiring ────────────────────────────────────────────────────────── */

  setHandlers(handlers: Handlers) {
    this.#handlers = handlers;
  }

  /** The language of an open document (menus' resourceLangId), when the window knows it. */
  documentLanguage(path: string): string | undefined {
    return this.#bindings?.language(path);
  }

  setDocumentBindings(bindings: DocumentBindings) {
    this.#bindings = bindings;
  }

  onReveal(listener: (what: "output") => void) {
    this.#revealListeners.add(listener);
    return () => this.#revealListeners.delete(listener);
  }

  onDecorationsChange(listener: (path: string | null) => void) {
    this.#decorationListeners.add(listener);
    return () => this.#decorationListeners.delete(listener);
  }

  /* ── file decorations (explorer) ───────────────────────────────────── */

  /** Ask the host for extension file decorations of the explorer's files. */
  requestFileDecorations(paths: string[]) {
    if (!paths.length) return;
    // Remembered even before the host is ready, so they can be fetched once it is.
    for (const path of paths) this.#fileDecorationPaths.set(lower(path), path);
    if (this.#snapshot.ready && this.hasExtensions) void this.#fetchFileDecorations(paths);
  }

  /** A provider fired onDidChangeFileDecorations: refetch the files asked about. */
  #refreshFileDecorations() {
    const paths = [...this.#fileDecorationPaths.values()];
    if (paths.length) void this.#fetchFileDecorations(paths);
  }

  async #fetchFileDecorations(paths: string[]) {
    let result: { path: string; decoration: HostFileDecoration }[];
    try {
      result = await this.call("provideFileDecorations", paths);
    } catch {
      return; // the host is not running
    }
    const next = new Map(this.#snapshot.fileDecorations);
    for (const path of paths) next.delete(lower(path));
    for (const entry of result) next.set(lower(entry.path), entry.decoration);
    let changed = next.size !== this.#snapshot.fileDecorations.size;
    if (!changed) {
      for (const [key, value] of next) {
        if (JSON.stringify(this.#snapshot.fileDecorations.get(key)) !== JSON.stringify(value)) {
          changed = true;
          break;
        }
      }
    }
    if (changed) this.#update({ fileDecorations: next });
  }

  /** A language's configuration set by an extension (`languages.setLanguageConfiguration`), if any. */
  languageConfiguration(languageId: string): HostLanguageConfiguration | undefined {
    return this.#languageConfigurations.get(languageId);
  }

  /** A language's configuration was set or removed. */
  onLanguageConfigurationChange(listener: (languageId: string) => void) {
    this.#languageConfigListeners.add(listener);
    return () => this.#languageConfigListeners.delete(listener);
  }

  /** Start (or restart) the extension host for this window. */
  async start(workspace: string | null) {
    if (this.#started) return;
    this.#started = true;
    await api()
      .request.extensionsStart({ config: this.config(), workspace })
      .catch((error: unknown) => console.error("[extensions] could not start the extension host", error));
  }

  async restart() {
    this.#update({ ready: false });
    await api().request.extensionsRestart({});
  }

  post(message: ViewToHost) {
    api().send.extHostPost({ message });
  }

  /** Call into the host (completions, hovers, …) after sending pending edits. */
  async call<K extends keyof HostMethods>(method: K, ...args: Parameters<HostMethods[K]>): Promise<ReturnType<HostMethods[K]>> {
    this.flush();
    const { result, error } = await api().request.extHostCall({ method, args });
    if (error) throw new Error(error);
    return result as ReturnType<HostMethods[K]>;
  }

  /** Run an extension command (fire and forget: it may wait for the user). */
  executeCommand(command: string, args: unknown[] = []) {
    this.flush();
    this.post({ type: "executeCommand", command, args });
  }

  activate(event: string) {
    this.post({ type: "activate", event });
  }

  /**
   * The user is about to create / delete / rename files in the explorer: fire the
   * host's workspace.onWill* events and return the text edits to apply first.
   */
  async willFileOperation(kind: "create" | "delete" | "rename", files: HostFileOperation[]): Promise<FileEdits[]> {
    if (!this.#snapshot.ready || !this.hasExtensions) return [];
    return (await this.call("willFileOperation", kind, files)) ?? [];
  }

  /** Tell the host a create / delete / rename the user did finished (workspace.onDid*). */
  didFileOperation(kind: "create" | "delete" | "rename", files: HostFileOperation[]): void {
    if (!this.#snapshot.ready || !this.hasExtensions) return;
    this.post({ type: "didFileOperation", kind, files });
  }

  get hasExtensions() {
    return this.#snapshot.extensions.length > 0;
  }

  /* ── configuration ─────────────────────────────────────────────────── */

  config(): ConfigSnapshot {
    return { lumen: { ...getSettings() }, user: { ...this.#extensionSettings } };
  }

  extensionSetting(key: string): unknown {
    if (key in this.#extensionSettings) return this.#extensionSettings[key];
    return this.contributedSettings().find((setting) => setting.key === key)?.property.default;
  }

  isExtensionSettingModified(key: string): boolean {
    return key in this.#extensionSettings;
  }

  updateConfiguration(key: string, value: unknown) {
    if (key in DEFAULT_SETTINGS) {
      updateSetting(key as SettingKey, (value === undefined ? DEFAULT_SETTINGS[key as SettingKey] : value) as never);
      return;
    }
    if (value === undefined || value === null) delete this.#extensionSettings[key];
    else this.#extensionSettings[key] = value;
    try {
      localStorage.setItem(EXTENSION_SETTINGS_KEY, JSON.stringify(this.#extensionSettings));
    } catch {
      /* ignore */
    }
    this.#update({ settingsVersion: this.#snapshot.settingsVersion + 1 });
    this.#postConfiguration([key]);
  }

  #postConfiguration(changed: string[]) {
    if (this.#snapshot.ready) this.post({ type: "configuration", config: this.config(), changed });
  }

  /** The indentation options of the active editor changed (settings / indentation picker). */
  #postEditorOptions() {
    if (!this.#snapshot.ready || !this.hasExtensions || !this.#activePath) return;
    this.post({
      type: "options",
      path: this.#activePath,
      options: { tabSize: getSettings()["editor.tabSize"], insertSpaces: getSettings()["editor.insertSpaces"] },
    });
  }

  /* ── contributions ─────────────────────────────────────────────────── */

  contributedCommands(): ContributedCommand[] {
    const out: ContributedCommand[] = [];
    const seen = new Set<string>();
    for (const extension of this.#snapshot.extensions) {
      const palette = extension.manifest.contributes?.menus?.commandPalette ?? [];
      for (const command of [extension.manifest.contributes?.commands ?? []].flat()) {
        if (seen.has(command.command)) continue;
        seen.add(command.command);
        out.push({
          command: command.command,
          title: titleOf(command.title) || command.command,
          category: titleOf(command.category) || undefined,
          extensionId: extension.id,
          enablement: command.enablement,
          paletteWhen: palette.find((entry) => entry.command === command.command)?.when,
        });
      }
    }
    // Registered at runtime without a contribution: still runnable from keybindings / other extensions.
    return out;
  }

  contributedKeybindings(): ContributedKeybinding[] {
    const platform = navigator.platform.toLowerCase();
    const out: ContributedKeybinding[] = [];
    for (const extension of this.#snapshot.extensions) {
      for (const binding of [extension.manifest.contributes?.keybindings ?? []].flat()) {
        const raw = platform.startsWith("mac")
          ? (binding.mac ?? binding.key)
          : platform.startsWith("win")
            ? (binding.win ?? binding.key)
            : (binding.linux ?? binding.key);
        // "-command" entries remove a default binding in VS Code; Lumen's defaults are its own, so they are skipped.
        if (!raw || !binding.command || binding.command.startsWith("-")) continue;
        out.push({ key: normalizeKeybinding(raw), command: binding.command, when: binding.when, args: binding.args, extensionId: extension.id });
      }
    }
    return out;
  }

  contributedSettings(): ContributedSetting[] {
    const out: ContributedSetting[] = [];
    for (const extension of this.#snapshot.extensions) {
      const name = extension.manifest.displayName ?? extension.manifest.name;
      for (const section of [extension.manifest.contributes?.configuration ?? []].flat()) {
        const entries = Object.entries(section.properties ?? {}).sort((a, b) => (a[1].order ?? 0) - (b[1].order ?? 0));
        for (const [key, property] of entries) {
          if (property.deprecationMessage || property.markdownDeprecationMessage) continue;
          out.push({ key, property, title: section.title ?? name, extensionId: extension.id, extensionName: name });
        }
      }
    }
    return out;
  }

  /**
   * View containers (activity bar / secondary side bar / panel) with their views, and the views
   * contributed to containers Lumen does not have (explorer, scm, …): those
   * are shown in the Explorer.
   */
  viewContainers(): { containers: ContributedContainer[]; explorerViews: ContributedView[] } {
    const containers: ContributedContainer[] = [];
    const views: ContributedView[] = [];
    for (const extension of this.#snapshot.extensions) {
      const contributes = extension.manifest.contributes ?? {};
      const declared = (contributes.viewsContainers ?? {}) as Partial<Record<string, ViewContainerContribution[]>>;
      for (const location of ["activitybar", "secondarySidebar", "panel"] as const) {
        for (const container of declared[location] ?? []) {
          containers.push({ ...container, location, extensionId: extension.id, iconUrl: extension.containerIcons?.[container.id], views: [] });
        }
      }
      for (const [containerId, list] of Object.entries((contributes.views ?? {}) as Record<string, ViewContribution[]>)) {
        for (const view of list ?? []) views.push({ ...view, extensionId: extension.id, containerId });
      }
    }
    const explorerViews: ContributedView[] = [];
    for (const view of views) {
      const container = containers.find((candidate) => candidate.id === view.containerId);
      if (container) container.views.push(view);
      else explorerViews.push(view);
    }
    return { containers: containers.filter((container) => container.views.length), explorerViews };
  }

  contributedLanguages(): LanguageContribution[] {
    return this.#snapshot.extensions.flatMap((extension) => extension.manifest.contributes?.languages ?? []);
  }

  /** contributes.customEditors of the enabled extensions, in load order (both priorities). */
  contributedCustomEditors(): CustomEditorContribution[] {
    return this.#snapshot.extensions.flatMap((extension) => customEditorContributions(extension.id, extension.manifest.contributes));
  }

  /** The custom editors whose selector matches a file (both priorities). */
  customEditorsFor(path: string, language = ""): CustomEditorContribution[] {
    return this.contributedCustomEditors().filter((entry) => matchesSelector(entry.selector, path, language));
  }

  /** The editor a matching file opens with (a "default" priority contribution), if any. */
  defaultCustomEditorFor(path: string, language = ""): CustomEditorContribution | undefined {
    return this.contributedCustomEditors().find((entry) => entry.priority === "default" && matchesSelector(entry.selector, path, language));
  }

  /** contributes.debuggers of the enabled extensions (the legacy adapter declaration). */
  contributedDebuggers(): ContributedDebugger[] {
    return this.#snapshot.extensions.flatMap((extension) =>
      [((extension.manifest.contributes ?? {}) as { debuggers?: unknown }).debuggers ?? []]
        .flat()
        .map((raw) => {
          const entry = raw as Record<string, unknown>;
          return {
            extensionId: extension.id,
            type: String(entry.type ?? ""),
            label: typeof entry.label === "string" ? entry.label : undefined,
            languages: Array.isArray(entry.languages) ? entry.languages.map(String) : undefined,
            program: typeof entry.program === "string" ? entry.program : undefined,
            runtime: typeof entry.runtime === "string" ? entry.runtime : undefined,
            configurationAttributes: (entry.configurationAttributes ?? undefined) as Record<string, unknown> | undefined,
            initialConfigurations: (entry.initialConfigurations ?? undefined) as unknown[] | undefined,
            configurationSnippets: (entry.configurationSnippets ?? undefined) as unknown[] | undefined,
            variables: (entry.variables ?? undefined) as Record<string, string> | undefined,
          };
        })
        .filter((entry) => !!entry.type),
    );
  }

  /** Languages the enabled extensions allow breakpoints in (contributes.breakpoints). */
  breakpointLanguages(): string[] {
    const out = new Set<string>();
    for (const extension of this.#snapshot.extensions) {
      const breakpoints = (extension.manifest.contributes ?? {}) as { breakpoints?: { language?: unknown }[] };
      for (const entry of breakpoints.breakpoints ?? []) if (typeof entry?.language === "string") out.add(entry.language);
    }
    return [...out];
  }

  /** Context keys for when clauses: set by extensions (setContext), plus `config.*`. */
  contextValue(key: string): unknown {
    if (key in this.#snapshot.contextKeys) return this.#snapshot.contextKeys[key];
    if (key.startsWith("config.")) {
      const name = key.slice("config.".length);
      return name in DEFAULT_SETTINGS ? getSettings()[name as SettingKey] : this.extensionSetting(name);
    }
    return undefined;
  }

  when(clause: string | undefined, lookup: (key: string) => unknown): boolean {
    return evaluateWhen(clause, (key) => {
      const value = lookup(key);
      return value === undefined ? this.contextValue(key) : value;
    });
  }

  /** Providers of a kind that apply to a document. */
  providersFor(kind: ProviderKind, path: string, language: string): HostProvider[] {
    return this.#snapshot.providers.filter((provider) => provider.kind === kind && matchesSelector(provider.selector, path, language));
  }

  /** Whether contributed snippets exist for a language (completion without a provider). */
  hasSnippets(language: string): boolean {
    return this.#snapshot.extensions.some((extension) => (extension.manifest.contributes?.snippets ?? []).some((s) => !s.language || s.language === language));
  }

  /* ── documents ─────────────────────────────────────────────────────── */

  /** A document is open in the window (or its content may have changed). */
  documentOpened(path: string) {
    if (!this.#snapshot.ready || !this.hasExtensions || !this.#bindings || path.startsWith("terminal:")) return;
    if (this.#sent.has(lower(path))) return;
    const text = this.#bindings.content(path);
    const language = this.#bindings.language(path);
    if (text === null || !language) return;
    this.#sent.set(lower(path), { path, text, version: 1, language });
    this.post({
      type: "documentOpen",
      doc: { path, languageId: language, version: 1, text, eol: this.#bindings.eol(path), dirty: this.#bindings.dirty(path) },
    });
  }

  documentChanged(path: string) {
    if (!this.#snapshot.ready || !this.hasExtensions) return;
    this.#pending.add(path);
    if (this.#flushTimer) return;
    this.#flushTimer = setTimeout(() => this.flush(), 120);
  }

  documentClosed(path: string) {
    this.#pending.delete(path);
    if (!this.#sent.delete(lower(path))) return;
    this.post({ type: "documentClose", path });
    const key = lower(path);
    if (this.decorations.delete(key)) for (const listener of this.#decorationListeners) listener(path);
  }

  documentSaved(path: string) {
    this.flush(path);
    if (this.#sent.has(lower(path))) this.post({ type: "documentSave", path });
  }

  documentDirty(path: string, dirty: boolean) {
    if (this.#sent.has(lower(path))) this.post({ type: "documentDirty", path, dirty });
  }

  /** The language of a document changed: extensions see it close and reopen. */
  documentLanguageChanged(path: string) {
    this.documentClosed(path);
    this.documentOpened(path);
  }

  /** Send pending edits now (before provider calls, command runs, replies). */
  flush(only?: string) {
    if (this.#flushTimer && !only) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    const paths = only ? [only] : [...this.#pending];
    for (const path of paths) {
      this.#pending.delete(path);
      const sent = this.#sent.get(lower(path));
      if (!sent) {
        this.documentOpened(path);
        continue;
      }
      const text = this.#bindings?.content(path);
      if (text === null || text === undefined) continue;
      const change = diff(sent.text, text);
      if (!change) continue;
      sent.text = text;
      sent.version++;
      this.post({ type: "documentChange", path: sent.path, version: sent.version, dirty: this.#bindings?.dirty(path) ?? true, changes: [change] });
    }
  }

  setActiveEditor(path: string | null, selections: HostSelection[], visible: string[]) {
    if (!this.#snapshot.ready || !this.hasExtensions) return;
    if (path) this.documentOpened(path);
    for (const other of visible) this.documentOpened(other);
    this.#activePath = path;
    const signature = JSON.stringify([path, visible]);
    if (signature === this.#activeEditor) return;
    this.#activeEditor = signature;
    this.post({ type: "activeEditor", path, selections, visible });
  }

  selectionChanged(path: string, selections: HostSelection[]) {
    if (!this.#snapshot.ready || !this.hasExtensions || !this.#sent.has(lower(path))) return;
    this.post({ type: "selection", path, selections });
  }

  /** The active editor scrolled: its visible ranges (0-based lines / characters). */
  visibleRangesChanged(path: string, ranges: { startLine: number; startCharacter: number; endLine: number; endCharacter: number }[]) {
    if (!this.#snapshot.ready || !this.hasExtensions || !this.#sent.has(lower(path))) return;
    this.post({ type: "visibleRanges", path, ranges });
  }

  /** The terminal the user is looking at changed (VS Code fires with the Terminal, if any). */
  activeTerminalChanged(id: string | null) {
    if (!this.#snapshot.ready || !this.hasExtensions) return;
    if (id === this.#activeTerminal) return;
    this.#activeTerminal = id;
    this.post({ type: "activeTerminal", id });
  }

  /** The host restarted: tell it about every open document again. */
  #resync() {
    this.#sent.clear();
    this.#pending.clear();
    this.#activeEditor = "";
    this.#activeTerminal = null;
    for (const path of this.#bindings?.paths() ?? []) this.documentOpened(path);
    window.dispatchEvent(new CustomEvent("lumen:ext-resync"));
  }

  /** Paths from the host (lower-case drive letters) → the window's spelling. */
  viewPath(path: string): string {
    const known = this.#bindings?.paths().find((candidate) => lower(candidate) === lower(path));
    if (known) return known;
    return /^[a-z]:[\\/]/.test(path) ? path[0]!.toUpperCase() + path.slice(1) : path;
  }

  /* ── quick input ───────────────────────────────────────────────────── */

  quickPickEvent(id: number, event: "value" | "active" | "accept" | "hide" | "button" | "itemButton", value?: string, items?: number[], index?: number) {
    if (event === "hide" || event === "accept") {
      if (this.#snapshot.quickPick?.id === id && event === "hide") this.#update({ quickPick: null });
    }
    this.post({ type: "quickPickEvent", id, event, value, items, index });
  }

  inputBoxValue(id: number, value: string) {
    this.post({ type: "inputBoxValue", id, value });
  }

  /** Receive validation messages for an input box shown by the app. */
  onInputValidation(id: number, listener: (message: string | null, close?: boolean) => void) {
    this.#inputValidation.set(id, listener);
    return () => this.#inputValidation.delete(id);
  }

  /** Receive button changes for an input box shown by the app (InputBox.buttons). */
  onInputBoxButtons(id: number, listener: (buttons: HostQuickInputButton[]) => void) {
    this.#inputButtons.set(id, listener);
    return () => this.#inputButtons.delete(id);
  }

  /* ── output ────────────────────────────────────────────────────────── */

  showOutput(name: string) {
    this.#updateOutputs(name);
  }

  clearOutput(name: string) {
    const channel = this.#outputs.get(name);
    if (!channel) return;
    channel.text = "";
    this.#updateOutputs();
  }

  /* ── messages from the host ────────────────────────────────────────── */

  async #onMessage(message: HostToView) {
    switch (message.type) {
      case "ready": {
        this.post({ type: "colorTheme", kind: activeColorTheme().kind });
        this.#diagnosticsByOwner.clear();
        this.decorationTypes.clear();
        this.decorations.clear();
        for (const listener of this.#decorationListeners) listener(null);
        // The host resends contributed configurations; drop the previous run's first.
        const staleLanguages = [...this.#languageConfigurations.keys()];
        this.#languageConfigurations.clear();
        for (const languageId of staleLanguages) for (const listener of this.#languageConfigListeners) listener(languageId);
        setFileSystemSchemes([]);
        this.#update({
          ready: true,
          crashed: null,
          extensions: message.extensions,
          hostCommands: new Map(),
          providers: [],
          statusItems: [],
          activation: new Map(),
          contextKeys: {},
          progress: [],
          diagnostics: new Map(),
          quickPick: null,
          virtualSchemes: [],
          virtualReadOnly: {},
          fileDecorations: new Map(),
        });
        this.#resync();
        this.#refreshFileDecorations();
        notifyHostReady();
        return;
      }
      case "feature":
        dispatchHostMessage(message.area, message.payload);
        return;
      case "commands":
        this.#update({ hostCommands: new Map(message.commands.map((entry) => [entry.command, entry.extensionId])) });
        return;
      case "providers":
        this.#update({ providers: message.providers });
        window.dispatchEvent(new CustomEvent("lumen:ext-providers"));
        this.#refreshFileDecorations();
        return;
      case "inlayHintsChanged":
        window.dispatchEvent(new CustomEvent("lumen:ext-inlay-hints"));
        return;
      case "codeLensesChanged":
        window.dispatchEvent(new CustomEvent("lumen:ext-codelens"));
        return;
      case "statusBar": {
        // Extensions refresh their items often with the same content.
        const current = this.#snapshot.statusItems.find((item) => item.id === message.item.id);
        if (current && JSON.stringify(current) === JSON.stringify(message.item)) return;
        const items = this.#snapshot.statusItems.filter((item) => item.id !== message.item.id);
        items.push(message.item);
        this.#update({ statusItems: items });
        return;
      }
      case "statusBarDispose":
        this.#update({ statusItems: this.#snapshot.statusItems.filter((item) => item.id !== message.id) });
        return;
      case "output": {
        const name = message.channel;
        let channel = this.#outputs.get(name);
        if (message.op === "dispose") {
          this.#outputs.delete(name);
          this.#updateOutputs(this.#outputsSnapshot.active === name ? null : this.#outputsSnapshot.active);
          return;
        }
        if (!channel) {
          channel = { name, extensionId: message.extensionId, text: "", log: !!message.log };
          this.#outputs.set(name, channel);
        }
        if (message.op === "append") channel.text += message.text ?? "";
        else if (message.op === "replace") channel.text = message.text ?? "";
        else if (message.op === "clear") channel.text = "";
        if (channel.text.length > MAX_OUTPUT) channel.text = channel.text.slice(-MAX_OUTPUT);
        if (message.op === "show") {
          this.#updateOutputs(name);
          for (const listener of this.#revealListeners) listener("output");
        } else this.#updateOutputs();
        return;
      }
      case "diagnostics": {
        let owner = this.#diagnosticsByOwner.get(message.owner);
        if (message.clear) owner = new Map();
        if (!owner) owner = new Map();
        this.#diagnosticsByOwner.set(message.owner, owner);
        for (const [rawPath, list] of message.entries) {
          const path = this.viewPath(rawPath);
          if (list.length) owner.set(lower(path), { path, list: list.map((d) => ({ ...d, path })) });
          else owner.delete(lower(path));
        }
        const merged = new Map<string, Diagnostic[]>();
        for (const entries of this.#diagnosticsByOwner.values()) {
          for (const { path, list } of entries.values()) merged.set(path, [...(merged.get(path) ?? []), ...list]);
        }
        this.#update({ diagnostics: merged });
        window.dispatchEvent(new CustomEvent("lumen:ext-diagnostics"));
        return;
      }
      case "decorationType":
        if (message.options) this.decorationTypes.set(message.id, message.options);
        else {
          this.decorationTypes.delete(message.id);
          for (const map of this.decorations.values()) map.delete(message.id);
        }
        for (const listener of this.#decorationListeners) listener(null);
        return;
      case "decorations": {
        const path = this.viewPath(message.path);
        const key = lower(path);
        const map = this.decorations.get(key) ?? new Map<string, HostDecoration[]>();
        if (message.ranges.length) map.set(message.typeId, message.ranges);
        else map.delete(message.typeId);
        this.decorations.set(key, map);
        for (const listener of this.#decorationListeners) listener(path);
        return;
      }
      case "languageConfiguration": {
        if (message.config) this.#languageConfigurations.set(message.languageId, message.config);
        else this.#languageConfigurations.delete(message.languageId);
        for (const listener of this.#languageConfigListeners) listener(message.languageId);
        return;
      }
      case "progress": {
        if (message.notification) {
          showProgress(message.id, message);
          return;
        }
        const others = this.#snapshot.progress.filter((item) => item.id !== message.id);
        const previous = this.#snapshot.progress.find((item) => item.id === message.id);
        if (message.done) {
          showProgress(message.id, { done: true });
          this.#update({ progress: others });
        } else {
          this.#update({
            progress: [...others, { id: message.id, title: message.title ?? previous?.title, message: message.message, percent: message.percent }],
          });
        }
        return;
      }
      case "context":
        this.#update({ contextKeys: { ...this.#snapshot.contextKeys, [message.key]: message.value } });
        return;
      case "activated": {
        const activation = new Map(this.#snapshot.activation);
        activation.set(message.extensionId, { ms: message.ms, error: message.error });
        this.#update({ activation });
        return;
      }
      case "quickPickUpdate":
        this.#update({ quickPick: message.pick });
        return;
      case "inputBoxValidation":
        this.#inputValidation.get(message.id)?.(message.message, message.close);
        return;
      case "inputBoxButtons":
        this.#inputButtons.get(message.id)?.(message.buttons);
        return;
      case "message": {
        const extension = this.#snapshot.extensions.find((candidate) => candidate.id === message.extensionId);
        void notify(message.kind, message.message, [], extension?.manifest.displayName ?? extension?.id);
        return;
      }
      case "fileSystems":
        setFileSystemSchemes(message.schemes, message.caseSensitive ?? message.schemes);
        this.#update({ virtualSchemes: message.schemes, virtualReadOnly: message.readOnly ?? {} });
        return;
      case "virtualFilesChanged":
        window.dispatchEvent(new CustomEvent("lumen:ext-virtual-changed", { detail: { paths: message.paths, changes: message.changes ?? [] } }));
        return;
      case "fileDecorationsChanged": {
        // The changed paths win over the ones we already asked about.
        for (const path of message.paths ?? []) this.#fileDecorationPaths.set(lower(path), this.viewPath(path));
        this.#refreshFileDecorations();
        return;
      }
      case "crashed": {
        this.#update({ ready: false, crashed: message.error });
        // Restart on its own, unless it keeps crashing (then one bad extension would loop forever).
        const now = Date.now();
        this.#crashes = [...this.#crashes.filter((at) => now - at < CRASH_WINDOW_MS), now];
        if (this.#crashes.length <= AUTO_RESTARTS) {
          void notify("error", `The extension host terminated unexpectedly (${message.error}). It is being restarted.`);
          void this.restart();
          return;
        }
        void notify(
          "error",
          `The extension host terminated unexpectedly ${this.#crashes.length} times in the last few minutes (${message.error}). Disable recently installed extensions, then restart it.`,
          ["Restart Extension Host"],
        ).then((choice) => {
          if (choice === 0) void this.restart();
        });
        return;
      }
      case "request": {
        const handler = this.#handlers[message.method] as ((...args: unknown[]) => unknown) | undefined;
        let reply: ViewToHost;
        try {
          if (!handler) throw new Error(`${message.method} is not available`);
          const result = await handler(...message.args);
          reply = { type: "reply", id: message.id, result: result === undefined ? null : result };
        } catch (error) {
          reply = { type: "reply", id: message.id, error: error instanceof Error ? error.message : String(error) };
        }
        // Edits made for the request reach the host before the answer.
        this.flush();
        this.post(reply);
        return;
      }
    }
  }
}

export const extensionService = new ExtensionService();

export function useExtensions(): ExtensionsSnapshot {
  return useSyncExternalStore(extensionService.subscribe, extensionService.getSnapshot);
}

export function useExtensionOutputs(): OutputsSnapshot {
  return useSyncExternalStore(extensionService.subscribeOutputs, extensionService.getOutputs);
}

onColorThemeChange(() => {
  if (extensionService.getSnapshot().ready) extensionService.post({ type: "colorTheme", kind: activeColorTheme().kind });
});
