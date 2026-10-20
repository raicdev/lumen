import { connect, createServer, type Server, type Socket } from "node:net";
import type { ExtensionHost } from "../host.ts";
import type { HostFeature } from "./contract.ts";
import { NOT_HANDLED } from "./contract.ts";
import * as T from "../types.ts";
import type { PortWire, PortsViewMessage } from "../../../shared/ports.ts";

/**
 * Host side of the "ports" area: forwarded ports. `workspace.openTunnel`
 * (proposed `tunnels` API), `workspace.tunnels`, `onDidChangeTunnels` and the
 * Ports panel's "Forward a Port". A port of this machine is shown as it is; a
 * port of another host (or another local port number) gets a real TCP
 * forwarder on a local port.
 */

const AREA = "ports";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

type TunnelOptions = { remoteAddress: { port: number; host: string }; localAddressPort?: number; label?: string; privacy?: string; protocol?: string };

type Entry = {
  id: number;
  remote: { host: string; port: number };
  local: { host: string; port: number };
  label?: string;
  protocol: string;
  privacy: string;
  /** "user" or the extension id. */
  source: string;
  server: Server | null;
  sockets: Set<Socket>;
  facade: Record<string, unknown>;
  onDidDispose: T.EventEmitter<void>;
  disposed: boolean;
};

type State = { entries: Map<number, Entry>; seq: number; onDidChange: T.EventEmitter<void> };

const states = new WeakMap<ExtensionHost, State>();

function stateOf(host: ExtensionHost): State {
  let state = states.get(host);
  if (!state) states.set(host, (state = { entries: new Map(), seq: 0, onDidChange: new T.EventEmitter<void>() }));
  return state;
}

export function portsSnapshot(host: ExtensionHost): PortWire[] {
  return [...stateOf(host).entries.values()].map((entry) => ({
    id: entry.id,
    remoteHost: entry.remote.host,
    remotePort: entry.remote.port,
    localAddress: `${entry.local.host}:${entry.local.port}`,
    localPort: entry.local.port,
    label: entry.label,
    protocol: entry.protocol,
    privacy: entry.privacy,
    source: entry.source,
  }));
}

function changed(host: ExtensionHost): void {
  stateOf(host).onDidChange.fire();
  host.postFeature(AREA, { kind: "ports", ports: portsSnapshot(host) });
}

/** Listen on `port` (0: any free port); resolves with the port used. */
function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolve((server.address() as { port: number }).port);
    });
  });
}

/** Forward a port (the proposed `workspace.openTunnel`). */
export async function openTunnel(host: ExtensionHost, options: TunnelOptions, source: string): Promise<Record<string, unknown>> {
  const remote = { host: String(options?.remoteAddress?.host ?? "localhost"), port: Number(options?.remoteAddress?.port) };
  if (!Number.isInteger(remote.port) || remote.port <= 0 || remote.port > 65535) throw new Error("openTunnel: remoteAddress.port must be a port number");
  const state = stateOf(host);
  const existing = [...state.entries.values()].find((entry) => entry.remote.host === remote.host && entry.remote.port === remote.port && !entry.disposed);
  if (existing) return existing.facade;

  const wanted = Number.isInteger(options.localAddressPort) ? options.localAddressPort! : remote.port;
  let server: Server | null = null;
  const sockets = new Set<Socket>();
  let local = { host: "localhost", port: remote.port };
  // A port of this machine reached on the same number needs no forwarder.
  if (!LOCAL_HOSTS.has(remote.host.toLowerCase()) || wanted !== remote.port) {
    server = createServer((client) => {
      const upstream = connect(remote.port, remote.host);
      sockets.add(client).add(upstream);
      const drop = () => {
        client.destroy();
        upstream.destroy();
        sockets.delete(client);
        sockets.delete(upstream);
      };
      client.on("error", drop).on("close", drop);
      upstream.on("error", drop).on("close", drop);
      client.pipe(upstream).pipe(client);
    });
    // The suggested local port is only a suggestion: take any free one when it is busy.
    const port = await listen(server, wanted).catch(() => listen(server!, 0));
    local = { host: "localhost", port };
  }

  const onDidDispose = new T.EventEmitter<void>();
  const entry: Entry = {
    id: ++state.seq,
    remote,
    local,
    label: typeof options.label === "string" ? options.label : undefined,
    protocol: options.protocol === "https" ? "https" : "http",
    privacy: typeof options.privacy === "string" ? options.privacy : options && (options as { public?: boolean }).public ? "public" : "private",
    source,
    server,
    sockets,
    facade: {},
    onDidDispose,
    disposed: false,
  };
  Object.defineProperties(entry.facade, {
    remoteAddress: { get: () => ({ ...entry.remote }), enumerable: true },
    localAddress: { get: () => `${entry.local.host}:${entry.local.port}`, enumerable: true },
    privacy: { get: () => entry.privacy, enumerable: true },
    public: { get: () => entry.privacy === "public", enumerable: true },
    protocol: { get: () => entry.protocol, enumerable: true },
    onDidDispose: { value: onDidDispose.event },
    dispose: { value: () => closeTunnel(host, entry.id) },
  });
  state.entries.set(entry.id, entry);
  changed(host);
  return entry.facade;
}

