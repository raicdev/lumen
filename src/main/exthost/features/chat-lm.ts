import type { HostFeature } from "./contract.ts";
import { NOT_HANDLED } from "./contract.ts";
import { chatLmState } from "./chat-lm/core.ts";
import { chatLmTypes } from "./chat-lm/types.ts";
import type { ChatSendArgs, ChatViewMessage } from "../../../shared/chat-lm.ts";

/** Host side of the "chat-lm" area: `chat.*`, `lm.*` and the Chat panel's backend. */

const OPEN = "workbench.action.chat.open";
const NEW_CHAT = "workbench.action.chat.newChat";

export const chatLmFeature: HostFeature = {
  area: "chat-lm",

  api: ({ host, extensionId }) => {
    const state = chatLmState(host);
    return {
      chat: {
        createChatParticipant: (id: string, handler: unknown) => state.registerParticipant(extensionId, id, handler),
      },
      lm: {
        selectChatModels: (selector?: unknown) => state.selectChatModels(selector),
        onDidChangeChatModels: state.modelsChanged.event,
        registerLanguageModelChatProvider: (vendor: string, provider: unknown) => state.registerProvider(extensionId, vendor, provider),
        registerTool: (name: string, tool: unknown) => state.registerTool(extensionId, name, tool),
        invokeTool: (name: string, options?: unknown, token?: never) => state.invokeTool(name, options as object, token),
        get tools() {
          return Object.freeze(state.toolInformation());
        },
        registerMcpServerDefinitionProvider: (id: string, provider: unknown) => state.registerMcpProvider(extensionId, id, provider),
      },
    };
  },

  types: chatLmTypes,

  commands: [OPEN, NEW_CHAT],

  init: (host) => {
    const state = chatLmState(host);
    // Extensions that provide MCP servers start with the host; their tools show up in `lm.tools`.
    void state.activateMcp().catch(() => {});
  },

  onViewMessage: (host, payload) => {
    const state = chatLmState(host);
    const message = payload as ChatViewMessage;
    if (message.kind === "cancel") state.cancel(message.id);
    else if (message.kind === "clear") state.clear();
    else if (message.kind === "feedback") state.feedback(message.id, message.helpful);
  },

  onViewRequest: async (host, method, args) => {
    const state = chatLmState(host);
    switch (method) {
      case "state":
        return state.wireState();
      case "refresh":
        return state.refresh();
      case "send":
        // Answers go back as `part` / `done` messages.
        void state.run(args[0] as ChatSendArgs);
        return true;
      default:
        throw new Error(`unknown chat request '${method}'`);
    }
  },

  executeCommand: (host, command, args) => {
    const state = chatLmState(host);
    if (command === OPEN) {
      const arg = args[0] as string | { query?: string; isPartialQuery?: boolean } | undefined;
      const query = typeof arg === "string" ? arg : arg?.query;
      state.send({ kind: "open", query, send: query ? !(typeof arg === "object" && arg?.isPartialQuery) : false });
      return undefined;
    }
    if (command === NEW_CHAT) {
      state.clear();
      state.send({ kind: "clear" });
      return undefined;
    }
    return NOT_HANDLED;
  },
};
