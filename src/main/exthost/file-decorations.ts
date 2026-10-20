import type { HostFileDecoration, HostFileDecorations } from "../../shared/extensions.ts";
import type { ExtensionHost, ExtensionRuntime } from "./host.ts";
import { keyOfUri, uriOfKey } from "./documents.ts";
import * as T from "./types.ts";

/**
 * File decorations (window.registerFileDecorationProvider): the explorer asks
 * the host for the decorations of the files it shows, and refetches them when
 * a provider fires onDidChangeFileDecorations.
 */

export type FileDecoration = {
  badge?: string;
  tooltip?: string;
  color?: T.ThemeColor | string;
  propagate?: boolean;
};

export type FileDecorationProvider = {
  onDidChangeFileDecorations?: T.Event<T.Uri | T.Uri[] | undefined>;
  provideFileDecoration(uri: T.Uri, token: T.CancellationToken): FileDecoration | undefined | PromiseLike<FileDecoration | undefined>;
};

type Entry = { id: number; provider: FileDecorationProvider; extensionId: string };

export class FileDecorations {
  readonly #host: ExtensionHost;
  readonly providers = new Map<number, Entry>();
  #seq = 0;

  constructor(host: ExtensionHost) {
    this.#host = host;
  }

  register(runtime: ExtensionRuntime | null, provider: FileDecorationProvider): T.Disposable {
    const id = ++this.#seq;
    this.providers.set(id, { id, provider, extensionId: runtime?.id ?? "unknown" });
    const subscription = provider.onDidChangeFileDecorations?.((uris) => {
      const paths = uris === undefined ? undefined : [uris].flat().map((uri) => keyOfUri(T.Uri.revive(uri)!));
      this.#host.post({ type: "fileDecorationsChanged", paths: paths?.length ? paths : undefined });
    });
    // The explorer refetches the files it shows (a provider may have appeared after it asked).
    this.#announce();
    return new T.Disposable(() => {
      this.providers.delete(id);
      subscription?.dispose();
      this.#announce();
    });
  }

  #announce(): void {
    this.#host.post({ type: "fileDecorationsChanged" });
  }

  /** Merge every provider's decoration for `paths` (first provider to set a field wins). */
  async provide(paths: string[]): Promise<HostFileDecorations> {
    const entries = [...this.providers.values()];
    if (!entries.length || !paths.length) return [];
    const out: HostFileDecorations = [];
    await Promise.all(
      paths.map(async (path) => {
        const uri = uriOfKey(path);
        const merged: HostFileDecoration = {};
        let any = false;
        for (const entry of entries) {
          try {
            const decoration = await entry.provider.provideFileDecoration(uri, new T.CancellationTokenSource().token);
            if (!decoration) continue;
            if (merged.badge === undefined && decoration.badge !== undefined) {
              merged.badge = String(decoration.badge).slice(0, 2);
              any = true;
            }
            if (merged.tooltip === undefined && decoration.tooltip !== undefined) {
              merged.tooltip = typeof decoration.tooltip === "string" ? decoration.tooltip : String(decoration.tooltip);
              any = true;
            }
            if (merged.color === undefined && decoration.color !== undefined) {
              const color = colorIdOf(decoration.color);
              if (color) {
                merged.color = color;
                any = true;
              }
            }
            if (merged.propagate === undefined && decoration.propagate !== undefined) {
              merged.propagate = !!decoration.propagate;
              any = true;
            }
          } catch (error) {
            this.#host.log("error", `file decoration provider failed: ${error instanceof Error ? error.message : error}`, entry.extensionId);
          }
        }
        if (any) out.push({ path, decoration: merged });
      }),
    );
    return out;
  }
}

/** A theme color id ("gitDecoration.modifiedResourceForeground"), or a plain string. */
function colorIdOf(value: T.ThemeColor | string): string | undefined {
  if (typeof value === "string") return value;
  const id = (value as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : undefined;
}
