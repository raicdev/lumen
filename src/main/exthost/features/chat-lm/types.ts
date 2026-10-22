import { MarkdownString } from "../../types.ts";

/** Classes and enums of the chat / language model API (`lumen.Chat*`, `lumen.LanguageModel*`, `lumen.Mcp*`). */

/**
 * A participant icon as the Chat panel draws it (from `chat.createChatParticipant`'s `iconPath`):
 * an image URL (a data URL for local files, `dark` overriding it in a dark theme) or a codicon.
 * Mirrored by the window side (mainview/features/chat-lm.tsx).
 */
export type ChatParticipantIcon = { url: string; dark?: string } | { codicon: string; color?: string };

function frozen<T extends Record<string, number>>(values: T): Readonly<T> & Readonly<Record<number, string>> {
  const result: Record<string | number, string | number> = { ...values };
  for (const [key, value] of Object.entries(values)) result[value] = key;
  return Object.freeze(result) as Readonly<T> & Readonly<Record<number, string>>;
}

export const ChatResultFeedbackKind = frozen({ Unhelpful: 0, Helpful: 1 });
export const LanguageModelChatMessageRole = frozen({ User: 1, Assistant: 2 });
export const LanguageModelChatToolMode = frozen({ Auto: 1, Required: 2 });

/* ── response parts (what `ChatResponseStream` pushes, and what a ChatResponseTurn holds) ── */

export class ChatResponseMarkdownPart {
  value: MarkdownString;
  constructor(value: string | MarkdownString) {
    this.value = typeof value === "string" ? new MarkdownString(value) : value;
  }
}

export class ChatResponseFileTreePart {
  value: unknown[];
  baseUri: unknown;
  constructor(value: unknown[], baseUri: unknown) {
    this.value = value;
    this.baseUri = baseUri;
  }
}

export class ChatResponseAnchorPart {
  value: unknown;
  title?: string;
  constructor(value: unknown, title?: string) {
    this.value = value;
    this.title = title;
  }
}

export class ChatResponseProgressPart {
  value: string;
  constructor(value: string) {
    this.value = value;
  }
}

export class ChatResponseReferencePart {
  value: unknown;
  iconPath?: unknown;
  constructor(value: unknown, iconPath?: unknown) {
    this.value = value;
    this.iconPath = iconPath;
  }
}

export class ChatResponseCommandButtonPart {
  value: { command: string; title: string; arguments?: unknown[]; tooltip?: string };
  constructor(value: { command: string; title: string; arguments?: unknown[]; tooltip?: string }) {
    this.value = value;
  }
}

export class ChatResponseWarningPart {
  value: MarkdownString;
  constructor(value: string | MarkdownString) {
    this.value = typeof value === "string" ? new MarkdownString(value) : value;
  }
}

/* ── history ───────────────────────────────────────────────────────────── */

export class ChatRequestTurn {
  readonly prompt: string;
  readonly command: string | undefined;
  readonly references: readonly unknown[];
  readonly participant: string;
  readonly toolReferences: readonly unknown[];
  constructor(prompt: string, command: string | undefined, references: readonly unknown[], participant: string, toolReferences: readonly unknown[] = []) {
    this.prompt = prompt;
    this.command = command;
    this.references = references;
    this.participant = participant;
    this.toolReferences = toolReferences;
  }
}

export class ChatResponseTurn {
  readonly response: readonly unknown[];
  readonly result: unknown;
  readonly participant: string;
  readonly command: string | undefined;
  constructor(response: readonly unknown[], result: unknown, participant: string, command?: string) {
    this.response = response;
    this.result = result;
    this.participant = participant;
    this.command = command;
  }
}

/* ── language model parts ──────────────────────────────────────────────── */

export class LanguageModelTextPart {
  value: string;
  constructor(value: string) {
    this.value = value;
  }
}

export class LanguageModelDataPart {
  data: Uint8Array;
  mimeType: string;
  constructor(data: Uint8Array, mimeType: string) {
    this.data = data;
    this.mimeType = mimeType;
  }
  static image(data: Uint8Array, mimeType: string): LanguageModelDataPart {
    return new LanguageModelDataPart(data, mimeType);
  }
  static json(value: unknown, mime = "text/x-json"): LanguageModelDataPart {
    return new LanguageModelDataPart(new TextEncoder().encode(JSON.stringify(value)), mime);
  }
  static text(value: string, mime = "text/plain"): LanguageModelDataPart {
    return new LanguageModelDataPart(new TextEncoder().encode(value), mime);
  }
}

