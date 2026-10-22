/**
 * Wire protocol shared by the main process and the webview.
 *
 * The same envelope format travels in both directions; only the
 * `ns` (namespace) field decides which side handles a request.
 */
export type Namespace = "main" | "webview";

export type ReqEnvelope = {
  t: "req";
  id: number;
  ns: Namespace;
  ch: string;
  payload: unknown;
};

export type ResEnvelope = {
  t: "res";
  id: number;
  ok: boolean;
  payload?: unknown;
  error?: string;
};

export type MsgEnvelope = {
  t: "msg";
  ns: Namespace;
  ch: string;
  payload: unknown;
};

export type Envelope = ReqEnvelope | ResEnvelope | MsgEnvelope;

export type RpcHandlers = {
  requests?: Record<string, (params: any) => unknown>;
  messages?: Record<string, (payload: any) => void>;
};

/** Structural shape of a typed RPC schema (see the app's `LumenRPC`). */
export type RPCSchema = {
  main: {
    requests: Record<string, { params: unknown; response: unknown }>;
    messages: Record<string, unknown>;
  };
  webview: {
    requests: Record<string, { params: unknown; response: unknown }>;
    messages: Record<string, unknown>;
  };
};

export type RequestsOf<S extends RPCSchema, NS extends Namespace> = S[NS]["requests"];
export type MessagesOf<S extends RPCSchema, NS extends Namespace> = S[NS]["messages"];

type ParamsOf<T> = T extends { params: infer P } ? P : never;
type ResponseOf<T> = T extends { response: infer R } ? R : never;

/** Caller side: `api().request.foo({...})` / `api().send.bar({...})`. */
export type RpcApi<S extends RPCSchema, NS extends Namespace> = {
  request: {
    [K in keyof RequestsOf<S, NS>]: (params: ParamsOf<RequestsOf<S, NS>[K]>) => Promise<ResponseOf<RequestsOf<S, NS>[K]>>;
  };
  send: {
    [K in keyof MessagesOf<S, NS>]: (payload: MessagesOf<S, NS>[K]) => void;
  };
};

/** Handler side: `{ requests: { foo: (params) => ... }, messages: { bar: (p) => ... } }`. */
export type RpcHandlersOf<S extends RPCSchema, NS extends Namespace> = {
  requests: {
    [K in keyof RequestsOf<S, NS>]: (params: ParamsOf<RequestsOf<S, NS>[K]>) => ResponseOf<RequestsOf<S, NS>[K]> | Promise<ResponseOf<RequestsOf<S, NS>[K]>>;
  };
  messages: {
    [K in keyof MessagesOf<S, NS>]: (payload: MessagesOf<S, NS>[K]) => void | Promise<void>;
  };
};
