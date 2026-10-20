/** Messages between the host side (extension host) and the window side of the "chat-lm" area. */

/** One piece of a chat response, as posted to the Chat panel. */
export type ChatWirePart =
  | { type: "markdown"; value: string }
  | { type: "progress"; value: string }
  | { type: "warning"; value: string }
  | { type: "reference"; path?: string; label: string; line?: number }
  | { type: "anchor"; path?: string; external?: string; title: string; line?: number }
  | { type: "button"; title: string; command: string; args?: unknown[] }
  | { type: "filetree"; baseDir: string; tree: ChatWireTreeNode[] }
  | { type: "toolcall"; callId: string; name: string; label: string; status: "running" | "done" | "error"; detail?: string };

export type ChatWireTreeNode = { name: string; children?: ChatWireTreeNode[] };

export type ChatWireParticipant = {
  id: string;
  /** What follows `@` in the input. */
  name: string;
  fullName: string;
  description: string;
  extensionId: string;
  isDefault: boolean;
  commands: { name: string; description: string }[];
};

export type ChatWireModel = { id: string; name: string; vendor: string; family: string; version: string; detail?: string };

export type ChatWireMcpServer = { id: string; label: string; extensionId: string; status: "stopped" | "starting" | "running" | "error"; tools: number; error?: string };

export type ChatWireFollowup = { prompt: string; label: string; participant?: string; command?: string };

/** Snapshot the panel renders. */
export type ChatWireState = {
  participants: ChatWireParticipant[];
  models: ChatWireModel[];
  /** Vendors extensions declare (contributes.languageModelChatProviders) even if they have not registered yet. */
  vendors: string[];
  tools: { name: string; description: string }[];
  mcpServers: ChatWireMcpServer[];
};

/** host -> window (`host.postFeature`). */
export type ChatHostMessage =
  | { kind: "state"; state: ChatWireState }
  | { kind: "part"; id: number; part: ChatWirePart }
  | { kind: "done"; id: number; error?: string; followups: ChatWireFollowup[]; participant?: string }
  | { kind: "open"; query?: string; send?: boolean }
  | { kind: "clear" };

/** window -> host (`api.sendToHost`). */
export type ChatViewMessage =
  | { kind: "cancel"; id: number }
  | { kind: "clear" }
  | { kind: "feedback"; id: number; helpful: boolean };

/** Arguments of `api.requestHost("send", [ChatSendArgs])`. */
export type ChatSendArgs = { id: number; text: string; modelId?: string; useTools?: boolean };
