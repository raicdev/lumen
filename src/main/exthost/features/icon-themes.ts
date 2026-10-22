import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, dirname } from "node:path";
import { parseJsonc } from "../../../shared/jsonc.ts";
import { ICON_MIME_TYPES, normalizeFileIconTheme, normalizeProductIconTheme } from "../../../shared/icon-themes.ts";
import type { ExtensionHost } from "../host.ts";
import type { HostFeature } from "./contract.ts";

/**
 * Host side of the "icon-themes" area: reads the file / product icon theme
 * files extensions contribute (contributes.iconThemes, productIconThemes) and
 * the images and fonts they reference, so the window needs no file access to
 * extension folders. The window keeps the selection and does the lookups.
 */

const MAX_ASSET_BYTES = 4 * 1024 * 1024;

function insideFolder(folder: string, file: string): boolean {
  const path = relative(resolve(folder), resolve(file));
  return !path.startsWith("..") && !isAbsolute(path);
}

/** Folder an asset may be read from, by theme key: the folder of the extension that contributed the theme. */
const roots = new Map<string, string>();

/** Real path of a file, or of its closest existing parent (so symlinks cannot leave the root). */
async function real(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

async function load(host: ExtensionHost, kind: unknown, extensionId: unknown, path: unknown): Promise<{ key: string; theme: unknown }> {
  if ((kind !== "file" && kind !== "product") || typeof extensionId !== "string" || typeof path !== "string") throw new Error("bad icon theme request");
  // The folder comes from the host's own extension list, never from the window.
  const runtime = host.runtimes.get(extensionId.toLowerCase());
  if (!runtime) throw new Error(`unknown extension ${extensionId}`);
  const location = await real(runtime.description.location);
  const file = await real(path);
  if (!insideFolder(location, file)) throw new Error(`${path} is outside the extension`);
  const raw = parseJsonc(await readFile(file, "utf8"));
  const base = dirname(file);
  const resolvePath = (relativePath: string) => {
    const target = resolve(base, relativePath);
    return insideFolder(location, target) ? target : undefined;
  };
  const key = `${kind}:${file}`;
  roots.set(key, location);
  return { key, theme: kind === "file" ? normalizeFileIconTheme(raw, resolvePath) : normalizeProductIconTheme(raw, resolvePath) };
}

/** Images and fonts of a theme as data: URIs (`null` for files that cannot be read). */
async function assets(key: unknown, paths: unknown): Promise<Record<string, string | null>> {
  const root = typeof key === "string" ? roots.get(key) : undefined;
  const result: Record<string, string | null> = {};
  if (!root || !Array.isArray(paths)) return result;
  await Promise.all(
    paths.map(async (path) => {
      if (typeof path !== "string") return;
      result[path] = null;
      const mime = ICON_MIME_TYPES[extname(path).toLowerCase()];
      if (!mime) return;
      try {
        const file = await real(path);
        if (!insideFolder(root, file)) return;
        if ((await stat(file)).size > MAX_ASSET_BYTES) return;
        result[path] = `data:${mime};base64,${(await readFile(file)).toString("base64")}`;
      } catch {
        /* missing file: no icon */
      }
    }),
  );
  return result;
}

/** The font of a contributes.icons entry as a data: URI (`null` when it cannot be read). */
async function iconFont(host: ExtensionHost, extensionId: unknown, path: unknown): Promise<string | null> {
  if (typeof extensionId !== "string" || typeof path !== "string") return null;
  const runtime = host.runtimes.get(extensionId.toLowerCase());
  const mime = ICON_MIME_TYPES[extname(path).toLowerCase()];
  if (!runtime || !mime?.startsWith("font/")) return null;
  try {
    const file = await real(path);
    if (!insideFolder(await real(runtime.description.location), file)) return null;
    if ((await stat(file)).size > MAX_ASSET_BYTES) return null;
    return `data:${mime};base64,${(await readFile(file)).toString("base64")}`;
  } catch {
    return null;
  }
}

export const iconThemesFeature: HostFeature = {
  area: "icon-themes",
  onViewRequest: async (host, method, args) => {
    if (method === "load") return await load(host, args[0], args[1], args[2]);
    if (method === "assets") return await assets(args[0], args[1]);
    if (method === "iconFont") return await iconFont(host, args[0], args[1]);
    throw new Error(`unknown icon theme request: ${method}`);
  },
};
