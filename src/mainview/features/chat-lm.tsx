import { useEffect, useMemo, useRef } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import { ChevronRight, Plus, RefreshCw, Send, Square, ThumbsDown, ThumbsUp, MessageSquare, Wrench } from "lucide-react";
import type { ChatHostMessage, ChatWireFollowup, ChatWireParticipant, ChatWirePart, ChatWireState, ChatWireTreeNode } from "../../shared/chat-lm";
import { renderMarkdown } from "../lib/markdown";
import { createStore, refreshFeatures, useStore } from "./store";
import type { ViewFeature, ViewFeatureApi } from "./types";
import { MenuActions } from "./menus-walkthroughs/MenuActions";

/** Window side of the "chat-lm" area: the Chat side bar view. Its styles go to feature-chat-lm.css (linked from index.html). */

type Message = {
  id: number;
  role: "user" | "assistant";
  /** What the user typed (user messages). */
  text?: string;
  parts: ChatWirePart[];
  done: boolean;
  error?: string;
  followups: ChatWireFollowup[];
  participant?: string;
  feedback?: "up" | "down";
};

type ChatState = {
  messages: Message[];
  host: ChatWireState | null;
  input: string;
  busy: boolean;
  modelId: string;
  useTools: boolean;
  /** A message to send as soon as the panel state arrived (`workbench.action.chat.open` with a query). */
  loading: boolean;
};

const store = createStore<ChatState>({ messages: [], host: null, input: "", busy: false, modelId: "", useTools: true, loading: false });
let api: ViewFeatureApi | null = null;
let nextId = 1;

const update = (change: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>)) =>
  store.set((state) => ({ ...state, ...(typeof change === "function" ? change(state) : change) }));

const patchMessage = (id: number, patch: (message: Message) => Message) =>
  update((state) => ({ messages: state.messages.map((message) => (message.id === id ? patch(message) : message)) }));

/** Add a part: consecutive markdown merges, a tool call updates in place, progress replaces the previous progress. */
function addPart(parts: ChatWirePart[], part: ChatWirePart): ChatWirePart[] {
  const last = parts[parts.length - 1];
  if (part.type === "markdown" && last?.type === "markdown") return [...parts.slice(0, -1), { type: "markdown", value: last.value + part.value }];
  if (part.type === "toolcall") {
    const index = parts.findIndex((candidate) => candidate.type === "toolcall" && candidate.callId === part.callId);
    if (index >= 0) return parts.map((candidate, i) => (i === index ? part : candidate));
  }
  if (part.type === "progress") return [...parts.filter((candidate) => candidate.type !== "progress"), part];
  return [...parts, part];
}

function send(text: string): void {
  const state = store.get();
  const trimmed = text.trim();
  if (!trimmed || state.busy || !api) return;
  const id = nextId++;
  update({
    input: "",
    busy: true,
    messages: [
      ...state.messages,
      { id: nextId++, role: "user", text: trimmed, parts: [], done: true, followups: [] },
      { id, role: "assistant", parts: [], done: false, followups: [] },
    ],
  });
  api.requestHost("send", [{ id, text: trimmed, modelId: state.modelId || undefined, useTools: state.useTools }]).catch((error: unknown) => finish(id, error instanceof Error ? error.message : String(error), []));
}

function finish(id: number, error: string | undefined, followups: ChatWireFollowup[], participant?: string): void {
  patchMessage(id, (message) => ({ ...message, done: true, error, followups, participant, parts: message.parts.filter((part) => part.type !== "progress") }));
  update({ busy: false });
}

function newChat(): void {
  api?.sendToHost({ kind: "clear" });
  update({ messages: [], busy: false });
}

async function refresh(): Promise<void> {
  if (!api) return;
  update({ loading: true });
  try {
    update({ host: await api.requestHost<ChatWireState>("refresh"), loading: false });
  } catch {
    update({ loading: false });
  }
  refreshFeatures();
}

