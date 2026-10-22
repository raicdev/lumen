import type { Envelope, MsgEnvelope, Namespace, ReqEnvelope, ResEnvelope, RpcApi, RpcHandlers, RPCSchema } from "./protocol.ts";

/**
 * Outbound transport.
 *
 * - The webview transport performs a native call and resolves with the inline
 *   response envelope (the native binding returns the answer directly).
 * - The main-process transport evaluates JS in the page and resolves with
 *   `undefined`; the response comes back later through `receive()`.
 */
export type Outbound = (envelope: Envelope) => Promise<ResEnvelope | null | undefined> | ResEnvelope | null | undefined;

export type RpcEndpointOptions = {
  /** Namespace this endpoint *handles*. */
  ns: Namespace;
  /** Namespace of envelopes this endpoint *sends*. */
  peerNs: Namespace;
  outbound: Outbound;
  handlers?: RpcHandlers;
  timeoutMs?: number;
  log?: (message: string) => void;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * A bidirectional RPC endpoint. Both processes instantiate one; the endpoint
 * only accepts envelopes addressed to its own namespace, so there is never any
 * ambiguity about who handles what.
 */
export class RpcEndpoint {
  readonly ns: Namespace;
  #peerNs: Namespace;
  #outbound: Outbound;
  #handlers: RpcHandlers;
  #pending = new Map<number, Pending>();
  #seq = 0;
  #timeoutMs: number;
  #log?: (message: string) => void;
  #closed = false;

  constructor(options: RpcEndpointOptions) {
    this.ns = options.ns;
    this.#peerNs = options.peerNs;
    this.#outbound = options.outbound;
    this.#handlers = options.handlers ?? {};
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.#log = options.log;
  }

  get closed() {
    return this.#closed;
  }

  /** Send a request and await the response. */
  request(channel: string, payload: unknown): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(new Error(`RPC endpoint is closed (request "${channel}")`));
    }

    const id = ++this.#seq;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`RPC request timed out: ${channel}`));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
    });

    const envelope: ReqEnvelope = { t: "req", id, ns: this.#peerNs, ch: channel, payload };

    void Promise.resolve(this.#outbound(envelope))
      .then((inline) => {
        if (inline) void this.receive(inline);
      })
      .catch((error: unknown) => this.#reject(id, error));

    return promise;
  }

  /** Fire-and-forget message. */
  post(channel: string, payload: unknown): void {
    if (this.#closed) return;
    const envelope: MsgEnvelope = { t: "msg", ns: this.#peerNs, ch: channel, payload };
    void Promise.resolve(this.#outbound(envelope)).catch(() => {});
  }

  /**
   * Handle an incoming envelope. Returns the response envelope when the inbound
   * envelope is a request (so a synchronous transport can return it inline).
   */
  async receive(raw: Envelope | string): Promise<ResEnvelope | null> {
    let envelope: Envelope;
    try {
      envelope = typeof raw === "string" ? (JSON.parse(raw) as Envelope) : raw;
    } catch {
      this.#log?.("dropped malformed RPC envelope");
      return null;
    }
    if (!envelope || typeof envelope !== "object") return null;

    if (envelope.t === "res") {
      this.#settle(envelope);
      return null;
    }

    if (envelope.ns !== this.ns) return null;

    if (envelope.t === "msg") {
      const handler = this.#handlers.messages?.[envelope.ch];
      if (!handler) return null;
      try {
        await handler(envelope.payload);
      } catch (error) {
        this.#log?.(`message handler "${envelope.ch}" failed: ${describe(error)}`);
      }
      return null;
    }

    const handler = this.#handlers.requests?.[envelope.ch];
    if (!handler) {
      return {
        t: "res",
        id: envelope.id,
        ok: false,
        error: `No handler registered for request "${envelope.ch}"`,
      };
    }

    try {
      const payload = await handler(envelope.payload);
      return { t: "res", id: envelope.id, ok: true, payload };
    } catch (error) {
      this.#log?.(`request handler "${envelope.ch}" failed: ${describe(error)}`);
      return { t: "res", id: envelope.id, ok: false, error: describe(error) };
    }
  }

  /** Register/replace handlers at runtime. */
  setHandlers(handlers: RpcHandlers): void {
    this.#handlers = handlers;
  }

  /** Reject every in-flight request; used when a window goes away. */
  close(reason = "RPC endpoint closed"): void {
    this.#closed = true;
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.#pending.delete(id);
    }
  }

  #settle(envelope: ResEnvelope): void {
    const pending = this.#pending.get(envelope.id);
    if (!pending) return;
    this.#pending.delete(envelope.id);
    clearTimeout(pending.timer);
    if (envelope.ok) pending.resolve(envelope.payload);
    else pending.reject(new Error(envelope.error ?? "RPC request failed"));
  }

  #reject(id: number, error: unknown): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    pending.reject(error instanceof Error ? error : new Error(describe(error)));
  }
}

export function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Build a typed caller facade around an endpoint. */
export function createApi<S extends RPCSchema, PeerNs extends Namespace>(endpoint: RpcEndpoint): RpcApi<S, PeerNs> {
  const request = new Proxy(
    {},
    {
      get: (_target, channel: string) => (params: unknown) => endpoint.request(channel, params ?? {}),
    },
  ) as RpcApi<S, PeerNs>["request"];

  const send = new Proxy(
    {},
    {
      get: (_target, channel: string) => (payload: unknown) => endpoint.post(channel, payload),
    },
  ) as RpcApi<S, PeerNs>["send"];

  return { request, send };
}

/** Narrow handler objects so the schema's params/response types are enforced. */
export function normalizeHandlers(handlers: RpcHandlers): RpcHandlers {
  return handlers;
}