export class LanguageModelPromptTsxPart {
  value: unknown;
  constructor(value: unknown) {
    this.value = value;
  }
}

export class LanguageModelToolCallPart {
  callId: string;
  name: string;
  input: object;
  constructor(callId: string, name: string, input: object) {
    this.callId = callId;
    this.name = name;
    this.input = input;
  }
}

export class LanguageModelToolResultPart {
  callId: string;
  content: unknown[];
  constructor(callId: string, content: unknown[]) {
    this.callId = callId;
    this.content = content;
  }
}

export class LanguageModelToolResult {
  content: unknown[];
  constructor(content: unknown[]) {
    this.content = content;
  }
}

/** Turn what an API user passes as message content into parts (a string is one text part). */
export function messageParts(content: unknown): unknown[] {
  if (typeof content === "string") return [new LanguageModelTextPart(content)];
  return Array.isArray(content) ? [...content] : content === undefined || content === null ? [] : [content];
}

export class LanguageModelChatMessage {
  role: number;
  content: unknown[];
  name: string | undefined;
  constructor(role: number, content: string | unknown[], name?: string) {
    this.role = role;
    this.content = messageParts(content);
    this.name = name;
  }
  static User(content: string | unknown[], name?: string): LanguageModelChatMessage {
    return new LanguageModelChatMessage(LanguageModelChatMessageRole.User, content, name);
  }
  static Assistant(content: string | unknown[], name?: string): LanguageModelChatMessage {
    return new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, content, name);
  }
}

/** The text of the text parts of a message / result content. */
export function textOf(content: unknown): string {
  return messageParts(content)
    .map((part) => (part instanceof LanguageModelTextPart ? part.value : typeof (part as { value?: unknown })?.value === "string" ? (part as { value: string }).value : ""))
    .join("");
}

export class LanguageModelError extends Error {
  readonly code: string;
  constructor(message?: string, code = "Unknown", cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "LanguageModelError";
    this.code = code;
  }
  static NotFound(message?: string): LanguageModelError {
    return new LanguageModelError(message, "NotFound");
  }
  static NoPermissions(message?: string): LanguageModelError {
    return new LanguageModelError(message, "NoPermissions");
  }
  static Blocked(message?: string): LanguageModelError {
    return new LanguageModelError(message, "Blocked");
  }
}

/* ── MCP server definitions ────────────────────────────────────────────── */

export class McpStdioServerDefinition {
  label: string;
  command: string;
  args: string[];
  cwd?: unknown;
  env: Record<string, string | number | null>;
  version?: string;
  constructor(label: string, command: string, args: string[] = [], env: Record<string, string | number | null> = {}, version?: string) {
    this.label = label;
    this.command = command;
    this.args = args;
    this.env = env;
    this.version = version;
  }
}

export class McpHttpServerDefinition {
  label: string;
  uri: unknown;
  headers: Record<string, string>;
  version?: string;
  constructor(label: string, uri: unknown, headers: Record<string, string> = {}, version?: string) {
    this.label = label;
    this.uri = uri;
    this.headers = headers;
    this.version = version;
  }
}

/** The exports of this area. */
export const chatLmTypes: Record<string, unknown> = {
  ChatResultFeedbackKind,
  LanguageModelChatMessageRole,
  LanguageModelChatToolMode,
  ChatResponseMarkdownPart,
  ChatResponseFileTreePart,
  ChatResponseAnchorPart,
  ChatResponseProgressPart,
  ChatResponseReferencePart,
  ChatResponseCommandButtonPart,
  ChatResponseWarningPart,
  ChatRequestTurn,
  ChatResponseTurn,
  LanguageModelTextPart,
  LanguageModelDataPart,
  LanguageModelPromptTsxPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
  LanguageModelToolResult,
  LanguageModelChatMessage,
  LanguageModelError,
  McpStdioServerDefinition,
  McpHttpServerDefinition,
};
