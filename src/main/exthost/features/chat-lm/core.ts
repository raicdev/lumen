import { readFileSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import type { ExtensionHost, ExtensionRuntime } from "../../host.ts";
import { CancellationError, CancellationTokenSource, Disposable, EventEmitter, Location, MarkdownString, ThemeIcon, Uri } from "../../types.ts";
import type { CancellationToken } from "../../types.ts";
import { markdownOf } from "../../wire.ts";
import type {
  ChatHostMessage,
  ChatSendArgs,
  ChatWireFollowup,
  ChatWireMcpServer,
  ChatWireModel,
  ChatWireParticipant,
  ChatWirePart,
  ChatWireState,
  ChatWireTreeNode,
} from "../../../../shared/chat-lm.ts";
import { McpClient } from "./mcp.ts";
import type { McpServerSpec, McpToolInfo, McpToolResult } from "./mcp.ts";
import type { ChatParticipantIcon } from "./types.ts";
import {
  ChatRequestTurn,
  ChatResponseAnchorPart,
  ChatResponseCommandButtonPart,
  ChatResponseFileTreePart,
  ChatResponseMarkdownPart,
  ChatResponseProgressPart,
  ChatResponseReferencePart,
  ChatResponseTurn,
  ChatResponseWarningPart,
  LanguageModelChatMessage,
  LanguageModelDataPart,
  LanguageModelError,
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  LanguageModelToolResult,
  LanguageModelToolResultPart,
  messageParts,
  textOf,
} from "./types.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Loose = any;

const AREA = "chat-lm";
const MAX_TOOL_ROUNDS = 8;
const MAX_ATTACHMENT_BYTES = 100_000;

/* ── helpers ───────────────────────────────────────────────────────────── */

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** An async iterable that several consumers can iterate (each from the start) while a producer pushes. */
class ReplayStream<T> {
  #items: T[] = [];
  #done = false;
  #error: unknown = undefined;
  #failed = false;
  #waiters: (() => void)[] = [];

  #wake() {
    for (const waiter of this.#waiters.splice(0)) waiter();
  }
  push(item: T): void {
    if (this.#done) return;
    this.#items.push(item);
    this.#wake();
  }
  end(): void {
    this.#done = true;
    this.#wake();
  }
  fail(error: unknown): void {
    this.#failed = true;
    this.#error = error;
    this.#done = true;
    this.#wake();
  }
  iterable(): AsyncIterable<T> {
    return {
      [Symbol.asyncIterator]: () => {
        let index = 0;
        return {
          next: async (): Promise<IteratorResult<T>> => {
            for (;;) {
              if (index < this.#items.length) return { value: this.#items[index++]!, done: false };
              if (this.#done) {
                if (this.#failed && index >= this.#items.length) throw this.#error;
                return { value: undefined, done: true };
              }
              await new Promise<void>((resolveWaiter) => this.#waiters.push(resolveWaiter));
            }
          },
        };
      },
    };
  }
}

function toMessage(value: Loose): LanguageModelChatMessage {
  if (value instanceof LanguageModelChatMessage) return value;
  return new LanguageModelChatMessage(value?.role === 2 ? 2 : 1, value?.content ?? "", value?.name);
}

/** What a provider reports into the progress callback, as a part object. */
function toResponsePart(value: Loose): unknown {
  if (typeof value === "string") return new LanguageModelTextPart(value);
  return value;
}

function uriPath(uri: Uri): string {
  return uri.scheme === "file" ? uri.fsPath : uri.toString();
}

function wireLocation(value: Loose): { path?: string; external?: string; line?: number } {
  if (typeof value === "string") return { external: value };
  if (value instanceof Location) return { ...wireLocation(value.uri), line: value.range.start.line };
  if (Uri.isUri(value)) return value.scheme === "file" ? { path: value.fsPath } : { external: value.toString() };
  if (value?.uri) return { ...wireLocation(value.uri), line: value.range?.start?.line };
  return {};
}

function wireTree(nodes: Loose[]): ChatWireTreeNode[] {
  return (Array.isArray(nodes) ? nodes : []).map((node) => ({
    name: String(node?.name ?? ""),
    children: node?.children ? wireTree(node.children) : undefined,
  }));
}

const ICON_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

/** Icon files as data URLs (cached; small images only, like the tree views' icons). */
const iconUrls = new Map<string, string | undefined>();

function imageUrl(path: string): string | undefined {
  if (iconUrls.has(path)) return iconUrls.get(path);
  let url: string | undefined;
  const type = ICON_TYPES[extname(path).toLowerCase()];
  try {
    if (type && statSync(path).size <= 256 * 1024) url = `data:${type};base64,${readFileSync(path).toString("base64")}`;
  } catch {
    /* missing icon */
  }
  iconUrls.set(path, url);
  return url;
}

/** A Uri (or a path) an extension gave as an icon, as a URL the panel can show. */
function iconUrl(value: Loose): string | undefined {
  const uri = typeof value === "string" ? Uri.file(value) : Uri.isUri(value) ? value : undefined;
  if (!uri) return undefined;
  if (uri.scheme === "http" || uri.scheme === "https" || uri.scheme === "data") return uri.toString(true);
  return uri.scheme === "file" ? imageUrl(uri.fsPath) : undefined;
}

/** A participant's `iconPath` (Uri, ThemeIcon or `{ light, dark }`) as the panel draws it. */
export function wireParticipantIcon(iconPath: Loose): ChatParticipantIcon | undefined {
  if (!iconPath) return undefined;
  if (iconPath instanceof ThemeIcon || (typeof iconPath === "object" && !Uri.isUri(iconPath) && typeof iconPath.id === "string")) {
    const color = typeof iconPath.color?.id === "string" ? iconPath.color.id : undefined;
    return color ? { codicon: String(iconPath.id), color } : { codicon: String(iconPath.id) };
  }
  if (typeof iconPath === "object" && !Uri.isUri(iconPath) && ("light" in iconPath || "dark" in iconPath)) {
    const light = iconUrl(iconPath.light);
    const dark = iconUrl(iconPath.dark) ?? light;
    if (!light && !dark) return undefined;
    return { url: (light ?? dark)!, dark };
  }
  const url = iconUrl(iconPath);
  return url ? { url } : undefined;
}

/** An extension's contributions of one point (contributes.<point>), with the extension that made them. */
function contributions(host: ExtensionHost, point: string): { runtime: ExtensionRuntime; item: Loose }[] {
  const out: { runtime: ExtensionRuntime; item: Loose }[] = [];
  for (const runtime of host.runtimes.values()) {
    const list = (runtime.description.manifest.contributes as Loose)?.[point];
    if (Array.isArray(list)) for (const item of list) if (item && typeof item === "object") out.push({ runtime, item });
  }
  return out;
}

/* ── registrations ─────────────────────────────────────────────────────── */

type ParticipantReg = { id: string; extensionId: string; participant: Loose; feedback: EventEmitter<unknown> };
/** `ChatWireParticipant` plus the icon the extension set on the participant. */
type WireParticipant = ChatWireParticipant & { icon?: ChatParticipantIcon };
type ModelInfo = Loose;
type ProviderReg = {
  vendor: string;
  extensionId: string;
  provider: Loose;
  infos: ModelInfo[] | null;
  loading: Promise<void> | null;
  subscription: { dispose(): unknown } | null;
};
type ToolReg = { name: string; extensionId: string; tool: Loose };
type McpServer = {
  id: string;
  label: string;
  extensionId: string;
  status: ChatWireMcpServer["status"];
  error?: string;
  client: McpClient | null;
  tools: McpToolInfo[];
  names: Map<string, string>;
};
type McpProviderReg = {
  id: string;
  extensionId: string;
  provider: Loose;
  servers: Map<string, McpServer>;
  subscription: { dispose(): unknown } | null;
  refreshing: Promise<void> | null;
};
type RequestRecord = { cts: CancellationTokenSource; participantId?: string; result?: unknown };

export type LanguageModelChatLike = {
  id: string;
  name: string;
  vendor: string;
  family: string;
  version: string;
  maxInputTokens: number;
  capabilities: { imageInput: boolean; toolCalling: boolean | number };
  sendRequest(messages: unknown[], options?: Loose, token?: CancellationToken): Promise<{ stream: AsyncIterable<unknown>; text: AsyncIterable<string> }>;
  countTokens(text: string | LanguageModelChatMessage, token?: CancellationToken): Promise<number>;
};

/** A registered model as the "Manage Language Models" view lists it. Mirrored by the window side. */
export type LanguageModelEntry = {
  /** `vendor/id`, as in the Chat panel's model picker. */
  id: string;
  name: string;
  vendor: string;
  family: string;
  version: string;
  /** The extension that registered the provider. */
  extensionId: string;
  /** Its display name, when the extension is loaded. */
  extensionName?: string;
};

/** Chat participants, language model providers, tools and MCP servers of one extension host. */
export class ChatLmState {
  readonly host: ExtensionHost;
  readonly participants = new Map<string, ParticipantReg>();
  readonly providers = new Map<string, ProviderReg>();
  readonly tools = new Map<string, ToolReg>();
  readonly mcpProviders = new Map<string, McpProviderReg>();
  readonly modelsChanged = new EventEmitter<void>();
  readonly #requests = new Map<number, RequestRecord>();
  /** Turns of the participants' conversation (for `ChatContext.history`). */
  #turns: (ChatRequestTurn | ChatResponseTurn)[] = [];
  /** Messages of the conversation with a model without a participant. */
  #direct: LanguageModelChatMessage[] = [];
  /** The model the panel picked (`ChatSendArgs.modelId`); tool token counting uses it. */
  #currentModelId: string | undefined;
  #lastParticipant: string | undefined;
  #stateScheduled = false;
  /** MCP servers the user allowed to start in this session. */
  readonly #trusted = new Set<string>();
  /** Answers to "may this extension use that extension's models?" for this session, per (consumer, provider) pair. */
  readonly #modelAccess = new Map<string, boolean>();
  /** Asks the user (replaced in tests). Resolves with the index of the chosen action, `null` when dismissed. */
  confirm: (title: string, message: string, actions: string[]) => Promise<number | null>;
  /** Asks whether an extension may use another extension's models (replaced in tests). */
  modelConsent: (extensionId: string, providerExtensionId: string, vendor: string, justification?: string) => Promise<boolean>;

  constructor(host: ExtensionHost) {
    this.host = host;
    this.confirm = async (title, message, actions) => {
      try {
        return (await host.requestFeatureView(AREA, "confirm", [title, message, actions])) as number | null;
      } catch {
        return null;
      }
    };
    this.modelConsent = async (extensionId, providerExtensionId, vendor, justification) => {
      try {
        return (await host.requestFeatureView(AREA, "modelConsent", [extensionId, providerExtensionId, vendor, justification])) === true;
      } catch {
        return false;
      }
    };
  }

  /* ── plumbing ─────────────────────────────────────────────────────────── */

  send(message: ChatHostMessage): void {
    this.host.postFeature(AREA, message);
  }

  /** Tell the panel what changed (coalesced). */
  changed(): void {
    if (this.#stateScheduled) return;
    this.#stateScheduled = true;
    queueMicrotask(() => {
      this.#stateScheduled = false;
      this.send({ kind: "state", state: this.wireState() });
    });
  }

  /* ── participants ─────────────────────────────────────────────────────── */

  registerParticipant(extensionId: string, id: string, handler: Loose): Loose {
    if (typeof handler !== "function") throw new Error("a chat participant needs a request handler");
    if (this.participants.has(id)) throw new Error(`Chat participant with id '${id}' is already registered`);
    const feedback = new EventEmitter<unknown>();
    const participant: Loose = {
      id,
      iconPath: undefined,
      requestHandler: handler,
      followupProvider: undefined,
      onDidReceiveFeedback: feedback.event,
      dispose: () => {
        if (this.participants.get(id)?.participant === participant) this.participants.delete(id);
        feedback.dispose();
        this.changed();
      },
    };
    this.participants.set(id, { id, extensionId, participant, feedback });
    this.changed();
    return participant;
  }

  listParticipants(): WireParticipant[] {
    const out = new Map<string, WireParticipant>();
    for (const { runtime, item } of contributions(this.host, "chatParticipants")) {
      if (typeof item.id !== "string") continue;
      out.set(item.id, {
        id: item.id,
        name: String(item.name ?? item.id.split(".").pop()),
        fullName: String(item.fullName ?? item.name ?? item.id),
        description: String(item.description ?? ""),
        extensionId: runtime.id,
        isDefault: !!item.isDefault,
        commands: (Array.isArray(item.commands) ? item.commands : [])
          .filter((c: Loose) => c && typeof c.name === "string")
          .map((c: Loose) => ({ name: c.name, description: String(c.description ?? "") })),
      });
    }
    for (const reg of this.participants.values()) {
      const icon = wireParticipantIcon(reg.participant.iconPath);
      const existing = out.get(reg.id);
      if (existing) {
        // `iconPath` can be set after createChatParticipant returned.
        if (icon) existing.icon = icon;
        continue;
      }
      const name = reg.id.split(".").pop() ?? reg.id;
      out.set(reg.id, { id: reg.id, name, fullName: name, description: "", extensionId: reg.extensionId, isDefault: false, commands: [], icon });
    }
    return [...out.values()];
  }

  /** Make sure the extension that contributes a participant is running and has registered its handler. */
  async #ensureParticipant(info: ChatWireParticipant): Promise<ParticipantReg | undefined> {
    if (!this.participants.has(info.id)) {
      await this.host.activateByEvent(`onChatParticipant:${info.id}`);
      const runtime = this.host.runtimes.get(info.extensionId.toLowerCase()) ?? this.host.runtimes.get(info.extensionId);
      if (runtime && !this.participants.has(info.id)) await this.host.activate(runtime, `onChatParticipant:${info.id}`);
    }
    return this.participants.get(info.id);
  }

  /* ── language models ──────────────────────────────────────────────────── */

  registerProvider(extensionId: string, vendor: string, provider: Loose): Disposable {
    if (this.providers.has(vendor)) throw new Error(`Chat model provider for vendor '${vendor}' is already registered`);
    if (!provider || typeof provider.provideLanguageModelChatInformation !== "function" || typeof provider.provideLanguageModelChatResponse !== "function") {
      throw new Error("a language model chat provider needs provideLanguageModelChatInformation and provideLanguageModelChatResponse");
    }
    const reg: ProviderReg = { vendor, extensionId, provider, infos: null, loading: null, subscription: null };
    this.providers.set(vendor, reg);
    reg.subscription =
      typeof provider.onDidChangeLanguageModelChatInformation === "function"
        ? provider.onDidChangeLanguageModelChatInformation(() => void this.#reload(reg))
        : null;
    void this.#load(reg);
    return new Disposable(() => {
      if (this.providers.get(vendor) === reg) this.providers.delete(vendor);
      reg.subscription?.dispose();
      this.modelsChanged.fire();
      this.changed();
    });
  }

  #load(reg: ProviderReg): Promise<void> {
    reg.loading ??= this.#reload(reg);
    return reg.loading;
  }

  async #reload(reg: ProviderReg): Promise<void> {
    try {
      const infos = await reg.provider.provideLanguageModelChatInformation({ silent: true }, new CancellationTokenSource().token);
      reg.infos = Array.isArray(infos) ? infos.filter((info: Loose) => info && typeof info.id === "string") : [];
    } catch (error) {
      reg.infos = [];
      this.host.log("warning", `language model provider '${reg.vendor}' failed to list models: ${errorMessage(error)}`, reg.extensionId);
    }
    this.modelsChanged.fire();
    this.changed();
  }

  /** Start the extensions that declare a model provider (contributes.languageModelChatProviders) for `vendor` (any when omitted). */
  async activateProviders(vendor?: string): Promise<void> {
    const wanted = contributions(this.host, "languageModelChatProviders").filter(
      ({ item }) => typeof item.vendor === "string" && (!vendor || item.vendor === vendor),
    );
    await Promise.all(
      wanted.map(async ({ runtime, item }) => {
        if (this.providers.has(item.vendor)) return;
        await this.host.activateByEvent(`onLanguageModelChatProvider:${item.vendor}`);
        await this.host.activate(runtime, `onLanguageModelChatProvider:${item.vendor}`).catch(() => {});
      }),
    );
  }

  async selectChatModels(selector?: Loose, consumer?: string): Promise<LanguageModelChatLike[]> {
    await this.activateProviders(selector?.vendor);
    const regs = [...this.providers.values()].filter((reg) => !selector?.vendor || reg.vendor === selector.vendor);
    await Promise.all(regs.map((reg) => this.#load(reg)));
    // `justification` is not part of VS Code's selector; extensions sometimes pass it anyway and it is worth showing.
    const justification = typeof selector?.justification === "string" ? selector.justification : undefined;
    const out: LanguageModelChatLike[] = [];
    for (const reg of regs) {
      for (const info of reg.infos ?? []) {
        if (selector?.id !== undefined && info.id !== selector.id) continue;
        if (selector?.family !== undefined && info.family !== selector.family) continue;
        if (selector?.version !== undefined && info.version !== selector.version) continue;
        out.push(this.#modelObject(reg, info, consumer, justification));
      }
    }
    return out;
  }

  #modelObject(reg: ProviderReg, info: ModelInfo, consumer?: string, justification?: string): LanguageModelChatLike {
    const model: LanguageModelChatLike = {
      id: info.id,
      name: String(info.name ?? info.id),
      vendor: reg.vendor,
      family: String(info.family ?? ""),
      version: String(info.version ?? ""),
      maxInputTokens: Number(info.maxInputTokens ?? 0),
      capabilities: { imageInput: !!info.capabilities?.imageInput, toolCalling: info.capabilities?.toolCalling ?? false },
      sendRequest: (messages, options, token) => this.#sendRequest(reg, info, messages, options, token, consumer, justification),
      countTokens: (text, token) => this.#countTokens(reg, info, text, token),
    };
    return Object.freeze(model);
  }

  /**
   * Like VS Code, an extension needs the user's consent the first time it sends a request through a model
   * another extension provides. The answer is remembered for the session (the window persists it).
   */
  async #requireModelConsent(reg: ProviderReg, consumer: string, justification?: string): Promise<void> {
    const key = `${consumer}\u0000${reg.extensionId}`;
    let allowed = this.#modelAccess.get(key);
    if (allowed === undefined) {
      allowed = await this.modelConsent(consumer, reg.extensionId, reg.vendor, justification);
      this.#modelAccess.set(key, allowed);
    }
    if (!allowed) throw LanguageModelError.NoPermissions(`The user did not allow ${consumer} to use the language models provided by ${reg.extensionId}.`);
  }

  async #sendRequest(
    reg: ProviderReg,
    info: ModelInfo,
    messages: unknown[],
    options: Loose = {},
    token?: CancellationToken,
    consumer?: string,
    justification?: string,
  ) {
    if (this.providers.get(reg.vendor) !== reg) throw LanguageModelError.NotFound(`Language model '${info.id}' is no longer available`);
    if (consumer && consumer !== reg.extensionId)
      await this.#requireModelConsent(reg, consumer, typeof options?.justification === "string" ? options.justification : justification);
    const queue = new ReplayStream<unknown>();
    const cts = new CancellationTokenSource();
    token?.onCancellationRequested(() => cts.cancel());
    const progress = { report: (part: unknown) => queue.push(toResponsePart(part)) };
    const request = {
      tools: options.tools ? [...options.tools] : undefined,
      toolMode: options.toolMode ?? 1,
      modelOptions: options.modelOptions ?? {},
      requestInitiator: reg.extensionId,
    };
    Promise.resolve()
      .then(() => reg.provider.provideLanguageModelChatResponse(info, (messages ?? []).map(toMessage), request, progress, cts.token))
      .then(
        () => queue.end(),
        (error) => queue.fail(error instanceof LanguageModelError ? error : new LanguageModelError(errorMessage(error), "Unknown", error)),
      );
    const stream = queue.iterable();
    const text: AsyncIterable<string> = {
      async *[Symbol.asyncIterator]() {
        for await (const part of stream) if (part instanceof LanguageModelTextPart) yield part.value;
      },
    };
    return { stream, text };
  }

  async #countTokens(reg: ProviderReg, info: ModelInfo, input: string | LanguageModelChatMessage, token?: CancellationToken): Promise<number> {
    const value = typeof input === "string" ? input : toMessage(input);
    if (typeof reg.provider.provideTokenCount === "function")
      return Number(await reg.provider.provideTokenCount(info, value, token ?? new CancellationTokenSource().token));
    const text = typeof value === "string" ? value : textOf(value.content);
    return Math.ceil(text.length / 4);
  }

  wireModels(): ChatWireModel[] {
    const out: ChatWireModel[] = [];
    for (const reg of this.providers.values()) {
      for (const info of reg.infos ?? []) {
        out.push({
          id: `${reg.vendor}/${info.id}`,
          name: String(info.name ?? info.id),
          vendor: reg.vendor,
          family: String(info.family ?? ""),
          version: String(info.version ?? ""),
          detail: typeof info.detail === "string" ? info.detail : undefined,
        });
      }
    }
    return out;
  }

  /** Every registered model with the extension providing it (the "Manage Language Models" view). */
  languageModels(): LanguageModelEntry[] {
    const out: LanguageModelEntry[] = [];
    for (const reg of this.providers.values()) {
      const runtime =
        this.host.runtimes.get(reg.extensionId) ??
        [...this.host.runtimes.values()].find((candidate) => candidate.id.toLowerCase() === reg.extensionId.toLowerCase());
      const manifest = runtime?.description.manifest;
      const extensionName = manifest ? String(manifest.displayName ?? manifest.name ?? "") || undefined : undefined;
      for (const info of reg.infos ?? []) {
        out.push({
          id: `${reg.vendor}/${info.id}`,
          name: String(info.name ?? info.id),
          vendor: reg.vendor,
          family: String(info.family ?? ""),
          version: String(info.version ?? ""),
          extensionId: reg.extensionId,
          extensionName,
        });
      }
    }
    return out;
  }

  async #resolveModel(modelId?: string): Promise<LanguageModelChatLike | undefined> {
    const all = await this.selectChatModels();
    if (modelId) {
      const found = all.find((model) => `${model.vendor}/${model.id}` === modelId);
      if (found) return found;
    }
    return all[0];
  }

  /* ── tools ────────────────────────────────────────────────────────────── */

  registerTool(extensionId: string, name: string, tool: Loose): Disposable {
    if (this.tools.has(name)) throw new Error(`Tool '${name}' is already registered`);
    if (!tool || typeof tool.invoke !== "function") throw new Error("a language model tool needs an invoke function");
    const reg: ToolReg = { name, extensionId, tool };
    this.tools.set(name, reg);
    this.changed();
    return new Disposable(() => {
      if (this.tools.get(name) === reg) this.tools.delete(name);
      this.changed();
    });
  }

  toolInformation(): Loose[] {
    const out = new Map<string, Loose>();
    for (const { item } of contributions(this.host, "languageModelTools")) {
      if (typeof item.name !== "string") continue;
      out.set(item.name, {
        name: item.name,
        description: String(item.modelDescription ?? item.userDescription ?? item.displayName ?? ""),
        inputSchema: item.inputSchema,
        tags: Array.isArray(item.tags) ? [...item.tags] : [],
      });
    }
    for (const reg of this.tools.values()) {
      if (!out.has(reg.name))
        out.set(reg.name, { name: reg.name, description: String(reg.tool.description ?? ""), inputSchema: reg.tool.inputSchema, tags: [] });
    }
    for (const server of this.#mcpServers()) {
      for (const tool of server.tools) {
        const name = server.names.get(tool.name)!;
        out.set(name, { name, description: tool.description ?? "", inputSchema: tool.inputSchema, tags: ["mcp", server.label] });
      }
    }
    return [...out.values()].map((info) => Object.freeze(info));
  }

  async invokeTool(name: string, options: Loose = {}, token?: CancellationToken): Promise<LanguageModelToolResult> {
    const mcp = this.#findMcpTool(name);
    if (mcp) return this.#invokeMcp(mcp.server, mcp.tool, options.input);
    if (!this.tools.has(name)) {
      await this.host.activateByEvent(`onLanguageModelTool:${name}`);
      const contributor = contributions(this.host, "languageModelTools").find(({ item }) => item.name === name);
      if (contributor && !this.tools.has(name)) await this.host.activate(contributor.runtime, `onLanguageModelTool:${name}`).catch(() => {});
    }
    const reg = this.tools.get(name);
    if (!reg) throw new Error(`Tool '${name}' not found`);
    const cancel = token ?? new CancellationTokenSource().token;
    const input = options.input ?? {};
    // Called from the chat view (it hands out the invocation token): the user confirms first.
    if (options.toolInvocationToken && typeof reg.tool.prepareInvocation === "function") {
      const prepared = await reg.tool.prepareInvocation({ input, toolInvocationToken: options.toolInvocationToken }, cancel);
      const confirmation = prepared?.confirmationMessages;
      if (confirmation) {
        const answer = await this.confirm(markdownOf(confirmation.title) || `Run ${name}?`, markdownOf(confirmation.message), ["Allow", "Cancel"]);
        if (answer !== 0) throw new CancellationError();
      }
    }
    const tokenizationOptions = options.tokenizationOptions ? await this.#tokenizationOptions(options.tokenizationOptions, cancel) : undefined;
    const result = await reg.tool.invoke({ input, toolInvocationToken: options.toolInvocationToken, tokenizationOptions }, cancel);
    if (result instanceof LanguageModelToolResult) return result;
    if (Array.isArray(result?.content)) return new LanguageModelToolResult(result.content);
    if (Array.isArray(result)) return new LanguageModelToolResult(result);
    return new LanguageModelToolResult([]);
  }

  /** `LanguageModelToolTokenizationOptions` of a tool call (VS Code hands these to `invoke`). */
  async #tokenizationOptions(given: Loose, token: CancellationToken): Promise<Loose> {
    const model = await this.#resolveModel(this.#currentModelId).catch(() => undefined);
    const countTokens =
      typeof given?.countTokens === "function"
        ? given.countTokens
        : async (text: unknown): Promise<number> => {
            const value = typeof text === "string" ? text : textOf((text as LanguageModelChatMessage)?.content ?? text);
            if (model) {
              try {
                return await model.countTokens(value, token);
              } catch {
                /* the model went away: approximate below */
              }
            }
            return Math.ceil(value.length / 4);
          };
    const budget = typeof given?.tokenBudget === "number" ? given.tokenBudget : (model?.maxInputTokens ?? 0);
    return { tokenBudget: budget, countTokens };
  }

  /* ── MCP servers ──────────────────────────────────────────────────────── */

  #mcpServers(): McpServer[] {
    return [...this.mcpProviders.values()].flatMap((reg) => [...reg.servers.values()]);
  }

  #findMcpTool(fullName: string): { server: McpServer; tool: McpToolInfo } | undefined {
    for (const server of this.#mcpServers()) {
      for (const tool of server.tools) if (server.names.get(tool.name) === fullName) return { server, tool };
    }
    return undefined;
  }

  async #invokeMcp(server: McpServer, tool: McpToolInfo, input: unknown): Promise<LanguageModelToolResult> {
    if (!server.client) throw new Error(`MCP server '${server.label}' is not running`);
    const result: McpToolResult = await server.client.callTool(tool.name, input);
    const parts = result.content.map((item) => {
      if (item.type === "image" && typeof item.data === "string")
        return LanguageModelDataPart.image(Uint8Array.from(Buffer.from(item.data, "base64")), item.mimeType ?? "image/png");
      if (item.type === "text" && typeof item.text === "string") return new LanguageModelTextPart(item.text);
      return new LanguageModelTextPart(JSON.stringify(item));
    });
    if (result.isError)
      throw new Error(parts.map((part) => (part instanceof LanguageModelTextPart ? part.value : "")).join("") || `MCP tool '${tool.name}' failed`);
    return new LanguageModelToolResult(parts);
  }

  registerMcpProvider(extensionId: string, id: string, provider: Loose): Disposable {
    if (this.mcpProviders.has(id)) throw new Error(`MCP server definition provider '${id}' is already registered`);
    if (!provider || typeof provider.provideMcpServerDefinitions !== "function")
      throw new Error("an MCP server definition provider needs provideMcpServerDefinitions");
    const reg: McpProviderReg = { id, extensionId, provider, servers: new Map(), subscription: null, refreshing: null };
    this.mcpProviders.set(id, reg);
    reg.subscription =
      typeof provider.onDidChangeMcpServerDefinitions === "function" ? provider.onDidChangeMcpServerDefinitions(() => void this.refreshMcp(reg)) : null;
    void this.refreshMcp(reg);
    return new Disposable(() => {
      if (this.mcpProviders.get(id) === reg) this.mcpProviders.delete(id);
      reg.subscription?.dispose();
      for (const server of reg.servers.values()) server.client?.stop();
      reg.servers.clear();
      this.changed();
    });
  }

  refreshMcp(reg: McpProviderReg): Promise<void> {
    reg.refreshing = (reg.refreshing ?? Promise.resolve()).then(() => this.#syncMcp(reg));
    return reg.refreshing;
  }

  async #syncMcp(reg: McpProviderReg): Promise<void> {
    let definitions: Loose[] = [];
    try {
      definitions = (await reg.provider.provideMcpServerDefinitions(new CancellationTokenSource().token)) ?? [];
    } catch (error) {
      this.host.log("warning", `MCP provider '${reg.id}' failed: ${errorMessage(error)}`, reg.extensionId);
    }
    const wanted = new Map<string, Loose>();
    for (const definition of definitions) if (definition && typeof definition.label === "string") wanted.set(definition.label, definition);
    for (const [label, server] of [...reg.servers]) {
      if (wanted.has(label)) continue;
      server.client?.stop();
      reg.servers.delete(label);
    }
    for (const [label, definition] of wanted) {
      const existing = reg.servers.get(label);
      if (existing && (existing.status === "running" || existing.status === "starting")) continue;
      await this.#startMcp(reg, label, definition);
    }
    this.changed();
  }

  async #startMcp(reg: McpProviderReg, label: string, definition: Loose): Promise<void> {
    const server: McpServer = { id: `${reg.id}/${label}`, label, extensionId: reg.extensionId, status: "starting", client: null, tools: [], names: new Map() };
    reg.servers.set(label, server);
    this.changed();
    try {
      let resolved = definition;
      if (typeof reg.provider.resolveMcpServerDefinition === "function")
        resolved = (await reg.provider.resolveMcpServerDefinition(definition, new CancellationTokenSource().token)) ?? definition;
      const spec = this.#mcpSpec(resolved);
      const what = spec.type === "stdio" ? `${spec.command} ${spec.args.join(" ")}`.trim() : spec.url;
      const key = `${reg.extensionId}\u0000${label}\u0000${what}`;
      if (!this.#trusted.has(key)) {
        const answer = await this.confirm(`Start MCP server "${label}"?`, `The extension ${reg.extensionId} wants to connect to an MCP server: ${what}`, [
          "Start server",
          "Don't start",
        ]);
        if (answer !== 0) throw new Error("not started (the user did not allow it)");
        this.#trusted.add(key);
      }
      const client = new McpClient(spec, (reason) => {
        if (server.client === client) {
          server.status = "error";
          server.error = reason;
          server.client = null;
          this.changed();
        }
      });
      await client.start();
      server.client = client;
      const tools = await client.listTools();
      const prefix = `mcp_${label.replace(/[^\w-]+/g, "_")}_`;
      server.tools = tools;
      server.names = new Map(tools.map((tool) => [tool.name, `${prefix}${tool.name}`.replace(/[^\w-]+/g, "_").slice(0, 64)]));
      server.status = "running";
    } catch (error) {
      server.status = "error";
      server.error = errorMessage(error);
      this.host.log("warning", `MCP server '${label}' did not start: ${server.error}`, reg.extensionId);
    }
    this.changed();
  }

  #mcpSpec(definition: Loose): McpServerSpec {
    if (typeof definition.command === "string") {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(definition.env ?? {})) if (value !== null && value !== undefined) env[key] = String(value);
      const cwd = definition.cwd ? (Uri.isUri(definition.cwd) ? definition.cwd.fsPath : String(definition.cwd)) : (this.host.workspace ?? undefined);
      return { type: "stdio", command: definition.command, args: (definition.args ?? []).map(String), env, cwd };
    }
    if (definition.uri)
      return { type: "http", url: Uri.isUri(definition.uri) ? definition.uri.toString() : String(definition.uri), headers: { ...definition.headers } };
    throw new Error("an MCP server definition needs a command or a uri");
  }

  /** Start the extensions that declare MCP server providers (contributes.mcpServerDefinitionProviders). */
  async activateMcp(): Promise<void> {
    await Promise.all(
      contributions(this.host, "mcpServerDefinitionProviders").map(async ({ runtime, item }) => {
        if (this.mcpProviders.has(item.id)) return;
        await this.host.activateByEvent(`onMcpCollection:${item.id}`);
        await this.host.activate(runtime, `onMcpCollection:${item.id}`).catch(() => {});
      }),
    );
    await Promise.all([...this.mcpProviders.values()].map((reg) => reg.refreshing));
  }

  wireMcpServers(): ChatWireMcpServer[] {
    return this.#mcpServers().map((server) => ({
      id: server.id,
      label: server.label,
      extensionId: server.extensionId,
      status: server.status,
      tools: server.tools.length,
      error: server.error,
    }));
  }

  stopAll(): void {
    for (const server of this.#mcpServers()) server.client?.stop();
  }

  /* ── panel state ──────────────────────────────────────────────────────── */

  wireState(): ChatWireState {
    const vendors = new Set<string>(contributions(this.host, "languageModelChatProviders").map(({ item }) => String(item.vendor)));
    for (const vendor of this.providers.keys()) vendors.add(vendor);
    return {
      participants: this.listParticipants(),
      models: this.wireModels(),
      vendors: [...vendors],
      tools: this.toolInformation().map((tool) => ({ name: tool.name, description: tool.description })),
      mcpServers: this.wireMcpServers(),
    };
  }

  async refresh(): Promise<ChatWireState> {
    await Promise.all([this.activateProviders(), this.activateMcp()]);
    await Promise.all([...this.providers.values()].map((reg) => this.#load(reg)));
    return this.wireState();
  }

  clear(): void {
    for (const record of this.#requests.values()) record.cts.cancel();
    this.#turns = [];
    this.#direct = [];
    this.#lastParticipant = undefined;
  }

  cancel(id: number): void {
    this.#requests.get(id)?.cts.cancel();
  }

  feedback(id: number, helpful: boolean): void {
    const record = this.#requests.get(id);
    const reg = record?.participantId ? this.participants.get(record.participantId) : undefined;
    if (record && reg) reg.feedback.fire({ result: record.result ?? {}, kind: helpful ? 1 : 0 });
  }

  /* ── a chat request ───────────────────────────────────────────────────── */

  /** Run one user message to the end; progress goes to the panel (`part` messages, then `done`). */
  async run(args: ChatSendArgs): Promise<void> {
    const record: RequestRecord = { cts: new CancellationTokenSource() };
    this.#requests.set(args.id, record);
    let participantId: string | undefined;
    try {
      this.#currentModelId = args.modelId;
      const parsed = this.#parse(args.text);
      participantId = parsed.participant?.id;
      record.participantId = participantId;
      const followups = parsed.participant
        ? await this.#runParticipant(args, record, parsed as Parsed & { participant: ChatWireParticipant })
        : await this.#runDirect(args, record, parsed.prompt);
      this.send({ kind: "done", id: args.id, followups, participant: participantId });
    } catch (error) {
      const cancelled = record.cts.token.isCancellationRequested || error instanceof CancellationError;
      this.send({ kind: "done", id: args.id, error: cancelled ? undefined : errorMessage(error), followups: [], participant: participantId });
    } finally {
      // A participant's answer can still get feedback: keep its record.
      if (!(participantId && record.result !== undefined)) this.#requests.delete(args.id);
      if (this.#requests.size > 50) this.#requests.delete(this.#requests.keys().next().value!);
    }
  }

  #parse(text: string): Parsed {
    const participants = this.listParticipants();
    let rest = text.trim();
    let participant: ChatWireParticipant | undefined;
    const mention = /^@(\S+)\s*/.exec(rest);
    if (mention) {
      const wanted = mention[1]!.toLowerCase();
      participant = participants.find(
        (p) => p.name.toLowerCase() === wanted || p.id.toLowerCase() === wanted || p.fullName.replace(/\s+/g, "").toLowerCase() === wanted,
      );
      if (participant) rest = rest.slice(mention[0].length);
    }
    if (!participant && !mention) {
      const sticky = this.#lastParticipant ? participants.find((p) => p.id === this.#lastParticipant) : undefined;
      participant = sticky ?? participants.find((p) => p.isDefault);
    }
    let command: string | undefined;
    const slash = /^\/(\S+)\s*/.exec(rest);
    if (slash && participant?.commands.some((c) => c.name === slash[1])) {
      command = slash[1];
      rest = rest.slice(slash[0].length);
    }
    return { participant, command, prompt: rest };
  }

  #references(prompt: string): Loose[] {
    const out: Loose[] = [];
    for (const match of prompt.matchAll(/#file:(\S+)/g)) {
      const uri = Uri.file(resolve(this.host.workspace ?? process.cwd(), match[1]!));
      out.push({ id: "vscode.file", name: `file:${basename(uri.fsPath)}`, range: [match.index!, match.index! + match[0].length], value: uri });
    }
    return out;
  }

  async #runParticipant(args: ChatSendArgs, record: RequestRecord, parsed: Parsed & { participant: ChatWireParticipant }): Promise<ChatWireFollowup[]> {
    const { participant: info, command, prompt } = parsed;
    const reg = await this.#ensureParticipant(info);
    if (!reg) throw new Error(`The extension ${info.extensionId} did not register the chat participant '${info.id}'.`);
    this.#lastParticipant = info.id;
    const token = record.cts.token;
    const references = this.#references(prompt);
    const collected: unknown[] = [];
    const model = (await this.#resolveModel(args.modelId)) ?? this.#missingModel();
    const history = this.#turns.filter((turn) => turn.participant === info.id);
    const request = Object.freeze({
      prompt,
      command,
      references,
      toolReferences: [],
      toolInvocationToken: Object.freeze({ chatRequest: args.id }),
      model,
    });
    const stream = this.#responseStream(args.id, collected);
    const result: Loose = (await reg.participant.requestHandler(request, { history }, stream, token)) ?? {};
    record.result = result;
    this.#turns.push(new ChatRequestTurn(prompt, command, references, info.id), new ChatResponseTurn(collected, result, info.id, command));
    if (this.#turns.length > 100) this.#turns.splice(0, this.#turns.length - 100);
    if (result.errorDetails?.message) this.send({ kind: "part", id: args.id, part: { type: "warning", value: String(result.errorDetails.message) } });
    const followups: ChatWireFollowup[] = [];
    const provider = reg.participant.followupProvider;
    if (provider && typeof provider.provideFollowups === "function") {
      try {
        for (const followup of (await provider.provideFollowups(result, { history: this.#turns.filter((turn) => turn.participant === info.id) }, token)) ??
          []) {
          if (followup && typeof followup.prompt === "string")
            followups.push({
              prompt: followup.prompt,
              label: String(followup.label ?? followup.prompt),
              participant: followup.participant,
              command: followup.command,
            });
        }
      } catch (error) {
        this.host.log("warning", `chat followup provider failed: ${errorMessage(error)}`, reg.extensionId);
      }
    }
    const next = result.nextQuestion;
    if (next && typeof next.prompt === "string")
      followups.push({ prompt: next.prompt, label: String(next.label ?? next.prompt), participant: next.participant, command: next.command });
    return followups.map((followup) => ({
      ...followup,
      participant: followup.participant ? (this.listParticipants().find((p) => p.id === followup.participant)?.name ?? followup.participant) : undefined,
    }));
  }

  #missingModel(): LanguageModelChatLike {
    const fail = async () => {
      throw LanguageModelError.NotFound("No language model is available. Install an extension that provides one (contributes.languageModelChatProviders).");
    };
    return Object.freeze({
      id: "none",
      name: "No model",
      vendor: "none",
      family: "",
      version: "",
      maxInputTokens: 0,
      capabilities: { imageInput: false, toolCalling: false },
      sendRequest: fail,
      countTokens: fail,
    });
  }

  /** The `ChatResponseStream` handed to a participant: posts each part to the panel and collects it for the history. */
  #responseStream(id: number, collected: unknown[]): Loose {
    const post = (part: ChatWirePart) => this.send({ kind: "part", id, part });
    const stream: Loose = {
      markdown: (value: string | MarkdownString) => {
        collected.push(new ChatResponseMarkdownPart(value));
        post({ type: "markdown", value: markdownOf(value) });
        return stream;
      },
      anchor: (value: unknown, title?: string) => {
        collected.push(new ChatResponseAnchorPart(value, title));
        const location = wireLocation(value);
        post({ type: "anchor", ...location, title: title ?? (location.path ? basename(location.path) : (location.external ?? "")) });
        return stream;
      },
      button: (command: { command: string; title: string; arguments?: unknown[] }) => {
        collected.push(new ChatResponseCommandButtonPart(command));
        post({ type: "button", title: command.title, command: command.command, args: command.arguments });
        return stream;
      },
      filetree: (value: unknown[], baseUri: unknown) => {
        collected.push(new ChatResponseFileTreePart(value, baseUri));
        post({ type: "filetree", baseDir: Uri.isUri(baseUri) ? uriPath(baseUri) : "", tree: wireTree(value) });
        return stream;
      },
      progress: (value: string, task?: (progress: { report(part: unknown): void }) => unknown) => {
        collected.push(new ChatResponseProgressPart(value));
        post({ type: "progress", value });
        if (typeof task === "function") {
          const report = (part: Loose) => {
            const text = typeof part === "string" ? part : markdownOf(part?.value ?? part);
            if (text) post({ type: "progress", value: text });
          };
          Promise.resolve(task({ report })).then(
            (final) => {
              const text = markdownOf(final as Loose);
              if (text) post({ type: "markdown", value: text });
            },
            () => {},
          );
        }
        return stream;
      },
      reference: (value: unknown, iconPath?: unknown) => {
        collected.push(new ChatResponseReferencePart(value, iconPath));
        const target = (value as Loose)?.variableName ? { label: String((value as Loose).variableName) } : wireLocation(value);
        const path = (target as Loose).path ?? (target as Loose).external;
        post({
          type: "reference",
          path: (target as Loose).path,
          label: (target as Loose).label ?? (path ? basename(path) : "reference"),
          line: (target as Loose).line,
        });
        return stream;
      },
      warning: (value: string | MarkdownString) => {
        collected.push(new ChatResponseWarningPart(value));
        post({ type: "warning", value: markdownOf(value) });
        return stream;
      },
      push: (part: Loose) => {
        if (part instanceof ChatResponseMarkdownPart) return stream.markdown(part.value);
        if (part instanceof ChatResponseAnchorPart) return stream.anchor(part.value, part.title);
        if (part instanceof ChatResponseCommandButtonPart) return stream.button(part.value);
        if (part instanceof ChatResponseFileTreePart) return stream.filetree(part.value, part.baseUri);
        if (part instanceof ChatResponseProgressPart) return stream.progress(part.value);
        if (part instanceof ChatResponseReferencePart) return stream.reference(part.value, part.iconPath);
        if (part instanceof ChatResponseWarningPart) return stream.warning(part.value);
        throw new Error("unsupported chat response part");
      },
    };
    return stream;
  }

  /** The text of the `#file:` references of a prompt, as an attachment block. */
  #attachments(references: Loose[]): string {
    let out = "";
    for (const reference of references) {
      try {
        const file = (reference.value as Uri).fsPath;
        if (statSync(file).size > MAX_ATTACHMENT_BYTES) continue;
        out += `\n\n<attachment filePath="${file}">\n${readFileSync(file, "utf8")}\n</attachment>`;
      } catch {
        /* unreadable: left out */
      }
    }
    return out;
  }

  /** A conversation with a model (no participant), with tool calling. */
  async #runDirect(args: ChatSendArgs, record: RequestRecord, prompt: string): Promise<ChatWireFollowup[]> {
    const model = await this.#resolveModel(args.modelId);
    if (!model) {
      const vendors = this.wireState().vendors;
      throw new Error(
        vendors.length
          ? `No language model is available yet (providers: ${vendors.join(", ")}). Check that the provider extension is configured.`
          : "No language model provider is installed. Install an extension that contributes one (contributes.languageModelChatProviders) to chat with a model, or mention a chat participant with @.",
      );
    }
    const token = record.cts.token;
    const post = (part: ChatWirePart) => this.send({ kind: "part", id: args.id, part });
    const tools = args.useTools === false ? [] : this.toolInformation();
    this.#direct.push(LanguageModelChatMessage.User(`${prompt}${this.#attachments(this.#references(prompt))}`));
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await model.sendRequest([...this.#direct], tools.length ? { tools } : {}, token);
      const calls: LanguageModelToolCallPart[] = [];
      let text = "";
      for await (const part of response.stream) {
        if (part instanceof LanguageModelTextPart) {
          text += part.value;
          post({ type: "markdown", value: part.value });
        } else if (part instanceof LanguageModelToolCallPart) {
          calls.push(part);
        }
      }
      const content: unknown[] = [];
      if (text) content.push(new LanguageModelTextPart(text));
      content.push(...calls);
      this.#direct.push(LanguageModelChatMessage.Assistant(content));
      if (!calls.length || token.isCancellationRequested) break;
      const results: LanguageModelToolResultPart[] = [];
      for (const call of calls) {
        const label = call.name;
        post({ type: "toolcall", callId: call.callId, name: call.name, label, status: "running" });
        try {
          const result = await this.invokeTool(
            call.name,
            { input: call.input, toolInvocationToken: Object.freeze({ chatRequest: args.id }), tokenizationOptions: { tokenBudget: model.maxInputTokens } },
            token,
          );
          results.push(new LanguageModelToolResultPart(call.callId, result.content));
          post({ type: "toolcall", callId: call.callId, name: call.name, label, status: "done", detail: textOf(result.content).slice(0, 2000) });
        } catch (error) {
          results.push(new LanguageModelToolResultPart(call.callId, [new LanguageModelTextPart(`Error: ${errorMessage(error)}`)]));
          post({ type: "toolcall", callId: call.callId, name: call.name, label, status: "error", detail: errorMessage(error) });
        }
      }
      this.#direct.push(LanguageModelChatMessage.User(results));
    }
    if (this.#direct.length > 60) this.#direct.splice(0, this.#direct.length - 60);
    return [];
  }
}

type Parsed = { participant?: ChatWireParticipant; command?: string; prompt: string };

const states = new WeakMap<ExtensionHost, ChatLmState>();

/** The chat state of a host (created on first use). */
export function chatLmState(host: ExtensionHost): ChatLmState {
  let state = states.get(host);
  if (!state) {
    state = new ChatLmState(host);
    states.set(host, state);
  }
  return state;
}

export { messageParts };
