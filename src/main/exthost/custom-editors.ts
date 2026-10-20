import { basename } from "path";
import type { CustomEditorContribution } from "../../shared/extensions.ts";
import { customEditorContributions } from "../../shared/extensions.ts";
import { matchesSelector } from "../../shared/glob.ts";
import { keyOfUri, normalizeKey, uriOfKey } from "./documents.ts";
import type { ExtHostDocument } from "./documents.ts";
import type { ExtensionHost, ExtensionRuntime } from "./host.ts";
import * as T from "./types.ts";

/**
 * Custom editors (window.registerCustomEditorProvider): a file shown by a
 * webview panel the extension draws. Three provider kinds, like VS Code:
 * CustomTextEditorProvider (the file's text document), CustomReadonlyEditorProvider
 * (openCustomDocument + resolveCustomEditor) and CustomEditorProvider (the same,
 * plus onDidChangeCustomDocument / save / saveAs / revert / undo / redo).
 * The panel is an ordinary webview panel; the view shows it in an editor tab.
 */

export type CustomEditorProviderKind = "text" | "readonly" | "editable";

type RawWebviewOptions = {
  enableScripts?: boolean;
  enableFindWidget?: boolean;
  retainContextWhenHidden?: boolean;
  localResourceRoots?: readonly T.Uri[];
};

type Registration = {
  viewType: string;
  extensionId: string;
  runtime: ExtensionRuntime | null;
  kind: CustomEditorProviderKind;
  provider: Record<string, any>;
  options: { webviewOptions?: RawWebviewOptions; supportsMultipleEditorsPerDocument?: boolean };
};

type Instance = {
  id: string;
  viewType: string;
  extensionId: string;
  path: string;
  key: string;
  panel: Record<string, any>;
  registration: Registration;
  /** The file's text document (CustomTextEditorProvider). */
  textDocument: ExtHostDocument | null;
  /** The extension's CustomDocument (the other two kinds). */
  customDocument: Record<string, any> | null;
  dirty: boolean;
  /** CustomDocumentEditEvent callbacks, for Lumen's Undo / Redo. */
  undoStack: (() => unknown)[];
  redoStack: (() => unknown)[];
  changeListener: { dispose(): unknown } | null;
  disposeListener: { dispose(): unknown } | null;
};

const keyOf = (viewType: string, path: string) => `${viewType}\u0000${normalizeKey(path)}`;

export class CustomEditorManager {
  readonly #host: ExtensionHost;
  readonly providers = new Map<string, Registration>();
  readonly #instances = new Map<string, Instance>();

  constructor(host: ExtensionHost) {
    this.#host = host;
  }

  /* ── registration ──────────────────────────────────────────────────── */

  register(
    runtime: ExtensionRuntime | null,
    viewType: string,
    provider: Record<string, any>,
    options: Registration["options"] = {},
  ): T.Disposable {
    if (!viewType || typeof viewType !== "string") throw new Error("registerCustomEditorProvider: a view type is required");
    if (this.providers.has(viewType)) throw new Error(`a custom editor provider for '${viewType}' is already registered`);
    const kind: CustomEditorProviderKind =
      typeof provider.resolveCustomTextEditor === "function"
        ? "text"
        : typeof provider.onDidChangeCustomDocument === "function"
          ? "editable"
          : "readonly";
    this.providers.set(viewType, { viewType, extensionId: runtime?.id ?? "unknown", runtime, kind, provider, options });
    return new T.Disposable(() => {
      if (this.providers.get(viewType)?.provider === provider) this.providers.delete(viewType);
    });
  }

  providerKind(viewType: string): CustomEditorProviderKind | null {
    return this.providers.get(viewType)?.kind ?? null;
  }

  /* ── contributes.customEditors ─────────────────────────────────────── */

