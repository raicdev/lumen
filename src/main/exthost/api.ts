import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "fs/promises";
import { existsSync, readFileSync, statSync } from "fs";
import { dirname, extname, relative } from "path";
import { API_VERSION } from "../../shared/extension-api.ts";
import { cssVariable } from "../../shared/color-theme.ts";
import type { HostDecoration, HostDecorationType, HostQuickInputButton, HostQuickPick, HostQuickPickItem, HostStatusBarItem, ProviderKind } from "../../shared/extensions.ts";
import { wireLanguageConfiguration } from "../../shared/extensions.ts";
import { matchGlob, matchesSelector } from "../../shared/glob.ts";
import { keyOfUri, normalizeKey } from "./documents.ts";
import type { ExtHostDocument } from "./documents.ts";
import type { ExtensionHost, ExtensionRuntime } from "./host.ts";
import { logTimestamp, toWire, wireEdit, wireRange } from "./wire.ts";
import * as T from "./types.ts";
import { compatTypes } from "./compat-types.ts";
import { Tab, TabGroup } from "./tabs.ts";
import { buildFeatureApi, featureTypes } from "./features/registry.ts";
import type { FileSystemProvider } from "./filesystems.ts";
import { applyWorkspaceEdit } from "./workspace-edit.ts";

/**
 * The `lumen` module — the extension API, one instance per extension (so
 * registrations and log lines know who made them). Namespaces and members
 * follow VS Code's `vscode` module; see shared/extension-api.ts for what is
 * covered. Members Lumen does not have answer gracefully: events never fire,
 * `register*` returns a disposable, `create*` throws a clear error. The larger
 * feature areas (tasks, scm, tests, notebooks, …) are plugged in from ./features.
 */

// The API is dynamic by nature (it mirrors a JavaScript module); keep the typing light.
type Fn = (...args: any[]) => any;
type Thenable<T> = PromiseLike<T>;

const THEME_COLORS: Record<string, string> = {
  "editor.findMatchHighlightBackground": "rgba(234, 92, 0, 0.33)",
  "editor.findMatchBackground": "rgba(81, 92, 106, 0.8)",
  "editor.selectionHighlightBackground": "rgba(173, 214, 255, 0.15)",
  "editor.wordHighlightBackground": "rgba(87, 87, 87, 0.72)",
  "editor.wordHighlightStrongBackground": "rgba(0, 73, 114, 0.72)",
  "editor.rangeHighlightBackground": "rgba(255, 255, 255, 0.04)",
  "editor.lineHighlightBackground": "rgba(255, 255, 255, 0.04)",
  "editorError.foreground": "#f14c4c",
  "editorWarning.foreground": "#cca700",
  "editorInfo.foreground": "#3794ff",
  "editorCodeLens.foreground": "#999999",
  "editorLineNumber.foreground": "#858585",
  "editorGhostText.foreground": "rgba(255, 255, 255, 0.34)",
  "editorInlayHint.foreground": "#969696",
  "editorInlayHint.background": "rgba(97, 97, 97, 0.1)",
  "errorForeground": "#f48771",
  "descriptionForeground": "rgba(204, 204, 204, 0.7)",
  "foreground": "#cccccc",
  "statusBarItem.errorBackground": "#c72e0f",
  "statusBarItem.warningBackground": "#7a6400",
  "statusBarItem.prominentBackground": "rgba(0, 0, 0, 0.5)",
  "gitDecoration.addedResourceForeground": "#81b88b",
  "gitDecoration.modifiedResourceForeground": "#e2c08d",
  "gitDecoration.deletedResourceForeground": "#c74e39",
  "terminal.ansiRed": "#f14c4c",
  "terminal.ansiGreen": "#89d185",
  "terminal.ansiYellow": "#cca700",
  "terminal.ansiBlue": "#3794ff",
};

function colorOf(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  if (value instanceof T.ThemeColor || typeof (value as T.ThemeColor).id === "string") {
    // The window resolves it with the active color theme (Lumen Dark's value as a fallback).
    const id = (value as T.ThemeColor).id;
    const fallback = THEME_COLORS[id];
    return `var(${cssVariable(id)}${fallback ? `, ${fallback}` : ""})`;
  }
  return undefined;
}

