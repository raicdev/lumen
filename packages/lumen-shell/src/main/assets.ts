import { createReadStream, existsSync, statSync } from "fs";
import { createServer, type Server, type ServerResponse } from "http";
import type { AddressInfo } from "net";
import { dirname, join, normalize, resolve, extname, sep } from "path";

/**
 * Assets are served over a loopback HTTP server. That gives us a real origin
 * (required by WebView2 bindings, localStorage, and fetch) without shipping a
 * bundler or a custom protocol handler.
 */

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

type AssetServer = { port: number; url: string };

let server: Server | null = null;
let starting: Promise<AssetServer> | null = null;
let servedRoot = "";
let port = 0;

export function assetRoot(): string {
  if (servedRoot) return servedRoot;
  return process.env.LUMEN_ASSETS_DIR ?? join(dirname(process.execPath), "assets");
}

/**
 * A port derived from the app identifier. The page origin includes the port,
 * and localStorage / IndexedDB are per origin — a random port would give the
 * app empty storage on every launch.
 */
export function stablePort(identifier: string): number {
  let hash = 2166136261;
  for (let i = 0; i < identifier.length; i++) {
    hash ^= identifier.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return 20000 + ((hash >>> 0) % 30000);
}

function listen(target: Server, wanted: number): Promise<number> {
  return new Promise((onListening, onError) => {
    const fail = (error: NodeJS.ErrnoException) => {
      target.off("listening", ok);
      onError(error);
    };
    const ok = () => {
      target.off("error", fail);
      onListening((target.address() as AddressInfo).port);
    };
    target.once("error", fail);
    target.once("listening", ok);
    target.listen(wanted, "127.0.0.1");
  });
}

/**
 * Start (or reuse) the loopback server for `root`; resolves once it is
 * listening. `preferredPort` keeps the origin (and so web storage) stable
 * across launches; a busy port falls back to the next few, then any port.
 */
export function startAssetServer(root = assetRoot(), preferredPort = 0): Promise<AssetServer> {
  const absolute = resolve(root);
  if (server && starting && servedRoot === absolute) return starting;

  if (server) {
    server.closeAllConnections();
    server.close();
  }
  servedRoot = absolute;
  port = 0;

  const next = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    respond(response, url.pathname, absolute);
  });
  // The asset server must not keep the process alive on its own.
  next.unref();
  server = next;

  starting = (async () => {
    const candidates = preferredPort ? [0, 1, 2, 3, 4].map((offset) => preferredPort + offset) : [];
    for (const candidate of [...candidates, 0]) {
      try {
        port = await listen(next, candidate);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || candidate === 0) throw error;
      }
    }
    if (preferredPort && port !== preferredPort) {
      console.warn(`[lumen-shell] port ${preferredPort} is busy; serving on ${port} (web storage will not be shared)`);
    }
    return { port, url: `http://127.0.0.1:${port}` };
  })();
  return starting;
}

/** URL of a file in the assets directory (the server must be listening — see `app.run()`). */
export function assetUrl(relative: string): string {
  if (!server || !port) {
    throw new Error(
      'Lumen Shell: the asset server is not running yet — create windows from app.on("ready") ' +
        "or await startAssetServer() first",
    );
  }
  const clean = relative.replace(/^[/\\]+/, "") || "index.html";
  return `http://127.0.0.1:${port}/${clean}`;
}

function respond(response: ServerResponse, pathname: string, root: string): void {
  const decoded = safeDecode(pathname);
  const target = normalize(join(root, decoded));

  if (!target.startsWith(root + sep) && target !== root) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  const file = pickFile(target);
  if (!file) {
    response.writeHead(404).end("Not found");
    return;
  }

  const type = MIME_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
  response.writeHead(200, {
    "content-type": type,
    "cache-control": "no-store",
  });
  createReadStream(file)
    .on("error", () => response.destroy())
    .pipe(response);
}

function pickFile(target: string): string | null {
  if (existsSync(target) && statSync(target).isFile()) return target;
  const index = join(target, "index.html");
  if (existsSync(index) && statSync(index).isFile()) return index;
  return null;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
