import { createHash } from "crypto";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, join } from "path";
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
 * With supportsMultipleEditorsPerDocument a document can be shown by several
 * panels (one per editor group); a backed-up document (hot exit) is reopened
 * from its backup.
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

/** One webview panel showing a document. */
type Editor = { id: string; panel: Record<string, any>; disposeListener: { dispose(): unknown } | null };

/** A document opened in a custom editor, and the editors showing it. */
type Instance = {
  viewType: string;
  extensionId: string;
  path: string;
  key: string;
  editors: Editor[];
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

  register(runtime: ExtensionRuntime | null, viewType: string, provider: Record<string, any>, options: Registration["options"] = {}): T.Disposable {
    if (!viewType || typeof viewType !== "string") throw new Error("registerCustomEditorProvider: a view type is required");
    if (this.providers.has(viewType)) throw new Error(`a custom editor provider for '${viewType}' is already registered`);
    const kind: CustomEditorProviderKind =
      typeof provider.resolveCustomTextEditor === "function" ? "text" : typeof provider.onDidChangeCustomDocument === "function" ? "editable" : "readonly";
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
  async open(
    path: string,
    viewType: string,
    showOptions?: number | { viewColumn?: number; preserveFocus?: boolean },
    restoreId?: string,
  ): Promise<{ id: string; kind: CustomEditorProviderKind } | null> {
    await this.#host.activateByEvent(`onCustomEditor:${viewType}`);
    const registration = this.providers.get(viewType);
    if (!registration) return null;
    const uri = uriOfKey(path);
    const key = keyOf(viewType, path);
    const existing = this.#instances.get(key);
    // One editor per document unless the provider supports more (restored tabs always get theirs).
    if (existing?.editors[0] && !restoreId && !registration.options.supportsMultipleEditorsPerDocument) {
      (existing.editors[0].panel.reveal as (column?: number, preserveFocus?: boolean) => void)?.();
      return { id: existing.editors[0].id, kind: registration.kind };
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
    const instance: Instance = existing ?? {
      viewType,
      extensionId: registration.extensionId,
      path,
      key,
      editors: [],
      registration,
      textDocument: null,
      customDocument: null,
      dirty: false,
      undoStack: [],
      redoStack: [],
      changeListener: null,
    };
    const editor: Editor = { id: String(panel.id), panel, disposeListener: null };
    instance.editors.push(editor);
    this.#instances.set(key, instance);
    editor.disposeListener = (panel.onDidDispose as (callback: () => void) => { dispose(): unknown })(() => this.#disposeEditor(instance, editor));
    try {
      if (!existing) await this.#openDocument(instance, uri);
      await this.#resolveEditor(instance, panel);
    } catch (error) {
      this.#host.log(
        "error",
        `resolving the custom editor ${viewType} for ${path} failed: ${error instanceof Error ? (error.stack ?? error.message) : error}`,
        registration.extensionId,
      );
      (panel.dispose as () => void)();
      return null;
    }
    if (instance.dirty) this.#host.post({ type: "webviewUpdate", id: editor.id, dirty: true });
    return { id: editor.id, kind: registration.kind };
  }

  /** The text document, or the extension's CustomDocument (from its backup when there is one). */
  async #openDocument(instance: Instance, uri: T.Uri): Promise<void> {
    const { provider, kind } = instance.registration;
    if (kind === "text") {
      instance.textDocument = await this.#host.openDocument(uri);
      return;
    }
    const backupId = kind === "editable" ? this.#backups()[instance.key] : undefined;
    const token = new T.CancellationTokenSource().token;
    instance.customDocument = (await provider.openCustomDocument(uri, { backupId, untitledDocumentData: undefined }, token)) as Record<string, any>;
    if (kind === "editable" && typeof provider.onDidChangeCustomDocument === "function") {
      instance.changeListener = provider.onDidChangeCustomDocument((event: Record<string, any>) => this.#onChange(instance, event)) as { dispose(): unknown };
    }
    if (backupId !== undefined) {
      // The document has the unsaved changes of the backup: dirty until saved or reverted.
      this.#forgetBackup(instance.key);
      instance.dirty = true;
    }
  }

  async #resolveEditor(instance: Instance, panel: Record<string, any>): Promise<void> {
    const { provider, kind } = instance.registration;
    const token = new T.CancellationTokenSource().token;
    if (kind === "text") await provider.resolveCustomTextEditor(instance.textDocument!.toApi(), panel, token);
    else await provider.resolveCustomEditor(instance.customDocument, panel, token);
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
    for (const editor of instance.editors) this.#host.post({ type: "webviewUpdate", id: editor.id, dirty });
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
    for (const editor of instance.editors) {
      editor.panel.title = basename(instance.path);
      this.#host.post({ type: "webviewUpdate", id: editor.id, uri: instance.path });
    }
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

  /**
   * backupCustomDocument (hot exit): the extension writes the unsaved changes to
   * `destination` and returns a backup, whose id the next openCustomDocument of
   * the file gets back as `openContext.backupId`.
   */
  async backup(path: string, viewType: string, context: { destination?: T.Uri } = {}): Promise<string | null> {
    const instance = this.#instance(path, viewType);
    if (!instance || instance.registration.kind !== "editable" || typeof instance.registration.provider.backupCustomDocument !== "function") return null;
    const destination = context.destination ?? T.Uri.file(join(this.#backupFolder(), createHash("sha1").update(instance.key).digest("hex").slice(0, 20)));
    try {
      mkdirSync(this.#backupFolder(), { recursive: true });
      const backup = await instance.registration.provider.backupCustomDocument(instance.customDocument, { destination }, new T.CancellationTokenSource().token);
      // A CustomDocumentBackup is { id, delete() }; some extensions return the id itself.
      const id = typeof backup === "string" ? backup : typeof backup?.id === "string" ? (backup.id as string) : null;
      if (id !== null) this.#writeBackups({ ...this.#backups(), [instance.key]: id });
      return id;
    } catch (error) {
      this.#host.log("error", `backing up the custom editor ${viewType} failed: ${error instanceof Error ? error.message : error}`, instance.extensionId);
      return null;
    }
  }

  #backupFolder(): string {
    return join(this.#host.init.userData, "customEditorBackups");
  }

  /** Backup ids by document key, kept across restarts. */
  #backups(): Record<string, string> {
    try {
      const parsed = JSON.parse(readFileSync(join(this.#backupFolder(), "backups.json"), "utf8")) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  #writeBackups(backups: Record<string, string>): void {
    try {
      mkdirSync(this.#backupFolder(), { recursive: true });
      writeFileSync(join(this.#backupFolder(), "backups.json"), JSON.stringify(backups));
    } catch (error) {
      this.#host.log("warning", `cannot store custom editor backups: ${error instanceof Error ? error.message : error}`);
    }
  }

  #forgetBackup(key: string): void {
    const backups = this.#backups();
    if (!(key in backups)) return;
    delete backups[key];
    this.#writeBackups(backups);
  }

  #clearHistory(instance: Instance): void {
    instance.undoStack = [];
    instance.redoStack = [];
    this.#setDirty(instance, false);
    // Saved or reverted: an older backup must not come back.
    this.#forgetBackup(instance.key);
  }

  /* ── disposal ──────────────────────────────────────────────────────── */

  /** An editor closed: the document goes with its last editor. */
  #disposeEditor(instance: Instance, editor: Editor): void {
    editor.disposeListener?.dispose();
    instance.editors = instance.editors.filter((candidate) => candidate !== editor);
    if (instance.editors.length || this.#instances.get(instance.key) !== instance) return;
    this.#instances.delete(instance.key);
    instance.changeListener?.dispose();
    try {
      if (instance.customDocument && typeof instance.customDocument.dispose === "function") instance.customDocument.dispose();
    } catch (error) {
      this.#host.log(
        "warning",
        `disposing the custom document of ${instance.viewType} failed: ${error instanceof Error ? error.message : error}`,
        instance.extensionId,
      );
    }
  }
}