function handleHostMessage(message: ChatHostMessage): void {
  switch (message.kind) {
    case "state":
      update({ host: message.state });
      refreshFeatures();
      break;
    case "part":
      patchMessage(message.id, (m) => ({ ...m, parts: addPart(m.parts, message.part) }));
      break;
    case "done":
      finish(message.id, message.error, message.followups, message.participant);
      break;
    case "clear":
      update({ messages: [], busy: false });
      break;
    case "open":
      api?.revealSidebarView("chat-lm");
      if (message.query) {
        if (message.send) send(message.query);
        else update({ input: message.query });
      }
      break;
  }
}

/* ── rendering ─────────────────────────────────────────────────────────── */

/** Links inside rendered markdown: `command:` links run commands, the rest opens outside. */
function onMarkdownClick(event: MouseEvent<HTMLElement>): void {
  const link = (event.target as HTMLElement).closest("a");
  if (!link || !api) return;
  event.preventDefault();
  const href = link.getAttribute("href") ?? "";
  if (href.startsWith("command:")) {
    const [id, query] = href.slice("command:".length).split("?");
    let args: unknown[] = [];
    try {
      const parsed = query ? JSON.parse(decodeURIComponent(query)) : [];
      args = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      /* no arguments */
    }
    api.executeCommand(id!, ...args);
  } else if (/^https?:/i.test(href)) {
    api.executeCommand("vscode.open", href);
  }
}

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className="chat-md" onClick={onMarkdownClick} dangerouslySetInnerHTML={{ __html: html }} />;
}

