import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * A small Model Context Protocol client: stdio (newline-delimited JSON-RPC) and
 * streamable HTTP servers, enough to list and call tools.
 */

export type McpToolInfo = { name: string; description?: string; inputSchema?: object };
export type McpToolResult = { content: { type: string; text?: string; data?: string; mimeType?: string; [key: string]: unknown }[]; isError?: boolean };

export type McpServerSpec =
  | { type: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd?: string }
  | { type: "http"; url: string; headers: Record<string, string> };

const PROTOCOL_VERSION = "2025-06-18";
const REQUEST_TIMEOUT_MS = 60_000;

type JsonRpcMessage = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } };

interface Transport {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): void;
}

/** Quote for cmd.exe: inside double quotes only `"` and `%` stay special and cannot be neutralised, so such values are refused. */
function quoteArg(value: string): string {
  if (/["%\r\n]/.test(value)) throw new Error(`MCP server argument not allowed on Windows: ${JSON.stringify(value)}`);
  return /^[\w@+=:,./\\-]+$/.test(value) ? value : `"${value}"`;
}

function stdioTransport(spec: Extract<McpServerSpec, { type: "stdio" }>, onClose: (reason: string) => void): Transport {
  const env = { ...process.env, ...spec.env };
  const options = { env, cwd: spec.cwd, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"], windowsHide: true };
  // `npx`, `uvx`, … are .cmd shims on Windows: they need a shell.
  const child: ChildProcessWithoutNullStreams =
    process.platform === "win32" && !/\.exe$/i.test(spec.command)
      ? spawn([spec.command, ...spec.args].map(quoteArg).join(" "), { ...options, shell: true })
      : spawn(spec.command, spec.args, options);
  const pending = new Map<number | string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  let nextId = 1;
  let buffer = "";
  let stderr = "";
  let closed = false;

  const failAll = (reason: string) => {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    pending.clear();
    onClose(reason);
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        continue;
      }
      if (message.id !== undefined && !message.method) {
        const entry = pending.get(message.id);
        if (!entry) continue;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(message.error.message));
        else entry.resolve(message.result);
      } else if (message.id !== undefined && message.method) {
        // Server-to-client requests (sampling, roots, …) are not supported.
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } })}\n`);
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-2000);
  });
  child.on("error", (error) => failAll(`could not start: ${error.message}`));
  child.on("exit", (code) => failAll(`exited with code ${code}${stderr.trim() ? `: ${stderr.trim().split("\n").pop()}` : ""}`));
  child.stdin.on("error", () => {});

  return {
    request(method, params) {
      if (closed) return Promise.reject(new Error("server is not running"));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    async notify(method, params) {
      if (!closed) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    close() {
      if (closed) return;
      closed = true;
      for (const entry of pending.values()) clearTimeout(entry.timer);
      pending.clear();
      child.stdin.end();
      setTimeout(() => child.kill(), 500).unref();
    },
  };
}

/** The JSON-RPC response with `id` in a `text/event-stream` body. */
function messageFromSse(body: string, id: number): JsonRpcMessage | undefined {
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      const message = JSON.parse(data) as JsonRpcMessage;
      if (message.id === id && !message.method) return message;
    } catch {
      /* not JSON */
    }
  }
  return undefined;
}

function httpTransport(spec: Extract<McpServerSpec, { type: "http" }>): Transport {
  let nextId = 1;
  let session: string | undefined;
  const post = async (body: unknown): Promise<Response> => {
    const response = await fetch(spec.url, {
      method: "POST",
      headers: {
        ...spec.headers,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": PROTOCOL_VERSION,
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    session = response.headers.get("mcp-session-id") ?? session;
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    return response;
  };
  return {
    async request(method, params) {
      const id = nextId++;
      const response = await post({ jsonrpc: "2.0", id, method, params });
      const text = await response.text();
      const message = (response.headers.get("content-type") ?? "").includes("text/event-stream")
        ? messageFromSse(text, id)
        : (JSON.parse(text) as JsonRpcMessage);
      if (!message) throw new Error(`no response to ${method}`);
      if (message.error) throw new Error(message.error.message);
      return message.result;
    },
    async notify(method, params) {
      await post({ jsonrpc: "2.0", method, params });
    },
    close() {
      if (session) void fetch(spec.url, { method: "DELETE", headers: { ...spec.headers, "mcp-session-id": session } }).catch(() => {});
    },
  };
}

export class McpClient {
  readonly spec: McpServerSpec;
  #transport: Transport | null = null;
  #onClose: (reason: string) => void;
  serverName = "";

  constructor(spec: McpServerSpec, onClose: (reason: string) => void = () => {}) {
    this.spec = spec;
    this.#onClose = onClose;
  }

  async start(): Promise<void> {
    const transport = this.spec.type === "stdio" ? stdioTransport(this.spec, this.#onClose) : httpTransport(this.spec);
    this.#transport = transport;
    try {
      const result = (await transport.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "lumen", version: "1" },
      })) as { serverInfo?: { name?: string } } | undefined;
      this.serverName = result?.serverInfo?.name ?? "";
      await transport.notify("notifications/initialized");
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  async listTools(): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = (await this.#transport!.request("tools/list", cursor ? { cursor } : {})) as { tools?: McpToolInfo[]; nextCursor?: string } | undefined;
      tools.push(...(page?.tools ?? []));
      cursor = page?.nextCursor;
    } while (cursor);
    return tools;
  }

  async callTool(name: string, args: unknown): Promise<McpToolResult> {
    const result = (await this.#transport!.request("tools/call", { name, arguments: args ?? {} })) as McpToolResult | undefined;
    return result ?? { content: [] };
  }

  stop(): void {
    const transport = this.#transport;
    this.#transport = null;
    transport?.close();
  }
}
