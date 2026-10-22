import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import { randomBytes } from "crypto";
import { createReadStream, statSync } from "fs";
import { extname, resolve, sep } from "path";
import { documentFor, webviewLabel, webviewOrigin } from "../../shared/webview-document.ts";

/**
 * Serves webviews: their pages and the local files they load
 * (webview.asWebviewUri), on http://<label>.localhost:<port> — one origin per
 * extension, so webviews are isolated from the window and from each other's
 * extensions, yet have real storage (localStorage, IndexedDB, cookies) that
 * persists because the port is stable.
 *
 *   /<token>/<webviewId>/__page        the webview's document
 *   /<token>/<webviewId>/<file path>   a file below the webview's roots
 *
 * Nothing is served without this session's secret token, and files only
 * below the roots registered for that webview (localResourceRoots: by default
 * the extension's folder and the workspace).
 */

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
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
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

const isWindows = process.platform === "win32";
const normalize = (path: string) => (isWindows ? resolve(path).toLowerCase() : resolve(path));
export const PAGE = "__page";

/** A port derived from the app name (web storage is per origin, and the origin includes the port). */
function stablePort(identifier: string): number {
  let hash = 2166136261;
  for (let i = 0; i < identifier.length; i++) hash = Math.imul(hash ^ identifier.charCodeAt(i), 16777619);
  return 20000 + ((hash >>> 0) % 30000);
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((done, fail) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      fail(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      done(typeof address === "object" && address ? address.port : 0);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export class WebviewResourceServer {
  readonly token = randomBytes(18).toString("hex");
  readonly #identifier: string;
  #roots = new Map<string, string[]>();
  /** webview id → its document and the label of its extension's origin. */
  #pages = new Map<string, { label: string; html: string | null }>();
  #servers: Server[] = [];
  #port = 0;
  #starting: Promise<number> | null = null;

  constructor(identifier = "dev.lumen.editor") {
    this.#identifier = identifier;
  }

  get port(): number {
    return this.#port;
  }

  /** Start listening (on IPv4 and IPv6 loopback: *.localhost may resolve to either); resolves with the port. */
  start(): Promise<number> {
    this.#starting ??= (async () => {
      const preferred = stablePort(`${this.#identifier}.webviews`);
      const primary = createServer((request, response) => this.#handle(request, response));
      primary.unref();
      for (const candidate of [preferred, preferred + 1, preferred + 2, preferred + 3, 0]) {
        try {
          this.#port = await listen(primary, candidate, "127.0.0.1");
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || candidate === 0) throw error;
        }
      }
      this.#servers.push(primary);
      const secondary = createServer((request, response) => this.#handle(request, response));
      secondary.unref();
      try {
        await listen(secondary, this.#port, "::1");
        this.#servers.push(secondary);
      } catch {
        /* no IPv6 loopback: 127.0.0.1 is enough */
      }
      if (this.#port !== preferred) console.warn(`[extensions] webview port ${preferred} is busy; using ${this.#port} (webview storage will not be shared)`);
      return this.#port;
    })();
    return this.#starting;
  }

  /** The URL of a webview's page (its extension's origin). */
  pageUrl(webviewId: string, extensionId: string): string {
    this.#pages.set(webviewId, { label: webviewLabel(extensionId), html: this.#pages.get(webviewId)?.html ?? null });
    return `${webviewOrigin(extensionId, this.#port)}/${this.token}/${encodeURIComponent(webviewId)}/${PAGE}`;
  }

  setHtml(webviewId: string, html: string): void {
    const page = this.#pages.get(webviewId);
    if (page) page.html = documentFor(html);
  }

  setRoots(webviewId: string, roots: string[]): void {
    this.#roots.set(webviewId, roots.map(normalize));
  }

  forget(webviewId: string): void {
    this.#roots.delete(webviewId);
    this.#pages.delete(webviewId);
  }

  #handle(request: IncomingMessage, response: ServerResponse): void {
    const notFound = () => {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("Not found");
    };
    if (request.method !== "GET" && request.method !== "HEAD") return notFound();
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      return notFound();
    }
    const [, token, rawId, ...rest] = pathname.split("/");
    if (token !== this.token || !rawId || !rest.length) return notFound();
    let webviewId: string;
    try {
      webviewId = decodeURIComponent(rawId);
    } catch {
      return notFound();
    }

    if (rest.length === 1 && rest[0] === PAGE) {
      // A page only loads in its own extension's origin.
      const page = this.#pages.get(webviewId);
      const host = (request.headers.host ?? "").toLowerCase();
      if (!page || page.html === null || host !== `${page.label}.localhost:${this.#port}`) return notFound();
      const body = Buffer.from(page.html, "utf8");
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": body.length,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }

    const file = this.#file(webviewId, rest);
    let size = -1;
    try {
      const stats = file ? statSync(file) : null;
      if (stats?.isFile()) size = stats.size;
    } catch {
      /* missing */
    }
    if (!file || size < 0) return notFound();
    response.writeHead(200, {
      "Content-Type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": size,
      // Also loadable from other origins (e.g. a webview of the same extension elsewhere).
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(file).pipe(response);
  }

  /** A file inside the webview's roots, or null. */
  #file(webviewId: string, rest: string[]): string | null {
    const roots = this.#roots.get(webviewId);
    if (!roots?.length) return null;
    let relative: string;
    try {
      relative = rest.map((part) => decodeURIComponent(part)).join("/");
    } catch {
      return null;
    }
    const file = resolve(isWindows ? relative : `/${relative}`);
    const key = normalize(file);
    return roots.some((root) => key === root || key.startsWith(root.endsWith(sep) ? root : root + sep)) ? file : null;
  }
}