const BUTTON_IMAGE_TYPES: Record<string, string> = { ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif" };
const buttonImages = new Map<string, string | null>();

/** An icon file as a data URL (cached; small images only), like tree item icons. */
function buttonImageUrl(path: string): string | null {
  const cached = buttonImages.get(path);
  if (cached !== undefined) return cached;
  let url: string | null = null;
  const type = BUTTON_IMAGE_TYPES[extname(path).toLowerCase()];
  try {
    if (type && statSync(path).size <= 256 * 1024) url = `data:${type};base64,${readFileSync(path).toString("base64")}`;
  } catch {
    /* missing icon */
  }
  buttonImages.set(path, url);
  return url;
}

/** A QuickInputButton as the view's `{ icon, image, tooltip, index }` (iconPath like a tree item's). */
function quickInputButton(button: unknown, index: number): HostQuickInputButton | null {
  const icon = (button as { iconPath?: unknown } | null)?.iconPath as T.ThemeIcon | T.Uri | string | { light?: T.Uri | string; dark?: T.Uri | string } | undefined;
  const tooltip = (button as { tooltip?: unknown } | null)?.tooltip;
  const label = typeof tooltip === "string" ? tooltip : undefined;
  if (icon instanceof T.ThemeIcon || (icon && typeof icon === "object" && "id" in icon && typeof icon.id === "string")) {
    return { icon: (icon as T.ThemeIcon).id, tooltip: label, index };
  }
  const source = icon && typeof icon === "object" && !T.Uri.isUri(icon) && ("dark" in icon || "light" in icon) ? (icon.dark ?? icon.light) : icon;
  const uri = typeof source === "string" ? T.Uri.file(source) : T.Uri.isUri(source) ? source : undefined;
  if (uri?.scheme === "http" || uri?.scheme === "https" || uri?.scheme === "data") return { icon: uri.toString(true), image: true, tooltip: label, index };
  if (uri?.scheme === "file") {
    const url = buttonImageUrl(uri.fsPath);
    if (url) return { icon: url, image: true, tooltip: label, index };
  }
  return null;
}

/** The buttons of a quick input or quick pick item, dropping ones without a usable icon. */
function quickInputButtons(buttons: unknown): HostQuickInputButton[] | undefined {
  if (!Array.isArray(buttons) || !buttons.length) return undefined;
  const out = buttons.map((button, index) => quickInputButton(button, index)).filter((button): button is HostQuickInputButton => !!button);
  return out.length ? out : undefined;
}

function toPosition(value: { line: number; character: number }): T.Position {
  return value instanceof T.Position ? value : new T.Position(value.line, value.character);
}

function rangeOf(value: T.Range | T.Position): T.Range {
  return T.Range.isRange(value) ? T.toRange(value) : new T.Range(toPosition(value), toPosition(value));
}

function selectionOf(value: T.Selection | T.Range): T.Selection {
  if (T.Selection.isSelection(value)) return new T.Selection(toPosition(value.anchor), toPosition(value.active));
  return new T.Selection(toPosition(value.start), toPosition(value.end));
}

type EditCollector = { edits: T.TextEdit[]; eol?: T.EndOfLine };

function editBuilder(collector: EditCollector) {
  return {
    replace: (location: T.Range | T.Position | T.Selection, value: string) => collector.edits.push(new T.TextEdit(rangeOf(location), value)),
    insert: (position: T.Position, value: string) => collector.edits.push(new T.TextEdit(rangeOf(position), value)),
    delete: (location: T.Range | T.Selection) => collector.edits.push(new T.TextEdit(rangeOf(location), "")),
    setEndOfLine: (eol: T.EndOfLine) => (collector.eol = eol),
  };
}

/* ── text editors ────────────────────────────────────────────────────────── */

type EditorState = {
  key: string;
  selections: T.Selection[];
  facade: Record<string, unknown> | null;
  visibleRanges?: { startLine: number; startCharacter: number; endLine: number; endCharacter: number }[];
  options?: { tabSize: number; insertSpaces: boolean };
};

export function createEditorFacade(host: ExtensionHost, state: EditorState): Record<string, unknown> {
  if (state.facade) return state.facade;
  const document = () => host.document(state.key);
  const facade: Record<string, unknown> = {
    get document() {
      return document()?.toApi();
    },
    get selection() {
      return state.selections[0];
    },
    set selection(value: T.Selection) {
      (facade as { selections: T.Selection[] }).selections = [value];
    },
    get selections() {
      return state.selections;
    },
    set selections(value: T.Selection[]) {
      state.selections = value.map(selectionOf);
      void host.requestView(
        "setSelections",
        state.key,
        state.selections.map((s) => ({ anchorLine: s.anchor.line, anchorCharacter: s.anchor.character, activeLine: s.active.line, activeCharacter: s.active.character })),
      );
    },
    get visibleRanges() {
      if (state.visibleRanges) {
        return state.visibleRanges.map((range) => new T.Range(range.startLine, range.startCharacter, range.endLine, range.endCharacter));
      }
      const doc = document();
      return doc ? [new T.Range(0, 0, Math.max(0, doc.lineCount - 1), 0)] : [];
    },
    get options() {
      const tabSize = state.options?.tabSize ?? (host.configValue("editor.tabSize") as number | undefined) ?? 4;
      const insertSpaces = state.options?.insertSpaces ?? (host.configValue("editor.insertSpaces") as boolean | undefined) ?? true;
      return {
        tabSize,
        insertSpaces,
        cursorStyle: T.TextEditorCursorStyle.Line,
        lineNumbers: T.TextEditorLineNumbersStyle.On,
        indentSize: tabSize,
      };
    },
    set options(value: unknown) {
      if (!value || typeof value !== "object") return;
      const next = value as { tabSize?: number; insertSpaces?: boolean };
      const tabSize = typeof next.tabSize === "number" && next.tabSize > 0 ? Math.round(next.tabSize) : (state.options?.tabSize ?? (host.configValue("editor.tabSize") as number | undefined) ?? 4);
      const insertSpaces = typeof next.insertSpaces === "boolean" ? next.insertSpaces : (state.options?.insertSpaces ?? (host.configValue("editor.insertSpaces") as boolean | undefined) ?? true);
      state.options = { tabSize, insertSpaces };
      // Lumen keeps indentation in its settings: apply the change there.
      if (next.tabSize !== undefined) void host.requestView("updateConfiguration", "editor.tabSize", tabSize);
      if (next.insertSpaces !== undefined) void host.requestView("updateConfiguration", "editor.insertSpaces", insertSpaces);
    },
    get viewColumn() {
      return T.ViewColumn.One;
    },
    edit: async (callback: (builder: ReturnType<typeof editBuilder>) => void, options: { undoStopBefore?: boolean; undoStopAfter?: boolean } = {}) => {
      const collector: EditCollector = { edits: [] };
      callback(editBuilder(collector));
      if (!collector.edits.length) return true;
      return !!(await host.requestView("editDocument", state.key, collector.edits.map(wireEdit), { undoStopBefore: options.undoStopBefore }));
    },
    insertSnippet: async (snippet: T.SnippetString | string, location?: T.Position | T.Range | readonly (T.Position | T.Range)[]) => {
      const ranges = location === undefined ? null : [location].flat().map((entry) => wireRange(rangeOf(entry as T.Range)));
      return !!(await host.requestView("insertSnippet", state.key, typeof snippet === "string" ? snippet : snippet.value, ranges));
    },
    setDecorations: (type: { key: string }, items: readonly (T.Range | { range: T.Range; hoverMessage?: unknown; renderOptions?: any })[]) => {
      const ranges: HostDecoration[] = items.map((item) => {
        if (T.Range.isRange(item)) return wireRange(item);
        const hover = [item.hoverMessage ?? []].flat().map((part) => (typeof part === "string" ? part : ((part as { value?: string })?.value ?? ""))).join("\n\n");
        return {
          ...wireRange(item.range),
          hover: hover || undefined,
          before: item.renderOptions?.before?.contentText,
          after: item.renderOptions?.after?.contentText,
        };
      });
      host.post({ type: "decorations", path: state.key, typeId: type.key, ranges });
    },
    revealRange: (range: T.Range) => void host.requestView("revealRange", state.key, wireRange(range)),
    show: () => void host.requestView("showTextDocument", state.key, {}),
    hide: () => {},
  };
  state.facade = facade;
  return facade;
}

/* ── the API ─────────────────────────────────────────────────────────────── */

export function createApi(host: ExtensionHost, runtime: ExtensionRuntime | null): Record<string, unknown> {
  const extensionId = runtime?.id ?? "unknown";
  const warned = new Set<string>();
  const notSupported = (name: string) => {
    if (warned.has(name)) return;
    warned.add(name);
    host.log("warning", `${name} is not supported by Lumen yet`, extensionId);
  };

  /** Unknown members of a namespace: events never fire, register* is accepted, create* throws. */
  const graceful = <T extends object>(namespace: string, target: T): T =>
    new Proxy(target, {
      get(object, property, receiver) {
        if (typeof property === "symbol" || property in object) return Reflect.get(object, property, receiver);
        const name = `${namespace}.${property}`;
        if (/^on(Did|Will)[A-Z]/.test(property)) return T.noneEvent;
        if (/^register[A-Z]/.test(property)) {
          return () => {
            notSupported(name);
            return new T.Disposable(() => {});
          };
        }
        if (/^(create|show|open|start)[A-Z]/.test(property)) {
          return () => {
            notSupported(name);
            throw new Error(`${name} is not supported by Lumen yet`);
          };
        }
        return undefined;
      },
    });

  const accepted = (name: string) => () => {
    notSupported(name);
    return new T.Disposable(() => {});
  };

  const provider =
    (kind: ProviderKind) =>
    (selector: unknown, value: object, ...rest: unknown[]) => {
      let triggerCharacters: string[] | undefined;
      if (kind === "completion" || kind === "onTypeFormatting") triggerCharacters = rest.filter((entry) => typeof entry === "string") as string[];
      else if (kind === "signatureHelp") {
        // (selector, provider, ...chars) or (selector, provider, { triggerCharacters, retriggerCharacters })
        const meta = rest[0] as { triggerCharacters?: string[]; retriggerCharacters?: string[] } | undefined;
        triggerCharacters =
          meta && typeof meta === "object"
            ? [...(meta.triggerCharacters ?? []), ...(meta.retriggerCharacters ?? [])]
            : (rest.filter((entry) => typeof entry === "string") as string[]);
      }
      const metadata = rest.find((entry) => entry && typeof entry === "object");
      return host.registerProvider(kind, selector, value, extensionId, triggerCharacters, metadata);
    };

  /** registerWorkspaceSymbolProvider has no selector. */
  const workspaceSymbolProvider = (value: object) => host.registerProvider("workspaceSymbol", "*", value, extensionId);

  /* commands */

  const commands = {
    registerCommand(command: string, callback: Fn, thisArg?: unknown) {
      if (host.commands.has(command)) throw new Error(`command '${command}' already exists`);
      host.commands.set(command, { callback, thisArg, extensionId });
      host.postCommands();
      return new T.Disposable(() => {
        if (host.commands.get(command)?.callback !== callback) return;
        host.commands.delete(command);
        host.postCommands();
      });
    },
    registerTextEditorCommand(command: string, callback: Fn, thisArg?: unknown) {
      return commands.registerCommand(command, async (...args: unknown[]) => {
        const editor = host.activeEditor();
        if (!editor) {
          host.log("warning", `cannot run ${command}: no active text editor`, extensionId);
          return;
        }
        const collector: EditCollector = { edits: [] };
        await callback.call(thisArg, editor, editBuilder(collector), ...args);
        const key = (editor.document as { uri: T.Uri }).uri;
        if (collector.edits.length) await host.requestView("editDocument", keyOfUri(key), collector.edits.map(wireEdit), {});
      });
    },
    executeCommand: (command: string, ...args: unknown[]) => host.executeCommand(command, args),
    getCommands: async (filterInternal = false) => {
      const ids = new Set(host.commands.keys());
      for (const other of host.runtimes.values()) for (const command of [other.description.manifest.contributes?.commands ?? []].flat()) ids.add(command.command);
      return [...ids].filter((id) => !filterInternal || !id.startsWith("_"));
    },
  };

  /* window: messages */

  const message =
    (kind: "info" | "warning" | "error") =>
    async (text: string, ...rest: unknown[]) => {
      let options: { modal?: boolean; detail?: string } = {};
      if (rest[0] && typeof rest[0] === "object" && !("title" in (rest[0] as object))) options = rest.shift() as typeof options;
      const items = rest.filter((item) => item !== undefined) as (string | { title: string; isCloseAffordance?: boolean })[];
      const titles = items.map((item) => (typeof item === "string" ? item : item.title));
      const source = runtime ? (runtime.description.manifest.displayName ?? runtime.id) : undefined;
      const index = await host.requestView("showMessage", kind, String(text), titles, { modal: options.modal, detail: options.detail, source });
      return index === null || index === undefined ? undefined : items[index];
    };

  const quickPickItems = (items: readonly (string | T_QuickPickItem)[]): HostQuickPickItem[] =>
    items.map((item) =>
      typeof item === "string"
        ? { label: item }
        : {
            label: item.label,
            description: item.description,
            detail: item.detail,
            picked: item.picked,
            alwaysShow: item.alwaysShow,
            separator: item.kind === T.QuickPickItemKind.Separator,
            buttons: quickInputButtons(item.buttons),
          },
    );

  async function showQuickPick(itemsOrPromise: readonly (string | T_QuickPickItem)[] | Thenable<readonly (string | T_QuickPickItem)[]>, options: any = {}) {
    const items = await itemsOrPromise;
    const pick: HostQuickPick = {
      id: host.nextId(),
      title: options.title,
      placeholder: options.placeHolder ?? options.placeholder,
      items: quickPickItems(items),
      canPickMany: !!options.canPickMany,
      matchOnDescription: options.matchOnDescription,
      matchOnDetail: options.matchOnDetail,
      buttons: quickInputButtons(options.buttons),
    };
    const picked = await host.requestView("showQuickPick", pick);
    if (!picked) return undefined;
    const chosen = picked.map((index) => items[index]).filter((item) => item !== undefined);
    if (options.canPickMany) return chosen;
    if (chosen[0] !== undefined) options.onDidSelectItem?.(chosen[0]);
    return chosen[0];
  }

  async function showInputBox(options: any = {}, token?: T.CancellationToken) {
    const id = host.nextId();
    const validate = typeof options.validateInput === "function" ? (options.validateInput as (value: string) => unknown) : null;
    const messageOf = (result: unknown) => (typeof result === "string" ? result : ((result as { message?: string } | null)?.message ?? null));
    if (validate) {
      host.quickInputs.set(id, async (event) => {
        if (event.type !== "inputBoxValue") return;
        const result = await Promise.resolve(validate(event.value)).catch(() => null);
        host.post({ type: "inputBoxValidation", id, message: messageOf(result) || null });
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
        const error = messageOf(await Promise.resolve(validate(value)).catch(() => null));
        if (!error) return value;
        options = { ...options, value, prompt: `${error}` };
      }
    } finally {
      host.quickInputs.delete(id);
    }
  }

  function createQuickPick() {
    const id = host.nextId();
    const emit = {
      value: new T.EventEmitter<string>(),
      accept: new T.EventEmitter<void>(),
      active: new T.EventEmitter<readonly T_QuickPickItem[]>(),
      selection: new T.EventEmitter<readonly T_QuickPickItem[]>(),
      hide: new T.EventEmitter<void>(),
      button: new T.EventEmitter<unknown>(),
      itemButton: new T.EventEmitter<{ button: unknown; item: T_QuickPickItem }>(),
    };
    let visible = false;
    let scheduled = false;
    const state = {
      items: [] as T_QuickPickItem[],
      activeItems: [] as T_QuickPickItem[],
      selectedItems: [] as T_QuickPickItem[],
      value: "",
      placeholder: undefined as string | undefined,
      title: undefined as string | undefined,
      busy: false,
      enabled: true,
      canSelectMany: false,
      matchOnDescription: false,
      matchOnDetail: false,
      ignoreFocusOut: false,
      keepScrollPosition: false,
      sortByLabel: true,
      step: undefined as number | undefined,
      totalSteps: undefined as number | undefined,
      buttons: [] as unknown[],
    };
    const push = () => {
      if (!visible || scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (!visible) return;
        host.post({
          type: "quickPickUpdate",
          pick: {
            id,
            title: state.title,
            placeholder: state.placeholder,
            value: state.value,
            items: quickPickItems(state.items),
            canPickMany: state.canSelectMany,
            busy: state.busy,
            matchOnDescription: state.matchOnDescription,
            matchOnDetail: state.matchOnDetail,
            activeItems: state.activeItems.map((item) => state.items.indexOf(item)).filter((index) => index >= 0),
            selectedItems: state.selectedItems.map((item) => state.items.indexOf(item)).filter((index) => index >= 0),
            buttons: quickInputButtons(state.buttons),
          },
        });
      });
    };
    host.quickInputs.set(id, (event) => {
      if (event.type !== "quickPickEvent") return;
      const chosen = (event.items ?? []).map((index) => state.items[index]).filter((item): item is T_QuickPickItem => !!item);
      switch (event.event) {
        case "value":
          state.value = event.value ?? "";
          emit.value.fire(state.value);
          break;
        case "active":
          state.activeItems = chosen;
          emit.active.fire(chosen);
          break;
        case "accept":
          state.selectedItems = chosen;
          emit.selection.fire(chosen);
          emit.accept.fire();
          break;
        case "hide":
          visible = false;
          emit.hide.fire();
          break;
        case "button": {
          const button = state.buttons[event.index ?? -1];
          if (button) emit.button.fire(button);
          break;
        }
        case "itemButton": {
          const item = state.items[event.items?.[0] ?? -1];
          const button = (item as { buttons?: unknown[] } | undefined)?.buttons?.[event.index ?? -1];
          if (item && button) emit.itemButton.fire({ button, item });
          break;
        }
      }
    });
    const pick: Record<string, unknown> = {
      onDidChangeValue: emit.value.event,
      onDidAccept: emit.accept.event,
      onDidChangeActive: emit.active.event,
      onDidChangeSelection: emit.selection.event,
      onDidHide: emit.hide.event,
      onDidTriggerButton: emit.button.event,
      onDidTriggerItemButton: emit.itemButton.event,
      show() {
        visible = true;
        push();
      },
      hide() {
        if (!visible) return;
        visible = false;
        host.post({ type: "quickPickUpdate", pick: null });
        emit.hide.fire();
      },
      dispose() {
        (pick.hide as () => void)();
        host.quickInputs.delete(id);
        for (const emitter of Object.values(emit)) emitter.dispose();
      },
    };
    for (const key of Object.keys(state) as (keyof typeof state)[]) {
      Object.defineProperty(pick, key, {
        get: () => state[key],
        set: (value: never) => {
          (state as Record<string, unknown>)[key] = Array.isArray(value) ? [...(value as unknown[])] : value;
          push();
        },
        enumerable: true,
      });
    }
    return pick;
  }

  function createInputBox() {
    const id = host.nextId();
    const emit = { value: new T.EventEmitter<string>(), accept: new T.EventEmitter<void>(), hide: new T.EventEmitter<void>(), button: new T.EventEmitter<unknown>() };
    const state = {
      value: "",
      placeholder: undefined as string | undefined,
      prompt: undefined as string | undefined,
      title: undefined as string | undefined,
      password: false,
      validationMessage: undefined as string | undefined,
      busy: false,
      enabled: true,
      ignoreFocusOut: false,
      step: undefined as number | undefined,
      totalSteps: undefined as number | undefined,
      buttons: [] as unknown[],
      valueSelection: undefined as [number, number] | undefined,
    };
    let visible = false;
    host.quickInputs.set(id, (event) => {
      if (event.type === "inputBoxValue") {
        state.value = event.value;
        emit.value.fire(event.value);
      } else if (event.type === "quickPickEvent" && event.event === "button") {
        const button = state.buttons[event.index ?? -1];
        if (button) emit.button.fire(button);
      }
    });
    const box: Record<string, unknown> = {
      onDidChangeValue: emit.value.event,
      onDidAccept: emit.accept.event,
      onDidHide: emit.hide.event,
      onDidTriggerButton: emit.button.event,
      show() {
        if (visible) return;
        visible = true;
        void host
          .requestView("showInputBox", { title: state.title, prompt: state.prompt, value: state.value, placeholder: state.placeholder, password: state.password, validationMessage: state.validationMessage, buttons: quickInputButtons(state.buttons), id, live: true })
          .then((value) => {
            visible = false;
            if (value === null || value === undefined) emit.hide.fire();
            else {
              state.value = value;
              emit.accept.fire();
            }
          });
      },
      hide() {
        if (!visible) return;
        visible = false;
        host.post({ type: "inputBoxValidation", id, message: null, close: true });
        emit.hide.fire();
      },
      dispose() {
        (box.hide as () => void)();
        host.quickInputs.delete(id);
      },
    };
    for (const key of Object.keys(state) as (keyof typeof state)[]) {
      Object.defineProperty(box, key, {
        get: () => state[key],
        set: (value: never) => {
          (state as Record<string, unknown>)[key] = value;
          if (key === "validationMessage" && visible) host.post({ type: "inputBoxValidation", id, message: (value as string) || null });
          else if (key === "buttons" && visible) host.post({ type: "inputBoxButtons", id, buttons: quickInputButtons(value) ?? [] });
        },
        enumerable: true,
      });
    }
    return box;
  }

  /* window: status bar, output, progress */

  let statusSeq = 0;
  function createStatusBarItem(idOrAlignment?: string | number, alignmentOrPriority?: number, maybePriority?: number) {
    const hasId = typeof idOrAlignment === "string";
    const alignment = (hasId ? alignmentOrPriority : idOrAlignment) ?? T.StatusBarAlignment.Left;
    const priority = (hasId ? maybePriority : alignmentOrPriority) ?? 0;
    const id = `${extensionId}.${hasId ? idOrAlignment : `item${++statusSeq}`}`;
    const state = {
      text: "",
      tooltip: undefined as string | { value: string } | undefined,
      command: undefined as string | T.Command | undefined,
      color: undefined as string | T.ThemeColor | undefined,
      backgroundColor: undefined as T.ThemeColor | undefined,
      name: undefined as string | undefined,
      accessibilityInformation: undefined as unknown,
    };
    let visible = false;
    let disposed = false;
    let scheduled = false;
    const push = () => {
      if (scheduled || disposed) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (disposed) return;
        const command = typeof state.command === "string" ? { command: state.command } : state.command ? { command: state.command.command, arguments: toWire(state.command.arguments) as unknown[] } : undefined;
        const item: HostStatusBarItem = {
          id,
          extensionId,
          text: state.text,
          tooltip: typeof state.tooltip === "string" ? state.tooltip : state.tooltip?.value,
          command,
          alignment: alignment === T.StatusBarAlignment.Right ? "right" : "left",
          priority,
          color: colorOf(state.color),
          backgroundColor: colorOf(state.backgroundColor),
          visible,
        };
        host.post({ type: "statusBar", item });
      });
    };
    const item: Record<string, unknown> = {
      id,
      alignment,
      priority,
      show() {
        visible = true;
        push();
      },
      hide() {
        visible = false;
        push();
      },
      dispose() {
        disposed = true;
        host.post({ type: "statusBarDispose", id });
      },
    };
    for (const key of Object.keys(state) as (keyof typeof state)[]) {
      Object.defineProperty(item, key, {
        get: () => state[key],
        set: (value: never) => {
          (state as Record<string, unknown>)[key] = value;
          push();
        },
        enumerable: true,
      });
    }
    return item;
  }

  function setStatusBarMessage(text: string, hide?: number | Thenable<unknown>) {
    const item = createStatusBarItem(T.StatusBarAlignment.Left, 10_000) as { text: string; show(): void; dispose(): void };
    item.text = text;
    item.show();
    if (typeof hide === "number") setTimeout(() => item.dispose(), hide);
    else if (hide && typeof hide.then === "function") hide.then(() => item.dispose(), () => item.dispose());
    return new T.Disposable(() => item.dispose());
  }

  function createOutputChannel(name: string, options?: string | { log: true }) {
    const log = typeof options === "object" && options?.log === true;
    const post = (op: "append" | "replace" | "clear" | "show" | "dispose", text?: string, preserveFocus?: boolean) => {
      host.flushOutput();
      host.post({ type: "output", channel: name, extensionId, op, text, preserveFocus, log });
    };
    const levelEmitter = new T.EventEmitter<number>();
    const line = (level: string, args: unknown[]) => {
      const stamp = logTimestamp();
      const text = args.map((arg) => (arg instanceof Error ? (arg.stack ?? arg.message) : typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ");
      host.appendOutput(name, `${stamp} [${level}] ${text}\n`, extensionId, log);
    };
    return {
      name,
      append: (value: string) => host.appendOutput(name, String(value), extensionId, log),
      appendLine: (value: string) => host.appendOutput(name, `${value}\n`, extensionId, log),
      replace: (value: string) => post("replace", String(value)),
      clear: () => post("clear"),
      show: (columnOrPreserveFocus?: unknown, preserveFocus?: boolean) => post("show", undefined, typeof columnOrPreserveFocus === "boolean" ? columnOrPreserveFocus : preserveFocus),
      hide: () => {},
      dispose: () => post("dispose"),
      ...(log
        ? {
            logLevel: T.LogLevel.Info,
            onDidChangeLogLevel: levelEmitter.event,
            trace: (...args: unknown[]) => line("trace", args),
            debug: (...args: unknown[]) => line("debug", args),
            info: (...args: unknown[]) => line("info", args),
            warn: (...args: unknown[]) => line("warning", args),
            error: (...args: unknown[]) => line("error", args),
          }
        : {}),
    };
  }

  async function withProgress<R>(options: { location: number | { viewId: string }; title?: string; cancellable?: boolean }, task: (progress: { report(value: { message?: string; increment?: number }): void }, token: T.CancellationToken) => Thenable<R>): Promise<R> {
    const id = host.nextId();
    const notification = options.location === T.ProgressLocation.Notification;
    let percent = 0;
    host.post({ type: "progress", id, title: options.title, notification });
    const source = new T.CancellationTokenSource();
    try {
      return await task(
        {
          report: (value) => {
            if (value.increment) percent = Math.min(100, percent + value.increment);
            host.post({ type: "progress", id, title: options.title, message: value.message, percent: value.increment !== undefined ? percent : undefined, notification });
          },
        },
        source.token,
      );
    } finally {
      host.post({ type: "progress", id, done: true });
      source.dispose();
    }
  }

  /* window: editors, documents, terminals */

  async function showTextDocument(target: any, columnOrOptions?: any, preserveFocus?: boolean) {
    let document: ExtHostDocument | undefined;
    if (T.Uri.isUri(target)) document = await host.openDocument(T.Uri.revive(target)!);
    else if (target && T.Uri.isUri(target.uri)) document = host.documentForUri(target.uri) ?? (await host.openDocument(target.uri));
    if (!document) throw new Error("showTextDocument: unknown document");
    const options = typeof columnOrOptions === "object" && columnOrOptions ? columnOrOptions : { viewColumn: columnOrOptions, preserveFocus };
    if (document.isUntitled && !document.open) await host.requestView("openUntitled", document.key, document.languageId, document.getText());
    await host.requestView("showTextDocument", document.key, {
      selection: options.selection ? wireRange(T.toRange(options.selection)) : undefined,
      preview: options.preview,
      preserveFocus: options.preserveFocus,
      beside: options.viewColumn === T.ViewColumn.Beside,
    });
    return host.editorFacade(host.editors.get(normalizeKey(document.key)) ?? { key: document.key, selections: [new T.Selection(0, 0, 0, 0)], facade: null });
  }

  function createTerminal(nameOrOptions?: string | { name?: string; cwd?: string | T.Uri; shellPath?: string; shellArgs?: string[] | string; pty?: unknown }, shellPath?: string) {
    const options = typeof nameOrOptions === "object" && nameOrOptions ? nameOrOptions : { name: nameOrOptions, shellPath };
    if (options.pty) notSupported("window.createTerminal (pseudo-terminal)");
    const cwd = options.cwd === undefined ? undefined : typeof options.cwd === "string" ? options.cwd : options.cwd.fsPath;
    const id = host.requestView("createTerminal", { name: options.name, cwd, shellPath: options.shellPath });
    let exitStatus: { code: number | undefined; reason: number } | undefined;
    const facade: Record<string, unknown> = {
      name: options.name ?? "terminal",
      processId: Promise.resolve(undefined),
      creationOptions: options,
      get exitStatus() {
        return exitStatus;
      },
      state: { isInteractedWith: false },
      shellIntegration: undefined,
      sendText: (text: string, addNewLine = true) => void id.then((terminalId) => host.requestView("terminalSendText", terminalId, text, addNewLine)),
      show: (preserveFocus = false) => void id.then((terminalId) => host.requestView("terminalShow", terminalId, preserveFocus)),
      hide: () => {},
      dispose: () => void id.then((terminalId) => host.requestView("terminalDispose", terminalId)),
    };
    void id.then((terminalId) => {
      host.terminals.set(terminalId, { facade, closed: () => (exitStatus = { code: undefined, reason: T.TerminalExitReason.Unknown }) });
      // The view reports the id it made; fill in the facade once it exists.
      if (host.activeTerminalId === terminalId && host.activeTerminal !== facade) host.activeTerminal = facade;
      host.onDidOpenTerminal.fire(facade);
    });
    host.activeTerminal = facade;
    return facade;
  }

  let decorationSeq = 0;
  function createTextEditorDecorationType(options: any) {
    const key = `${extensionId}-decoration-${++decorationSeq}`;
    const merged = { ...options, ...(options?.dark ?? {}) };
    const part = (value: any) =>
      value
        ? {
            contentText: value.contentText,
            color: colorOf(value.color),
            backgroundColor: colorOf(value.backgroundColor),
            margin: value.margin,
            fontStyle: value.fontStyle,
            fontWeight: value.fontWeight,
          }
        : undefined;
    const border =
      merged.border ??
      (merged.borderWidth || merged.borderStyle || merged.borderColor
        ? `${merged.borderWidth ?? "1px"} ${merged.borderStyle ?? "solid"} ${colorOf(merged.borderColor) ?? "currentColor"}`
        : undefined);
    const style: HostDecorationType = {
      backgroundColor: colorOf(merged.backgroundColor),
      color: colorOf(merged.color),
      border,
      borderRadius: merged.borderRadius,
      outline: merged.outline ?? (merged.outlineColor ? `${merged.outlineWidth ?? "1px"} ${merged.outlineStyle ?? "solid"} ${colorOf(merged.outlineColor)}` : undefined),
      fontWeight: merged.fontWeight,
      fontStyle: merged.fontStyle,
      textDecoration: merged.textDecoration,
      opacity: merged.opacity,
      cursor: merged.cursor,
      before: part(merged.before),
      after: part(merged.after),
      isWholeLine: !!merged.isWholeLine,
    };
    host.post({ type: "decorationType", id: key, options: style });
    return {
      key,
      dispose: () => {
        host.post({ type: "decorationType", id: key, options: null });
      },
    };
  }

  const window = graceful("window", {
    showInformationMessage: message("info"),
    showWarningMessage: message("warning"),
    showErrorMessage: message("error"),
    showQuickPick,
    showInputBox,
    createQuickPick,
    createInputBox,
    showOpenDialog: async (options: any = {}) => {
      const paths = await host.requestMain("showOpenDialog", {
        title: options.title ?? options.openLabel,
        defaultPath: options.defaultUri ? T.Uri.revive(options.defaultUri)!.fsPath : undefined,
        folders: !!options.canSelectFolders && !options.canSelectFiles,
        many: !!options.canSelectMany,
      });
      return paths.length ? paths.map((path) => T.Uri.file(path)) : undefined;
    },
    showSaveDialog: async (options: any = {}) => {
      const path = await host.requestMain("showSaveDialog", { title: options.title ?? options.saveLabel, defaultPath: options.defaultUri ? T.Uri.revive(options.defaultUri)!.fsPath : undefined });
      return path ? T.Uri.file(path) : undefined;
    },
    showWorkspaceFolderPick: async () => {
      const folders = workspace.workspaceFolders as T.WorkspaceFolder[] | undefined;
      if (!folders?.length) return undefined;
      if (folders.length === 1) return folders[0];
      const picked = await showQuickPick(folders.map((folder) => folder.name));
      return folders.find((folder) => folder.name === picked);
    },
    createStatusBarItem,
    setStatusBarMessage,
    createOutputChannel,
    withProgress,
    showTextDocument,
    get activeTextEditor() {
      return host.activeEditor();
    },
    get visibleTextEditors() {
      return host.visibleEditors();
    },
    onDidChangeActiveTextEditor: host.onDidChangeActiveTextEditor.event,
    onDidChangeVisibleTextEditors: host.onDidChangeVisibleTextEditors.event,
    onDidChangeTextEditorSelection: host.onDidChangeTextEditorSelection.event,
    onDidChangeTextEditorVisibleRanges: host.onDidChangeTextEditorVisibleRanges.event,
    onDidChangeTextEditorOptions: host.onDidChangeTextEditorOptions.event,
    onDidChangeTextEditorViewColumn: T.noneEvent,
    createTextEditorDecorationType,
    createTerminal,
    get terminals() {
      return [...host.terminals.values()].map((terminal) => terminal.facade);
    },
    get activeTerminal() {
      return host.activeTerminal;
    },
    onDidOpenTerminal: host.onDidOpenTerminal.event,
    onDidCloseTerminal: host.onDidCloseTerminal.event,
    onDidChangeActiveTerminal: host.onDidChangeActiveTerminal.event,
    onDidChangeTerminalState: T.noneEvent,
    get state() {
      return { focused: host.focused, active: host.focused };
    },
    onDidChangeWindowState: host.onDidChangeWindowState.event,
    get activeColorTheme() {
      return { kind: host.colorThemeKind };
    },
    onDidChangeActiveColorTheme: host.onDidChangeActiveColorTheme.event,
    tabGroups: host.tabGroups.api(),
    activeNotebookEditor: undefined,
    visibleNotebookEditors: [],
    createWebviewPanel: (viewType: string, title: string, showOptions: number | { viewColumn?: number; preserveFocus?: boolean }, options?: Record<string, unknown>) =>
      host.webviews.createPanel(runtime, viewType, title, showOptions, options),
    registerWebviewViewProvider: (viewId: string, provider: { resolveWebviewView: (view: unknown, context: unknown, token: unknown) => unknown }, options?: { webviewOptions?: { retainContextWhenHidden?: boolean } }) =>
      host.webviews.registerViewProvider(runtime, viewId, provider, options),
    registerWebviewPanelSerializer: (viewType: string, serializer: { deserializeWebviewPanel: (panel: unknown, state: unknown) => unknown }) =>
      host.webviews.registerSerializer(runtime, viewType, serializer),
    registerCustomEditorProvider: (
      viewType: string,
      provider: Record<string, unknown>,
      options?: { webviewOptions?: { retainContextWhenHidden?: boolean; enableFindWidget?: boolean }; supportsMultipleEditorsPerDocument?: boolean },
    ) => host.customEditors.register(runtime, viewType, provider, options),
    registerTreeDataProvider: (viewId: string, provider: Parameters<ExtensionHost["trees"]["register"]>[2]) => host.trees.register(runtime, viewId, provider),
    createTreeView: (viewId: string, options: Parameters<ExtensionHost["trees"]["create"]>[2]) => host.trees.create(runtime, viewId, options),
    registerUriHandler: accepted("window.registerUriHandler"),
    registerFileDecorationProvider: (provider: Parameters<ExtensionHost["fileDecorations"]["register"]>[1]) => host.fileDecorations.register(runtime, provider),
  });

  /* workspace */

  const folder = () => (host.workspace ? { uri: T.Uri.file(host.workspace), name: host.workspace.split(/[/\\]/).filter(Boolean).pop() ?? host.workspace, index: 0 } : undefined);

  function getConfiguration(section?: string, _scope?: unknown) {
    const full = (key: string) => (section ? `${section}.${key}` : key);
    const value = (section ? host.configValue(section) : undefined) as Record<string, unknown> | undefined;
    const config: Record<string, unknown> = {
      ...(value && typeof value === "object" ? structuredClone(value) : {}),
      get: (key: string, defaultValue?: unknown) => {
        const result = host.configValue(full(key));
        return result === undefined ? defaultValue : structuredClone(result);
      },
      has: (key: string) => host.configValue(full(key)) !== undefined,
      inspect: (key: string) => {
        const name = full(key);
        return {
          key: name,
          defaultValue: host.configDefaultOverrides[name] ?? host.configDefaults[name] ?? host.config.lumen[name],
          globalValue: host.config.user[name],
          workspaceValue: undefined,
          workspaceFolderValue: undefined,
        };
      },
      update: async (key: string, newValue: unknown) => {
        await host.requestView("updateConfiguration", full(key), toWire(newValue));
      },
    };
    return config;
  }

  /** workspace.applyEdit (metadata.isRefactoring changes nothing: edits that need it are confirmed per entry). */
  const applyEdit = (edit: T.WorkspaceEdit, _metadata?: { isRefactoring?: boolean }) => applyWorkspaceEdit(host, edit, extensionId);

  const fsError = (error: unknown, uri: T.Uri) => {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") return T.FileSystemError.FileNotFound(uri);
    if (code === "EEXIST") return T.FileSystemError.FileExists(uri);
    if (code === "ENOTDIR") return T.FileSystemError.FileNotADirectory(uri);
    if (code === "EISDIR") return T.FileSystemError.FileIsADirectory(uri);
    if (code === "EACCES" || code === "EPERM") return T.FileSystemError.NoPermissions(uri);
    return error;
  };
  const guard = async <R>(uri: T.Uri, run: (path: string) => Promise<R>): Promise<R> => {
    const target = T.Uri.revive(uri)!;
    if (target.scheme !== "file") throw T.FileSystemError.Unavailable(target);
    try {
      return await run(target.fsPath);
    } catch (error) {
      throw fsError(error, target);
    }
  };
  const localFileSystem = {
    stat: (uri: T.Uri) =>
      guard(uri, async (path) => {
        const stats = await stat(path);
        return {
          type: stats.isDirectory() ? T.FileType.Directory : stats.isFile() ? T.FileType.File : T.FileType.Unknown,
          ctime: stats.ctimeMs,
          mtime: stats.mtimeMs,
          size: stats.size,
        };
      }),
    readDirectory: (uri: T.Uri) =>
      guard(uri, async (path) =>
        (await readdir(path, { withFileTypes: true })).map(
          (entry) => [entry.name, entry.isDirectory() ? T.FileType.Directory : entry.isSymbolicLink() ? T.FileType.SymbolicLink : T.FileType.File] as [string, number],
        ),
      ),
    createDirectory: (uri: T.Uri) => guard(uri, async (path) => void (await mkdir(path, { recursive: true }))),
    readFile: (uri: T.Uri) => guard(uri, async (path) => new Uint8Array(await readFile(path))),
    writeFile: (uri: T.Uri, content: Uint8Array) =>
      guard(uri, async (path) => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);
      }),
    delete: (uri: T.Uri, options: { recursive?: boolean } = {}) => guard(uri, async (path) => rm(path, { recursive: !!options.recursive })),
    rename: (source: T.Uri, target: T.Uri, options: { overwrite?: boolean } = {}) =>
      guard(source, async (path) => {
        if (!options.overwrite && existsSync(T.Uri.revive(target)!.fsPath)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
        await rename(path, T.Uri.revive(target)!.fsPath);
      }),
    copy: (source: T.Uri, target: T.Uri, options: { overwrite?: boolean } = {}) =>
      guard(source, async (path) => {
        if (!options.overwrite && existsSync(T.Uri.revive(target)!.fsPath)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
        await copyFile(path, T.Uri.revive(target)!.fsPath);
      }),
  };
  /** workspace.fs: local files, or the file system provider of the URI's scheme. */
  const provided = host.fileSystems.api();
  const local = (uri: T.Uri) => T.Uri.revive(uri)!.scheme === "file";
  const fileSystem = {
    stat: (uri: T.Uri) => (local(uri) ? localFileSystem.stat(uri) : provided.stat(uri)),
    readDirectory: (uri: T.Uri) => (local(uri) ? localFileSystem.readDirectory(uri) : provided.readDirectory(uri)),
    createDirectory: (uri: T.Uri) => (local(uri) ? localFileSystem.createDirectory(uri) : provided.createDirectory(uri)),
    readFile: (uri: T.Uri) => (local(uri) ? localFileSystem.readFile(uri) : provided.readFile(uri)),
    writeFile: (uri: T.Uri, content: Uint8Array) => (local(uri) ? localFileSystem.writeFile(uri, content) : provided.writeFile(uri, content)),
    delete: (uri: T.Uri, options: { recursive?: boolean } = {}) => (local(uri) ? localFileSystem.delete(uri, options) : provided.delete(uri, options)),
    rename: (source: T.Uri, target: T.Uri, options: { overwrite?: boolean } = {}) =>
      local(source) ? localFileSystem.rename(source, target, options) : provided.rename(source, target, options),
    copy: (source: T.Uri, target: T.Uri, options: { overwrite?: boolean } = {}) =>
      local(source) ? localFileSystem.copy(source, target, options) : provided.copy(source, target, options),
    isWritableFileSystem: (scheme: string) => (scheme === "file" ? true : host.fileSystems.isWritable(scheme)),
  };

  function createFileSystemWatcher(pattern: string | T.RelativePattern, ignoreCreate = false, ignoreChange = false, ignoreDelete = false) {
    const glob = pattern instanceof T.RelativePattern || (typeof pattern === "object" && pattern) ? (pattern as T.RelativePattern) : null;
    const watcher = {
      matches: (path: string) => {
        const base = glob ? glob.baseUri.fsPath : host.workspace;
        if (!base) return false;
        const rel = relative(base, path).replace(/\\/g, "/");
        if (rel.startsWith("..")) return false;
        return matchGlob(glob ? glob.pattern : (pattern as string), glob ? rel : rel) || matchGlob(glob ? glob.pattern : (pattern as string), path);
      },
      create: ignoreCreate ? null : new T.EventEmitter<T.Uri>(),
      change: ignoreChange ? null : new T.EventEmitter<T.Uri>(),
      delete: ignoreDelete ? null : new T.EventEmitter<T.Uri>(),
    };
    host.watchers.add(watcher);
    return {
      ignoreCreateEvents: ignoreCreate,
      ignoreChangeEvents: ignoreChange,
      ignoreDeleteEvents: ignoreDelete,
      onDidCreate: watcher.create?.event ?? T.noneEvent,
      onDidChange: watcher.change?.event ?? T.noneEvent,
      onDidDelete: watcher.delete?.event ?? T.noneEvent,
      dispose: () => {
        host.watchers.delete(watcher);
        watcher.create?.dispose();
        watcher.change?.dispose();
        watcher.delete?.dispose();
      },
    };
  }

  const workspace = graceful("workspace", {
    get workspaceFolders() {
      const f = folder();
      return f ? [f] : undefined;
    },
    get rootPath() {
      return host.workspace ?? undefined;
    },
    get name() {
      return folder()?.name;
    },
    workspaceFile: undefined,
    getWorkspaceFolder: (uri: T.Uri) => {
      const f = folder();
      if (!f) return undefined;
      const rel = relative(f.uri.fsPath, T.Uri.revive(uri)!.fsPath);
      return rel.startsWith("..") ? undefined : f;
    },
    asRelativePath: (pathOrUri: string | T.Uri, includeWorkspaceFolder = false) => {
      const path = typeof pathOrUri === "string" ? pathOrUri : T.Uri.revive(pathOrUri)!.fsPath;
      const f = folder();
      if (!f) return path;
      const rel = relative(f.uri.fsPath, path);
      if (rel.startsWith("..")) return path;
      const out = rel.replace(/\\/g, "/");
      return includeWorkspaceFolder ? `${f.name}/${out}` : out;
    },
    onDidChangeWorkspaceFolders: host.onDidChangeWorkspaceFolders.event,
    getConfiguration,
    onDidChangeConfiguration: host.onDidChangeConfiguration.event,
    get textDocuments() {
      return [...host.documents.values()].map((document) => document.toApi());
    },
    openTextDocument: async (target?: string | T.Uri | { language?: string; content?: string }) => {
      if (typeof target === "string") return (await host.openDocument(T.Uri.file(target))).toApi();
      if (T.Uri.isUri(target)) {
        const uri = T.Uri.revive(target)!;
        if (uri.scheme === "untitled") {
          const existing = host.documentForUri(uri);
          if (existing) return existing.toApi();
        }
        return (await host.openDocument(uri)).toApi();
      }
      return host.createUntitled(target?.language ?? "plaintext", target?.content ?? "").toApi();
    },
    onDidOpenTextDocument: host.onDidOpenTextDocument.event,
    onDidCloseTextDocument: host.onDidCloseTextDocument.event,
    onDidChangeTextDocument: host.onDidChangeTextDocument.event,
    onDidSaveTextDocument: host.onDidSaveTextDocument.event,
    onWillSaveTextDocument: host.onWillSaveTextDocument.event,
    applyEdit,
    saveAll: async () => !!(await host.requestView("saveAll")),
    save: async (uri: T.Uri) => ((await host.requestView("saveDocument", keyOfUri(T.Uri.revive(uri)!))) ? uri : undefined),
    findFiles: (include: string | T.RelativePattern, exclude?: string | T.RelativePattern | null, maxResults?: number, token?: T.CancellationToken) =>
      host.findFiles(include, exclude, maxResults, token),
    fs: fileSystem,
    createFileSystemWatcher,
    isTrusted: true,
    onDidGrantWorkspaceTrust: T.noneEvent,
    onDidCreateFiles: host.onDidCreateFiles.event,
    onDidDeleteFiles: host.onDidDeleteFiles.event,
    onDidRenameFiles: host.onDidRenameFiles.event,
    onWillCreateFiles: host.onWillCreateFiles.event,
    onWillDeleteFiles: host.onWillDeleteFiles.event,
    onWillRenameFiles: host.onWillRenameFiles.event,
    registerTextDocumentContentProvider: (scheme: string, provider: Parameters<ExtensionHost["contentProviders"]["register"]>[2]) =>
      host.contentProviders.register(runtime, scheme, provider),
    registerFileSystemProvider: (scheme: string, provider: FileSystemProvider, options?: { isCaseSensitive?: boolean; isReadonly?: boolean }) =>
      host.fileSystems.register(runtime, scheme, provider, options),
    notebookDocuments: [],
  });

  /* languages */

  let collectionSeq = 0;
  function createDiagnosticCollection(name = `${extensionId}-diagnostics`) {
    const owner = `${extensionId}:${name}:${++collectionSeq}`;
    const entries = new Map<string, { uri: T.Uri; list: readonly T.Diagnostic[] }>();
    const collection = {
      name,
      set(uriOrEntries: T.Uri | readonly [T.Uri, readonly T.Diagnostic[] | undefined][], diagnostics?: readonly T.Diagnostic[]) {
        const list: [T.Uri, readonly T.Diagnostic[] | undefined][] = T.Uri.isUri(uriOrEntries) ? [[uriOrEntries, diagnostics]] : [...uriOrEntries];
        for (const [uri, items] of list) {
          const target = T.Uri.revive(uri)!;
          const key = target.toString();
          if (items?.length) entries.set(key, { uri: target, list: [...items] });
          else entries.delete(key);
          host.setDiagnostics(owner, target, items ? [...items] : undefined);
        }
      },
      delete(uri: T.Uri) {
        const target = T.Uri.revive(uri)!;
        entries.delete(target.toString());
        host.setDiagnostics(owner, target, undefined);
      },
      clear() {
        entries.clear();
        host.clearDiagnostics(owner);
      },
      forEach(callback: (uri: T.Uri, diagnostics: readonly T.Diagnostic[], collection: unknown) => unknown, thisArg?: unknown) {
        for (const { uri, list } of entries.values()) callback.call(thisArg, uri, list, collection);
      },
      get: (uri: T.Uri) => entries.get(T.Uri.revive(uri)!.toString())?.list,
      has: (uri: T.Uri) => entries.has(T.Uri.revive(uri)!.toString()),
      dispose() {
        collection.clear();
      },
      [Symbol.iterator]: function* () {
        for (const { uri, list } of entries.values()) yield [uri, list];
      },
    };
    return collection;
  }

  function getDiagnostics(uri?: T.Uri) {
    if (uri) {
      const key = normalizeKey(keyOfUri(T.Uri.revive(uri)!));
      return [...host.diagnostics.values()].flatMap((collection) => collection.get(key)?.list ?? []);
    }
    const merged = new Map<string, { uri: T.Uri; list: T.Diagnostic[] }>();
    for (const collection of host.diagnostics.values()) {
      for (const [key, entry] of collection) {
        const target = merged.get(key) ?? { uri: entry.uri, list: [] };
        target.list.push(...entry.list);
        merged.set(key, target);
      }
    }
    return [...merged.values()].map((entry) => [entry.uri, entry.list]);
  }

  function createLanguageStatusItem(id: string, selector: unknown) {
    const item = createStatusBarItem(`language-status.${id}`, T.StatusBarAlignment.Right, 100) as Record<string, any>;
    const filters = host.normalizeSelector(selector);
    const sync = () => {
      const editor = host.activeEditorKey ? host.document(host.activeEditorKey) : undefined;
      if (editor && matchesSelector(filters, editor.key, editor.languageId)) item.show();
      else item.hide();
    };
    const subscription = host.onDidChangeActiveTextEditor.event(sync);
    queueMicrotask(sync);
    const status: Record<string, unknown> = {
      id,
      selector,
      severity: T.LanguageStatusSeverity.Information,
      busy: false,
      accessibilityInformation: undefined,
      dispose: () => {
        subscription.dispose();
        item.dispose();
      },
    };
    for (const key of ["name", "text", "detail", "command"]) {
      Object.defineProperty(status, key, {
        get: () => (key === "detail" ? item.tooltip : item[key]),
        set: (value: unknown) => {
          if (key === "detail") item.tooltip = value;
          else item[key] = value;
        },
      });
    }
    return status;
  }

  const languages = graceful("languages", {
    registerCompletionItemProvider: provider("completion"),
    registerHoverProvider: provider("hover"),
    registerDefinitionProvider: provider("definition"),
    registerReferenceProvider: provider("references"),
    registerDocumentFormattingEditProvider: provider("formatting"),
    registerDocumentRangeFormattingEditProvider: provider("rangeFormatting"),
    registerDocumentSymbolProvider: provider("documentSymbol"),
    createDiagnosticCollection,
    getDiagnostics,
    onDidChangeDiagnostics: host.onDidChangeDiagnostics.event,
    getLanguages: async () => [...host.languageIds].sort(),
    setTextDocumentLanguage: async (document: { uri: T.Uri }, languageId: string) => {
      const target = host.documentForUri(document.uri);
      if (!target) throw new Error("setTextDocumentLanguage: unknown document");
      await host.requestView("setDocumentLanguage", target.key, languageId);
      target.languageId = languageId;
      return target.toApi();
    },
    match: (selector: unknown, document: { uri: T.Uri; languageId: string }) =>
      matchesSelector(host.normalizeSelector(selector), keyOfUri(document.uri), document.languageId) ? 10 : 0,
    setLanguageConfiguration: (languageId: string, configuration: unknown) => {
      const id = typeof languageId === "string" ? languageId : "";
      const config = wireLanguageConfiguration(configuration);
      if (!id || !config) return new T.Disposable(() => {});
      host.post({ type: "languageConfiguration", languageId: id, config });
      return new T.Disposable(() => host.post({ type: "languageConfiguration", languageId: id, config: null }));
    },
    createLanguageStatusItem,
    registerCodeActionsProvider: provider("codeAction"),
    registerCodeLensProvider: provider("codeLens"),
    registerSignatureHelpProvider: provider("signatureHelp"),
    registerRenameProvider: provider("rename"),
    registerDocumentHighlightProvider: provider("documentHighlight"),
    registerFoldingRangeProvider: provider("foldingRange"),
    registerInlayHintsProvider: provider("inlayHints"),
    registerDocumentSemanticTokensProvider: provider("semanticTokens"),
    registerDocumentRangeSemanticTokensProvider: provider("rangeSemanticTokens"),
    registerColorProvider: provider("color"),
    registerDocumentLinkProvider: provider("documentLink"),
    registerOnTypeFormattingEditProvider: provider("onTypeFormatting"),
    registerInlineCompletionItemProvider: provider("inlineCompletion"),
    registerTypeDefinitionProvider: provider("typeDefinition"),
    registerImplementationProvider: provider("implementation"),
    registerDeclarationProvider: provider("declaration"),
    registerWorkspaceSymbolProvider: workspaceSymbolProvider,
    registerSelectionRangeProvider: provider("selectionRange"),
    registerCallHierarchyProvider: provider("callHierarchy"),
    registerLinkedEditingRangeProvider: provider("linkedEditingRange"),
    registerEvaluatableExpressionProvider: accepted("languages.registerEvaluatableExpressionProvider"),
  });

  /* env */

  const env = graceful("env", {
    appName: host.init.appName,
    appRoot: host.init.appRoot,
    appHost: "desktop",
    language: "en",
    machineId: host.machineId,
    sessionId: host.sessionId,
    uriScheme: "lumen",
    uiKind: T.UIKind.Desktop,
    remoteName: undefined,
    get shell() {
      return process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : (process.env.SHELL ?? "/bin/sh");
    },
    clipboard: {
      readText: async () => (await host.requestView("clipboardRead")) ?? "",
      writeText: async (text: string) => void (await host.requestView("clipboardWrite", String(text))),
    },
    openExternal: async (uri: T.Uri) => !!(await host.requestMain("openExternal", T.Uri.revive(uri)!.toString(true))),
    asExternalUri: async (uri: T.Uri) => uri,
    isTelemetryEnabled: false,
    onDidChangeTelemetryEnabled: T.noneEvent,
    createTelemetryLogger: () => ({
      isUsageEnabled: false,
      isErrorsEnabled: false,
      onDidChangeEnableStates: T.noneEvent,
      logUsage: () => {},
      logError: () => {},
      dispose: () => {},
    }),
    logLevel: T.LogLevel.Info,
    onDidChangeLogLevel: T.noneEvent,
    isNewAppInstall: false,
    onDidChangeShell: T.noneEvent,
  });

  /* debug */

  const debug = graceful("debug", {
    get activeDebugSession() {
      return host.debug.activeSessionApi;
    },
    get activeDebugConsole() {
      return {
        append: (value: string) => void host.debug.appendConsole(String(value)),
        appendLine: (value: string) => void host.debug.appendConsole(`${String(value)}\n`),
      };
    },
    get activeStackItem() {
      return host.debug.activeStackItemApi;
    },
    get breakpoints() {
      return host.debug.breakpoints;
    },
    onDidChangeActiveDebugSession: host.debug.onDidChangeActiveDebugSession.event,
    onDidStartDebugSession: host.debug.onDidStartDebugSession.event,
    onDidReceiveDebugSessionCustomEvent: host.debug.onDidReceiveDebugSessionCustomEvent.event,
    onDidTerminateDebugSession: host.debug.onDidTerminateDebugSession.event,
    onDidChangeBreakpoints: host.debug.onDidChangeBreakpoints.event,
    onDidChangeActiveStackItem: host.debug.onDidChangeActiveStackItem.event,
    registerDebugConfigurationProvider: (type: string, provider: Record<string, unknown>, triggerKind?: number) =>
      host.debug.registerProvider(runtime, String(type), provider as Record<string, (...args: any[]) => any>, triggerKind),
    registerDebugAdapterDescriptorFactory: (type: string, factory: Record<string, unknown>) =>
      host.debug.registerDescriptorFactory(runtime, String(type), factory as Record<string, (...args: any[]) => any>),
    registerDebugAdapterTrackerFactory: (type: string, factory: Record<string, unknown>) =>
      host.debug.registerTrackerFactory(runtime, String(type), factory as Record<string, (...args: any[]) => any>),
    startDebugging: async (folder: T.WorkspaceFolder | undefined, nameOrConfiguration: string | Record<string, unknown>, parentSessionOrOptions?: unknown) =>
      host.debug.startDebugging(folder?.uri?.fsPath ?? host.workspace, nameOrConfiguration, parentSessionOrOptions),
    stopDebugging: async (session?: { id: string }) => host.debug.stopDebugging(session),
    addBreakpoints: (breakpoints: T.Breakpoint[]) => host.debug.addBreakpoints(breakpoints ?? []),
    removeBreakpoints: (breakpoints: T.Breakpoint[]) => host.debug.removeBreakpoints(breakpoints ?? []),
    asDebugSourceUri: (source: { path?: string; name?: string; sourceReference?: number }, session?: { id: string }) =>
      host.debug.asDebugSourceUri(source ?? {}, session?.id),
  });

  /* extensions */

  const extensions = {
    getExtension: (id: string) => {
      const target = host.runtimes.get(id.toLowerCase());
      return target ? host.extensionFacade(target) : undefined;
    },
    get all() {
      return [...host.runtimes.values()].map((target) => host.extensionFacade(target));
    },
    onDidChange: host.onDidChangeExtensions.event,
  };

  /* l10n */

  const l10n = {
    t: (message: string | { message: string; args?: unknown[] | Record<string, unknown> }, ...args: unknown[]) => {
      const text = typeof message === "string" ? message : message.message;
      const values = typeof message === "string" ? (args.length === 1 && typeof args[0] === "object" && args[0] ? args[0] : args) : (message.args ?? []);
      return text.replace(/\{(\w+)\}/g, (match, key: string) => {
        const value = (values as Record<string, unknown>)[key];
        return value === undefined ? match : String(value);
      });
    },
    bundle: undefined,
    uri: undefined,
  };

  const stubNamespace = (name: string) => graceful(name, {});

  const namespaces = {
    commands,
    window,
    workspace,
    languages,
    env,
    extensions,
    l10n,
    debug,
    tasks: stubNamespace("tasks"),
    scm: stubNamespace("scm"),
    tests: stubNamespace("tests"),
    notebooks: stubNamespace("notebooks"),
    authentication: stubNamespace("authentication"),
    comments: stubNamespace("comments"),
    chat: stubNamespace("chat"),
    lm: stubNamespace("lm"),
  };
  // Features (features/<area>.ts) add to the namespaces and override members of the same name.
  const featureApi = buildFeatureApi({ host, runtime, extensionId, notSupported });
  for (const [name, target] of Object.entries(namespaces)) {
    Object.defineProperties(target, featureApi[name as keyof typeof featureApi]);
  }

  return {
    version: API_VERSION,
    ...namespaces,
    ...exportedTypes,
    ...compatTypes,
    ...featureTypes(),
  };
}

type T_QuickPickItem = { label: string; description?: string; detail?: string; picked?: boolean; alwaysShow?: boolean; kind?: number; buttons?: unknown[] };

/** The classes, enums and helpers of the module (shared by every extension). */
const exportedTypes = {
  Uri: T.Uri,
  Position: T.Position,
  Range: T.Range,
  Selection: T.Selection,
  Location: T.Location,
  Diagnostic: T.Diagnostic,
  DiagnosticSeverity: T.DiagnosticSeverity,
  DiagnosticTag: T.DiagnosticTag,
  DiagnosticRelatedInformation: T.DiagnosticRelatedInformation,
  TextEdit: T.TextEdit,
  WorkspaceEdit: T.WorkspaceEdit,
  SnippetString: T.SnippetString,
  MarkdownString: T.MarkdownString,
  CompletionItem: T.CompletionItem,
  CompletionItemKind: T.CompletionItemKind,
  CompletionItemTag: T.CompletionItemTag,
  CompletionList: T.CompletionList,
  CompletionTriggerKind: T.CompletionTriggerKind,
  Hover: T.Hover,
  DocumentSymbol: T.DocumentSymbol,
  SymbolInformation: T.SymbolInformation,
  SymbolKind: T.SymbolKind,
  SymbolTag: T.SymbolTag,
  ThemeColor: T.ThemeColor,
  ThemeIcon: T.ThemeIcon,
  StatusBarAlignment: T.StatusBarAlignment,
  ViewColumn: T.ViewColumn,
  EndOfLine: T.EndOfLine,
  TextEditorRevealType: T.TextEditorRevealType,
  TextEditorCursorStyle: T.TextEditorCursorStyle,
  TextEditorLineNumbersStyle: T.TextEditorLineNumbersStyle,
  TextEditorSelectionChangeKind: T.TextEditorSelectionChangeKind,
  ConfigurationTarget: T.ConfigurationTarget,
  Disposable: T.Disposable,
  EventEmitter: T.EventEmitter,
  CancellationTokenSource: T.CancellationTokenSource,
  CancellationError: T.CancellationError,
  ProgressLocation: T.ProgressLocation,
  FileType: T.FileType,
  FileSystemError: T.FileSystemError,
  FileChangeType: T.FileChangeType,
  RelativePattern: T.RelativePattern,
  DecorationRangeBehavior: T.DecorationRangeBehavior,
  OverviewRulerLane: T.OverviewRulerLane,
  TextDocumentSaveReason: T.TextDocumentSaveReason,
  TextDocumentChangeReason: T.TextDocumentChangeReason,
  QuickPickItemKind: T.QuickPickItemKind,
  QuickInputButtons: T.QuickInputButtons,
  ExtensionMode: T.ExtensionMode,
  ExtensionKind: T.ExtensionKind,
  UIKind: T.UIKind,
  LogLevel: T.LogLevel,
  ColorThemeKind: T.ColorThemeKind,
  CodeActionKind: T.CodeActionKind,
  CodeAction: T.CodeAction,
  CodeActionTriggerKind: T.CodeActionTriggerKind,
  CodeLens: T.CodeLens,
  FoldingRange: T.FoldingRange,
  FoldingRangeKind: T.FoldingRangeKind,
  SignatureHelp: T.SignatureHelp,
  SignatureHelpTriggerKind: T.SignatureHelpTriggerKind,
  SignatureInformation: T.SignatureInformation,
  ParameterInformation: T.ParameterInformation,
  DocumentLink: T.DocumentLink,
  DocumentHighlight: T.DocumentHighlight,
  DocumentHighlightKind: T.DocumentHighlightKind,
  Color: T.Color,
  ColorInformation: T.ColorInformation,
  ColorPresentation: T.ColorPresentation,
  InlayHint: T.InlayHint,
  InlayHintKind: T.InlayHintKind,
  InlayHintLabelPart: T.InlayHintLabelPart,
  SemanticTokensLegend: T.SemanticTokensLegend,
  SemanticTokensBuilder: T.SemanticTokensBuilder,
  SemanticTokens: T.SemanticTokens,
  IndentAction: T.IndentAction,
  LanguageStatusSeverity: T.LanguageStatusSeverity,
  TreeItem: T.TreeItem,
  TreeItemCollapsibleState: T.TreeItemCollapsibleState,
  TreeItemCheckboxState: T.TreeItemCheckboxState,
  InlineCompletionItem: T.InlineCompletionItem,
  InlineCompletionList: T.InlineCompletionList,
  InlineCompletionTriggerKind: T.InlineCompletionTriggerKind,
  FileDecoration: T.FileDecoration,
  SemanticTokensEdit: T.SemanticTokensEdit,
  SemanticTokensEdits: T.SemanticTokensEdits,
  SelectionRange: T.SelectionRange,
  EnvironmentVariableMutatorType: T.EnvironmentVariableMutatorType,
  TerminalExitReason: T.TerminalExitReason,
  TerminalLocation: T.TerminalLocation,
  DebugConfigurationProviderTriggerKind: T.DebugConfigurationProviderTriggerKind,
  DebugConsoleMode: T.DebugConsoleMode,
  Breakpoint: T.Breakpoint,
  SourceBreakpoint: T.SourceBreakpoint,
  FunctionBreakpoint: T.FunctionBreakpoint,
  DebugAdapterExecutable: T.DebugAdapterExecutable,
  DebugAdapterServer: T.DebugAdapterServer,
  DebugAdapterNamedPipeServer: T.DebugAdapterNamedPipeServer,
  DebugAdapterInlineImplementation: T.DebugAdapterInlineImplementation,
  DebugThread: T.DebugThread,
  DebugStackFrame: T.DebugStackFrame,
  Tab,
  TabGroup,
};