  #contributions(): CustomEditorContribution[] {
    const out: CustomEditorContribution[] = [];
    for (const runtime of this.#host.runtimes.values()) {
      out.push(...customEditorContributions(runtime.id, runtime.description.manifest.contributes));
    }
    return out;
  }

  /** Every contributed custom editor whose selector matches a file (both priorities). */
  contributionsFor(path: string, language: string): CustomEditorContribution[] {
    return this.#contributions().filter((entry) => matchesSelector(entry.selector, path, language));
  }

  /** The editor a matching file opens with (a "default" priority contribution), if any. */
  defaultEditorFor(path: string, language: string): CustomEditorContribution | undefined {
    return this.#contributions().find((entry) => entry.priority === "default" && matchesSelector(entry.selector, path, language));
  }

  /* ── opening ───────────────────────────────────────────────────────── */

  /**
   * Open `path` in the custom editor `viewType` (activating the contributing
   * extension). Returns the webview id, or null when no provider handles it.
   */
  async open(path: string, viewType: string, showOptions?: number | { viewColumn?: number; preserveFocus?: boolean }, restoreId?: string): Promise<{ id: string; kind: CustomEditorProviderKind } | null> {
    await this.#host.activateByEvent(`onCustomEditor:${viewType}`);
    const registration = this.providers.get(viewType);
    if (!registration) return null;
    const uri = uriOfKey(path);
    const key = keyOf(viewType, path);
    const existing = this.#instances.get(key);
    if (existing && !restoreId) {
      (existing.panel.reveal as (column?: number, preserveFocus?: boolean) => void)?.();
      return { id: existing.id, kind: registration.kind };
    }
    const webviewOptions = registration.options.webviewOptions ?? {};
    // Custom editors show extension pages: scripts are on and context is kept by default (like VS Code).
    const raw = {
      enableScripts: webviewOptions.enableScripts ?? true,
      retainContextWhenHidden: webviewOptions.retainContextWhenHidden ?? true,
      enableFindWidget: webviewOptions.enableFindWidget,
      localResourceRoots: webviewOptions.localResourceRoots,
    };
    const panel = this.#host.webviews.createPanel(
      registration.runtime,
      viewType,
      basename(path),
      showOptions ?? { viewColumn: T.ViewColumn.Active, preserveFocus: false },
      raw,
      restoreId,
      { uri: keyOfUri(uri), dirty: false, customKind: registration.kind },
    ) as Record<string, any>;
    const instance: Instance = {
      id: String(panel.id),
      viewType,
      extensionId: registration.extensionId,
      path,
      key,
      panel,
      registration,
      textDocument: null,
      customDocument: null,
      dirty: false,
      undoStack: [],
      redoStack: [],
      changeListener: null,
      disposeListener: null,
    };
    this.#instances.set(key, instance);
    instance.disposeListener = (panel.onDidDispose as (callback: () => void) => { dispose(): unknown })(() => this.#disposeInstance(instance));
    try {
      await this.#resolve(instance, uri);
    } catch (error) {
      this.#host.log("error", `resolving the custom editor ${viewType} for ${path} failed: ${error instanceof Error ? (error.stack ?? error.message) : error}`, registration.extensionId);
      (panel.dispose as () => void)();
      return null;
    }
    return { id: instance.id, kind: registration.kind };
  }

  async #resolve(instance: Instance, uri: T.Uri): Promise<void> {
    const { provider, kind } = instance.registration;
    const token = new T.CancellationTokenSource().token;
    if (kind === "text") {
      const document = await this.#host.openDocument(uri);
      instance.textDocument = document;
      await provider.resolveCustomTextEditor(document.toApi(), instance.panel, token);
      return;
    }
    const customDocument = (await provider.openCustomDocument(uri, { backupId: undefined, untitledDocumentData: undefined }, token)) as Record<string, any>;
    instance.customDocument = customDocument;
    if (kind === "editable" && typeof provider.onDidChangeCustomDocument === "function") {
      instance.changeListener = provider.onDidChangeCustomDocument((event: Record<string, any>) => this.#onChange(instance, event)) as { dispose(): unknown };
    }
    await provider.resolveCustomEditor(customDocument, instance.panel, token);
  }

  /** Bring back a custom editor tab saved with the window (same panel id, provider asked again). */
  async deserialize(path: string, viewType: string, webviewId: string, _state: unknown): Promise<boolean> {
    await this.#host.activateByEvent(`onCustomEditor:${viewType}`);
    if (!this.providers.has(viewType)) return false;
    const opened = await this.open(path, viewType, { viewColumn: T.ViewColumn.Active, preserveFocus: true }, webviewId);
    return !!opened;
  }

  /* ── dirty state ───────────────────────────────────────────────────── */

  #onChange(instance: Instance, event: Record<string, any>): void {
    const undo = typeof event?.undo === "function" ? (event.undo as () => unknown) : null;
    const redo = typeof event?.redo === "function" ? (event.redo as () => unknown) : null;
    if (undo) {
      instance.undoStack.push(undo);
      if (redo) instance.redoStack.push(redo);
    }
    this.#setDirty(instance, true);
  }

  #setDirty(instance: Instance, dirty: boolean): void {
    if (instance.dirty === dirty) return;
    instance.dirty = dirty;
    this.#host.post({ type: "webviewUpdate", id: instance.id, dirty });
  }

  #instance(path: string, viewType: string): Instance | undefined {
    return this.#instances.get(keyOf(viewType, path));
  }

  /* ── saving, reverting, undo / redo ────────────────────────────────── */

  async save(path: string, viewType: string): Promise<boolean> {
    const instance = this.#instance(path, viewType);
    if (!instance) return false;
    const provider = instance.registration.provider;
    try {
      if (instance.registration.kind === "text") {
        // The normal text save path: the view writes the document to disk.
        if (instance.textDocument) await instance.textDocument.save();
      } else {
        await provider.saveCustomDocument(instance.customDocument, new T.CancellationTokenSource().token);
      }
      this.#clearHistory(instance);
      return true;
    } catch (error) {
      this.#host.log("error", `saving the custom editor ${viewType} failed: ${error instanceof Error ? error.message : error}`, instance.extensionId);
      return false;
    }
  }

  async saveAs(path: string, viewType: string, destination: string): Promise<boolean> {
    const instance = this.#instance(path, viewType);
    if (!instance) return false;
    const uri = uriOfKey(destination);
    try {
      if (instance.registration.kind === "text") {
        if (instance.textDocument) await this.#host.requestView("saveDocumentAs", instance.textDocument.key, keyOfUri(uri));
      } else {
        await instance.registration.provider.saveCustomDocumentAs(instance.customDocument, uri, new T.CancellationTokenSource().token);
      }
    } catch (error) {
      this.#host.log("error", `saving the custom editor ${viewType} as failed: ${error instanceof Error ? error.message : error}`, instance.extensionId);
      return false;
    }
    // The tab follows the new file (name, and the key used by later saves).
    const previousKey = instance.key;
    this.#instances.delete(previousKey);
    instance.path = keyOfUri(uri);
    instance.key = keyOf(instance.viewType, instance.path);
    this.#instances.set(instance.key, instance);
    instance.panel.title = basename(instance.path);
    this.#host.post({ type: "webviewUpdate", id: instance.id, uri: instance.path });
    this.#clearHistory(instance);
    return true;
  }

  async revert(path: string, viewType: string): Promise<boolean> {
    const instance = this.#instance(path, viewType);
    if (!instance || instance.registration.kind !== "editable") return false;
    try {
      await instance.registration.provider.revertCustomDocument(instance.customDocument, new T.CancellationTokenSource().token);
      this.#clearHistory(instance);
      return true;
    } catch (error) {
      this.#host.log("error", `reverting the custom editor ${viewType} failed: ${error instanceof Error ? error.message : error}`, instance.extensionId);
      return false;
    }
  }

  undo(path: string, viewType: string): boolean {
    const instance = this.#instance(path, viewType);
    const undo = instance?.undoStack.pop();
    if (!instance || !undo) return false;
    try {
      undo();
    } catch (error) {
      this.#host.log("error", `undo of the custom editor ${viewType} failed: ${error instanceof Error ? error.message : error}`, instance.extensionId);
      return false;
    }
    this.#setDirty(instance, instance.undoStack.length > 0);
    return true;
  }

  redo(path: string, viewType: string): boolean {
    const instance = this.#instance(path, viewType);
    const redo = instance?.redoStack.pop();
    if (!instance || !redo) return false;
    try {
      redo();
    } catch (error) {
      this.#host.log("error", `redo of the custom editor ${viewType} failed: ${error instanceof Error ? error.message : error}`, instance.extensionId);
      return false;
    }
    if (instance.undoStack.length < 1) instance.undoStack.push(() => {});
    this.#setDirty(instance, true);
    return true;
  }

  /** backupCustomDocument: the extension returns a backup id (hot exit). */
  async backup(path: string, viewType: string, context: { destination?: T.Uri; cancelled?: boolean } = {}): Promise<string | null> {
    const instance = this.#instance(path, viewType);
    if (!instance || instance.registration.kind !== "editable" || typeof instance.registration.provider.backupCustomDocument !== "function") return null;
    try {
      const id = await instance.registration.provider.backupCustomDocument(instance.customDocument, context, new T.CancellationTokenSource().token);
      return typeof id === "string" ? id : null;
    } catch (error) {
      this.#host.log("error", `backing up the custom editor ${viewType} failed: ${error instanceof Error ? error.message : error}`, instance.extensionId);
      return null;
    }
  }

  #clearHistory(instance: Instance): void {
    instance.undoStack = [];
    instance.redoStack = [];
    this.#setDirty(instance, false);
  }

  /* ── disposal ──────────────────────────────────────────────────────── */

  #disposeInstance(instance: Instance): void {
    if (this.#instances.get(instance.key) !== instance) return;
    this.#instances.delete(instance.key);
    instance.changeListener?.dispose();
    instance.disposeListener?.dispose();
    try {
      if (instance.customDocument && typeof instance.customDocument.dispose === "function") instance.customDocument.dispose();
    } catch (error) {
      this.#host.log("warning", `disposing the custom document of ${instance.viewType} failed: ${error instanceof Error ? error.message : error}`, instance.extensionId);
    }
  }
}
