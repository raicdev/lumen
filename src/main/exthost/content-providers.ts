import type { ExtensionHost, ExtensionRuntime } from "./host.ts";
import { keyOfUri } from "./documents.ts";
import * as T from "./types.ts";

/**
 * Text document content providers (workspace.registerTextDocumentContentProvider):
 * read-only documents whose text comes from an extension. They ride on the same
 * path as extension file systems — the view opens `scheme:/path` through
 * readVirtualFile — so a scheme with a provider wins over the file system one.
 */

export type TextDocumentContentProvider = {
  onDidChange?: T.Event<T.Uri>;
  provideTextDocumentContent(uri: T.Uri, token: T.CancellationToken): string | PromiseLike<string>;
};

type Entry = { provider: TextDocumentContentProvider; extensionId: string };

export class ContentProviders {
  readonly #host: ExtensionHost;
  readonly providers = new Map<string, Entry>();

  constructor(host: ExtensionHost) {
    this.#host = host;
  }

  register(runtime: ExtensionRuntime | null, scheme: string, provider: TextDocumentContentProvider): T.Disposable {
    if (scheme === "file" || scheme === "untitled") throw new Error(`the scheme '${scheme}' is reserved`);
    if (this.providers.has(scheme)) throw new Error(`a text document content provider for the scheme '${scheme}' is already registered`);
    this.providers.set(scheme, { provider, extensionId: runtime?.id ?? "unknown" });
    const subscription = provider.onDidChange?.((uri) => void this.refresh(T.Uri.revive(uri)!));
    return new T.Disposable(() => {
      if (this.providers.get(scheme)?.provider !== provider) return;
      this.providers.delete(scheme);
      subscription?.dispose();
    });
  }

  has(scheme: string): boolean {
    return this.providers.has(scheme);
  }

  /** The content of a virtual document (`undefined` when the scheme has no provider). */
  async provide(uri: T.Uri): Promise<string | undefined> {
    const entry = this.providers.get(uri.scheme);
    if (!entry) return undefined;
    try {
      const content = await entry.provider.provideTextDocumentContent(uri, new T.CancellationTokenSource().token);
      return typeof content === "string" ? content : undefined;
    } catch (error) {
      this.#host.log("error", `content provider failed: ${error instanceof Error ? error.message : error}`, entry.extensionId);
      return undefined;
    }
  }

  /** provider.onDidChange(uri): the view reloads an open document (like a file system change). */
  async refresh(uri: T.Uri): Promise<void> {
    const key = keyOfUri(uri);
    const document = this.#host.document(key);
    // Documents open in the window are reloaded by the view; others are updated here.
    if (document && !document.open) {
      const content = await this.provide(uri);
      if (content !== undefined && content !== document.getText()) {
        document.setText(content, document.version + 1);
        this.#host.onDidChangeTextDocument.fire({ document: document.toApi(), contentChanges: [], reason: undefined });
      }
    }
    this.#host.post({ type: "virtualFilesChanged", paths: [key] });
  }
}
