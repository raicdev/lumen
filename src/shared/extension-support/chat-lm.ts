import type { AreaSupport } from "./types.ts";

/** Support table changes of the "chat-lm" area. */
export const chatLmSupport: AreaSupport = {
  api: {
    "chat.*": null,
    "lm.*": null,
    "chat.createChatParticipant": ["partial", "requests, streaming, history, followups and feedback work; participant icons (iconPath) are not shown"],
    "lm.selectChatModels": "supported",
    "lm.onDidChangeChatModels": "supported",
    "lm.registerLanguageModelChatProvider": ["partial", "no per-extension model consent prompt or model configuration UI"],
    "lm.registerTool": "supported",
    "lm.invokeTool": ["partial", "toolInvocationToken only ties the call to the Chat panel for confirmation; tokenizationOptions are not applied"],
    "lm.tools": "supported",
    "lm.registerMcpServerDefinitionProvider": ["partial", "stdio and HTTP servers expose tools only (no resources, prompts or sampling); each server needs one-time user consent per session; no OAuth"],
  },
  types: [
    "ChatRequestTurn", "ChatResponseTurn", "ChatResultFeedbackKind", "ChatResponseMarkdownPart", "ChatResponseFileTreePart", "ChatResponseAnchorPart",
    "ChatResponseProgressPart", "ChatResponseReferencePart", "ChatResponseCommandButtonPart", "ChatResponseWarningPart", "LanguageModelChatMessage",
    "LanguageModelChatMessageRole", "LanguageModelChatToolMode", "LanguageModelError", "LanguageModelTextPart", "LanguageModelDataPart",
    "LanguageModelPromptTsxPart", "LanguageModelToolCallPart", "LanguageModelToolResultPart", "LanguageModelToolResult", "McpStdioServerDefinition", "McpHttpServerDefinition",
  ],
  contributions: {
    chatParticipants: ["supported", "listed in the Chat panel, mentioned with @name, commands completed with /"],
    languageModelTools: ["supported", "visible in lm.tools; activated on first invokeTool (onLanguageModelTool)"],
    languageModelChatProviders: ["supported", "provider extension is activated when models are selected or the Chat panel refreshes"],
    mcpServerDefinitionProviders: ["partial", "tools only; servers start after a one-time consent per session"],
  },
};
