import type { AreaSupport } from "./types.ts";

/** Support table changes of the "chat-lm" area. */
export const chatLmSupport: AreaSupport = {
  api: {
    "chat.*": null,
    "lm.*": null,
    "chat.createChatParticipant": [
      "partial",
      "requests, streaming, history, followups, feedback and iconPath work in the Chat panel; no chat locations other than the side bar and no request variables",
    ],
    "lm.selectChatModels": "supported",
    "lm.onDidChangeChatModels": "supported",
    "lm.registerLanguageModelChatProvider": [
      "partial",
      "other extensions ask once for consent before using its models; Manage Language Models hides models from the picker; no provider configuration / API key flow",
    ],
    "lm.registerTool": "supported",
    "lm.invokeTool": [
      "partial",
      "tokenizationOptions (budget, countTokens of the selected model) are passed on; toolInvocationToken only ties the call to the Chat panel for confirmation",
    ],
    "lm.tools": "supported",
    "lm.registerMcpServerDefinitionProvider": [
      "partial",
      "stdio and HTTP servers expose tools only (no resources, prompts or sampling); each server needs one-time user consent per session; no OAuth",
    ],
  },
  types: [
    "ChatRequestTurn",
    "ChatResponseTurn",
    "ChatResultFeedbackKind",
    "ChatResponseMarkdownPart",
    "ChatResponseFileTreePart",
    "ChatResponseAnchorPart",
    "ChatResponseProgressPart",
    "ChatResponseReferencePart",
    "ChatResponseCommandButtonPart",
    "ChatResponseWarningPart",
    "LanguageModelChatMessage",
    "LanguageModelChatMessageRole",
    "LanguageModelChatToolMode",
    "LanguageModelError",
    "LanguageModelTextPart",
    "LanguageModelDataPart",
    "LanguageModelPromptTsxPart",
    "LanguageModelToolCallPart",
    "LanguageModelToolResultPart",
    "LanguageModelToolResult",
    "McpStdioServerDefinition",
    "McpHttpServerDefinition",
  ],
  contributions: {
    chatParticipants: ["supported", "listed in the Chat panel, mentioned with @name, commands completed with /"],
    languageModelTools: ["supported", "visible in lm.tools; activated on first invokeTool (onLanguageModelTool)"],
    languageModelChatProviders: ["supported", "provider extension is activated when models are selected or the Chat panel refreshes"],
    mcpServerDefinitionProviders: ["partial", "tools only; servers start after a one-time consent per session"],
  },
};
