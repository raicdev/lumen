import { createConnection, createServer, type Server } from "net";
import { tmpdir, userInfo } from "os";
import { join } from "path";

/**
 * lumen:// URIs for an already running Lumen. The OS starts a new process for
 * every URI it opens (the installer registers the scheme); like VS Code, that
 * process hands the URIs to the running instance over a local socket (a named
 * pipe on Windows) and exits. Plain launches still open a window of their own.
 */

/** The socket of one user's instances (per app identifier). */
export function instanceSocketPath(identifier: string, user = safeUser()): string {
  const name = `${identifier}-${user}`.replace(/[^\w.-]/g, "_");
  return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
}

function safeUser(): string {
  try {
    return userInfo().username;
  } catch {
    return "user";
  }
}

/** Send `uris` to a running instance. Resolves false when none is listening. */
export function forwardToRunningInstance(path: string, uris: string[], timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    const done = (forwarded: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(forwarded);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once("error", () => done(false));
    socket.once("connect", () => socket.end(`${JSON.stringify({ uris })}\n`, () => done(true)));
  });
}

/** Listen for URIs from later launches; `onUris` gets each launch's lumen:// URIs. */
export function serveInstance(path: string, onUris: (uris: string[]) => void): Promise<Server | null> {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      let data = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        data += chunk;
        // A launch sends one small JSON line; anything bigger is not ours.
        if (data.length > 64 * 1024) socket.destroy();
      });
      socket.on("end", () => {
        try {
          const message = JSON.parse(data) as { uris?: unknown };
          const uris = Array.isArray(message.uris) ? message.uris.filter((uri): uri is string => typeof uri === "string" && uri.startsWith("lumen://")) : [];
          if (uris.length) onUris(uris);
        } catch {
          /* not a launch message */
        }
      });
      socket.on("error", () => undefined);
    });
    server.once("error", () => resolve(null));
    server.listen(path, () => resolve(server));
  });
}