export async function closeTunnel(host: ExtensionHost, id: number): Promise<void> {
  const state = stateOf(host);
  const entry = state.entries.get(id);
  if (!entry || entry.disposed) return;
  entry.disposed = true;
  state.entries.delete(id);
  for (const socket of entry.sockets) socket.destroy();
  if (entry.server) await new Promise<void>((resolve) => entry.server!.close(() => resolve()));
  entry.onDidDispose.fire();
  changed(host);
}

/** "3000", "host:3000" or ":3000" typed in the Ports panel. */
export function parsePortInput(text: string): { host: string; port: number } | null {
  const match = /^\s*(?:(\[[^\]]+\]|[^:\s]+)?:)?(\d{1,5})\s*$/.exec(text);
  if (!match) return null;
  const port = Number(match[2]);
  if (port <= 0 || port > 65535) return null;
  return { host: (match[1] ?? "localhost").replace(/^\[|\]$/g, ""), port };
}

export const portsFeature: HostFeature = {
  area: AREA,

  api: ({ host, extensionId }) => ({
    workspace: {
      openTunnel: (options: TunnelOptions) => openTunnel(host, options, extensionId),
      get tunnels() {
        return Promise.resolve(
          portsSnapshot(host).map((port) => ({ remoteAddress: { host: port.remoteHost, port: port.remotePort }, localAddress: port.localAddress, privacy: port.privacy, protocol: port.protocol })),
        );
      },
      onDidChangeTunnels: stateOf(host).onDidChange.event,
    },
  }),

  commands: ["remote.tunnel.forwardInline", "remote.tunnel.closeInline"],

  executeCommand: async (host, command, args) => {
    if (command === "remote.tunnel.forwardInline") {
      const target = typeof args[0] === "number" ? { host: "localhost", port: args[0] } : parsePortInput(String(args[0] ?? ""));
      if (!target) throw new Error("remote.tunnel.forwardInline: a port is required");
      await openTunnel(host, { remoteAddress: target }, "user");
      return undefined;
    }
    if (command === "remote.tunnel.closeInline") {
      const port = Number((args[0] as { remotePort?: number } | undefined)?.remotePort ?? args[0]);
      const entry = [...stateOf(host).entries.values()].find((candidate) => candidate.remote.port === port);
      if (entry) await closeTunnel(host, entry.id);
      return undefined;
    }
    return NOT_HANDLED;
  },

  onViewMessage: (host, payload) => {
    const message = payload as PortsViewMessage;
    if (message.kind === "ready") host.postFeature(AREA, { kind: "ports", ports: portsSnapshot(host) });
    else if (message.kind === "close") void closeTunnel(host, message.id);
  },

  onViewRequest: async (host, method, args) => {
    if (method === "forward") {
      const target = parsePortInput(String(args[0] ?? ""));
      if (!target) throw new Error(`"${String(args[0])}" is not a port or host:port`);
      await openTunnel(host, { remoteAddress: target, label: typeof args[1] === "string" && args[1] ? args[1] : undefined }, "user");
      return portsSnapshot(host);
    }
    if (method === "snapshot") return portsSnapshot(host);
    throw new Error(`ports: unknown request '${method}'`);
  },
};