function Tree({ nodes, base, dir }: { nodes: ChatWireTreeNode[]; base: string; dir: string }) {
  return (
    <ul className="chat-tree">
      {nodes.map((node) => {
        const path = `${dir}${dir && !/[\\/]$/.test(dir) ? "/" : ""}${node.name}`;
        return (
          <li key={path}>
            {node.children ? (
              <>
                <span className="chat-tree-dir">
                  <ChevronRight size={12} />
                  {node.name}
                </span>
                <Tree nodes={node.children} base={base} dir={path} />
              </>
            ) : (
              <button type="button" className="chat-link" onClick={() => void api?.openFile(path)}>
                {node.name}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Part({ part }: { part: ChatWirePart }) {
  switch (part.type) {
    case "markdown":
      return <Markdown text={part.value} />;
    case "progress":
      return <div className="chat-progress">{part.value}</div>;
    case "warning":
      return <div className="chat-warning">{part.value}</div>;
    case "reference":
      return (
        <button type="button" className="chat-chip" disabled={!part.path} title={part.path} onClick={() => part.path && void api?.openFile(part.path, { line: part.line })}>
          {part.label}
        </button>
      );
    case "anchor":
      return part.path ? (
        <button type="button" className="chat-link" title={part.path} onClick={() => void api?.openFile(part.path!, { line: part.line })}>
          {part.title}
        </button>
      ) : (
        <button type="button" className="chat-link" title={part.external} onClick={() => api?.executeCommand("vscode.open", part.external)}>
          {part.title}
        </button>
      );
    case "button":
      return (
        <button type="button" className="chat-button" onClick={() => api?.executeCommand(part.command, ...(part.args ?? []))}>
          {part.title}
        </button>
      );
    case "filetree":
      return <Tree nodes={part.tree} base={part.baseDir} dir={part.baseDir} />;
    case "toolcall":
      return (
        <details className={`chat-tool chat-tool-${part.status}`}>
          <summary>
            <Wrench size={12} /> {part.label} <span className="chat-tool-status">{part.status === "running" ? "running…" : part.status}</span>
          </summary>
          {part.detail ? <pre>{part.detail}</pre> : null}
        </details>
      );
  }
}

function MessageView({ message }: { message: Message }) {
  if (message.role === "user") return <div className="chat-msg chat-user">{message.text}</div>;
  const empty = !message.parts.length && !message.error;
  return (
    <div className="chat-msg chat-assistant">
      {message.participant ? <div className="chat-who">@{store.get().host?.participants.find((p) => p.id === message.participant)?.name ?? message.participant}</div> : null}
      {message.parts.map((part, index) => (
        <Part key={index} part={part} />
      ))}
      {!message.done && empty ? <div className="chat-progress">Working…</div> : null}
      {message.error ? <div className="chat-error">{message.error}</div> : null}
      {message.done && message.participant ? (
        <div className="chat-feedback">
          <button type="button" className={`icon-btn${message.feedback === "up" ? " active" : ""}`} title="Helpful" onClick={() => feedback(message, true)}>
            <ThumbsUp size={13} />
          </button>
          <button type="button" className={`icon-btn${message.feedback === "down" ? " active" : ""}`} title="Unhelpful" onClick={() => feedback(message, false)}>
            <ThumbsDown size={13} />
          </button>
        </div>
      ) : null}
      {message.done && message.followups.length ? (
        <div className="chat-followups">
          {message.followups.map((followup, index) => (
            <button key={index} type="button" className="chat-chip" onClick={() => send(`${followup.participant ? `@${followup.participant} ` : ""}${followup.command ? `/${followup.command} ` : ""}${followup.prompt}`)}>
              {followup.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function feedback(message: Message, helpful: boolean): void {
  api?.sendToHost({ kind: "feedback", id: message.id, helpful });
  patchMessage(message.id, (m) => ({ ...m, feedback: helpful ? "up" : "down" }));
}

type Suggestion = { insert: string; label: string; description: string };

/** `@participant` and `/command` completions for the text typed so far. */
function suggestions(input: string, participants: ChatWireParticipant[]): Suggestion[] {
  const mention = /^@(\S*)$/.exec(input);
  if (mention) {
    const typed = mention[1]!.toLowerCase();
    return participants.filter((p) => p.name.toLowerCase().startsWith(typed)).map((p) => ({ insert: `@${p.name} `, label: `@${p.name}`, description: p.description || p.fullName }));
  }
  const command = /^@(\S+)\s+\/(\S*)$/.exec(input);
  if (command) {
    const participant = participants.find((p) => p.name.toLowerCase() === command[1]!.toLowerCase());
    return (participant?.commands ?? []).filter((c) => c.name.startsWith(command[2]!)).map((c) => ({ insert: `@${participant!.name} /${c.name} `, label: `/${c.name}`, description: c.description }));
  }
  return [];
}

function ChatPanel() {
  const state = useStore(store);
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const participants = state.host?.participants ?? [];
  const models = state.host?.models ?? [];
  const hints = suggestions(state.input, participants);
  const tools = state.host?.tools.length ?? 0;
  const nothing = !!state.host && !participants.length && !models.length;

  useEffect(() => {
    const element = log.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [state.messages]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Tab" && hints.length) {
      event.preventDefault();
      update({ input: hints[0]!.insert });
    } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send(state.input);
    }
  };

  return (
    <div className="chat-panel">
      <div className="sidebar-header">
        <span>Chat</span>
        <div className="sidebar-actions">
          <button type="button" className="icon-btn" title="New chat" onClick={newChat}>
            <Plus size={14} />
          </button>
          <button type="button" className={`icon-btn${state.loading ? " chat-spin" : ""}`} title="Refresh models and participants" onClick={() => void refresh()}>
            <RefreshCw size={14} />
          </button>
        </div>
      </div>
      <div className="chat-log" ref={log}>
        {!state.messages.length ? (
          <div className="chat-empty">
            <MessageSquare size={28} strokeWidth={1.2} />
            {nothing ? (
              <>
                <p>
                  <strong>No language model provider is installed.</strong>
                </p>
                <p>Install an extension that contributes a language model (contributes.languageModelChatProviders) or a chat participant (contributes.chatParticipants), then press refresh.</p>
              </>
            ) : (
              <>
                <p>{models.length ? "Ask a question, or mention a participant with @." : "No language model is available. Chat participants can still be used with @."}</p>
                {participants.length ? (
                  <div className="chat-participants">
                    {participants.map((p) => (
                      <button key={p.id} type="button" className="chat-chip" title={p.description || p.fullName} onClick={() => { update({ input: `@${p.name} ` }); input.current?.focus(); }}>
                        @{p.name}
                      </button>
                    ))}
                  </div>
                ) : null}
              </>
            )}
          </div>
        ) : (
          state.messages.map((message) => <MessageView key={message.id} message={message} />)
        )}
      </div>
      <div className="chat-compose">
        {hints.length ? (
          <div className="chat-hints">
            {hints.map((hint) => (
              <button key={hint.insert} type="button" onClick={() => { update({ input: hint.insert }); input.current?.focus(); }}>
                <span>{hint.label}</span>
                <small>{hint.description}</small>
              </button>
            ))}
          </div>
        ) : null}
        <div className="chat-input-row">
          <textarea
            ref={input}
            className="chat-input"
            rows={2}
            placeholder={participants.length ? "Ask, or type @ to mention a participant" : "Ask a question"}
            value={state.input}
            onChange={(event) => update({ input: event.target.value })}
            onKeyDown={onKeyDown}
          />
          {state.busy ? (
            <button type="button" className="icon-btn" title="Stop" onClick={() => { const last = store.get().messages.at(-1); if (last) api?.sendToHost({ kind: "cancel", id: last.id }); }}>
              <Square size={14} />
            </button>
          ) : (
            <button type="button" className="icon-btn" title="Send" disabled={!state.input.trim()} onClick={() => send(state.input)}>
              <Send size={14} />
            </button>
          )}
        </div>
        <div className="chat-options">
          {/* chat/input/status: extensions' status entries of the chat input. */}
          <MenuActions menuId="chat/input/status" lookup={(key) => (key === "chatLocation" ? "panel" : undefined)} args={[]} inline={() => true} className="chat-input-status" />
          {models.length ? (
            <select value={state.modelId} onChange={(event) => update({ modelId: event.target.value })} title="Language model">
              <option value="">{models[0]!.name}{models.length > 1 ? " (default)" : ""}</option>
              {models.slice(1).map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name} ({model.vendor})
                </option>
              ))}
            </select>
          ) : null}
          {tools ? (
            <label title={(state.host?.tools ?? []).map((tool) => tool.name).join("\n")}>
              <input type="checkbox" checked={state.useTools} onChange={(event) => update({ useTools: event.target.checked })} /> Tools ({tools})
            </label>
          ) : null}
        </div>
        {state.host?.mcpServers.length ? (
          <div className="chat-mcp">
            {state.host.mcpServers.map((server) => (
              <span key={server.id} className={`chat-mcp-${server.status}`} title={server.error ?? `${server.tools} tools`}>
                MCP {server.label}: {server.status}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export const chatLmView: ViewFeature = {
  area: "chat-lm",

  init: (featureApi) => {
    api = featureApi;
  },

  onHostReady: (featureApi) => {
    api = featureApi;
    void refresh();
  },

  onHostMessage: (payload, featureApi) => {
    api = featureApi;
    handleHostMessage(payload as ChatHostMessage);
  },

  onHostRequest: async (method, args, featureApi) => {
    if (method !== "confirm") throw new Error(`unknown chat request '${method}'`);
    const [title, message, actions] = args as [string, string, string[]];
    return featureApi.showMessage("warning", `${title}\n${message}`, actions);
  },

  commands: [
    { id: "lumen.chat.focus", title: "Focus on Chat View", category: "Chat", run: (featureApi) => featureApi.revealSidebarView("chat-lm") },
    { id: "lumen.chat.new", title: "New Chat", category: "Chat", run: (featureApi) => { featureApi.revealSidebarView("chat-lm"); newChat(); } },
  ],

  sidebarViews: [
    {
      id: "chat-lm",
      title: "Chat",
      icon: MessageSquare,
      render: () => <ChatPanel />,
    },
  ],
};
