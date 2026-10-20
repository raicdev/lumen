import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ExtensionHost } from "../src/main/exthost/host.ts";
import { chatLmState } from "../src/main/exthost/features/chat-lm/core.ts";
import type { ChatHostMessage } from "../src/shared/chat-lm.ts";

/**
 * Chat participants, language model providers, tools and MCP servers of the extension host.
 *
 *   node --test test/chat-lm.test.ts
 */

const ROOT = resolve(import.meta.dirname, "..");

type Api = Record<string, any>;

function startedHost() {
  const host = new ExtensionHost();
  host.init = { extensions: [], config: { lumen: {}, user: {} }, workspace: null, userData: mkdtempSync(join(tmpdir(), "lumen-chat-test-")), appRoot: ROOT, appName: "Lumen", appVersion: "0.1.0", languages: [], webviewPort: 1, webviewToken: "t" };
  const chat: ChatHostMessage[] = [];
  host.post = (message) => {
    if (message.type === "feature" && message.area === "chat-lm") chat.push(message.payload as ChatHostMessage);
  };
  const api = host.apiFor(null) as Api;
  return { host, api, chat, state: chatLmState(host) };
}

const doneOf = (chat: ChatHostMessage[], id: number) => chat.find((message) => message.kind === "done" && message.id === id) as Extract<ChatHostMessage, { kind: "done" }>;
const markdownOf = (chat: ChatHostMessage[], id: number) =>
  chat.flatMap((message) => (message.kind === "part" && message.id === id && message.part.type === "markdown" ? [message.part.value] : [])).join("");

async function drain(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

test("classes and enums are exported", () => {
  const { api } = startedHost();
  const message = api.LanguageModelChatMessage.User("hello", "me");
  assert.equal(message.role, api.LanguageModelChatMessageRole.User);
  assert.ok(message.content[0] instanceof api.LanguageModelTextPart);
  assert.equal(api.LanguageModelChatMessage.Assistant([new api.LanguageModelTextPart("x")]).role, 2);
  assert.equal(api.LanguageModelChatToolMode.Required, 2);
  assert.equal(api.ChatResultFeedbackKind.Helpful, 1);
  assert.equal(api.LanguageModelError.NotFound("x").code, "NotFound");
  assert.ok(api.LanguageModelError.Blocked("x") instanceof Error);
  assert.equal(new api.ChatResponseMarkdownPart("**x**").value.value, "**x**");
  assert.equal(new api.LanguageModelToolCallPart("1", "t", { a: 1 }).name, "t");
  assert.deepEqual(new api.McpStdioServerDefinition("l", "node", ["a"]).args, ["a"]);
  assert.equal(new api.McpHttpServerDefinition("l", "http://x").label, "l");
  assert.equal(new api.LanguageModelToolResult([]).content.length, 0);
  assert.equal(new api.LanguageModelToolResultPart("1", []).callId, "1");
  assert.equal(new api.LanguageModelPromptTsxPart(1).value, 1);
  assert.equal(new api.LanguageModelDataPart(new Uint8Array(), "image/png").mimeType, "image/png");
  assert.ok(new api.ChatRequestTurn("p", undefined, [], "x.y"));
  assert.ok(new api.ChatResponseTurn([], {}, "x.y"));
});

test("a chat participant streams parts, history and followups", async () => {
  const { api, chat, state } = startedHost();
  const feedback: unknown[] = [];
  const participant = api.chat.createChatParticipant("test.echo", async (request: any, context: any, stream: any) => {
    stream.progress("thinking");
    stream.markdown(`you said: ${request.prompt}`);
    stream.markdown(new api.MarkdownString(` (command ${request.command ?? "none"}, history ${context.history.length})`));
    stream.anchor(api.Uri.file(resolve(ROOT, "package.json")), "package");
    stream.button({ command: "x.run", title: "Run", arguments: [1] });
    stream.filetree([{ name: "src", children: [{ name: "a.ts" }] }], api.Uri.file(ROOT));
    stream.reference(new api.Location(api.Uri.file(resolve(ROOT, "package.json")), new api.Range(2, 0, 2, 1)));
    stream.push(new api.ChatResponseMarkdownPart("!"));
    return { metadata: { n: context.history.length } };
  });
  participant.followupProvider = { provideFollowups: () => [{ prompt: "again", label: "Again", participant: "test.echo" }] };
  participant.onDidReceiveFeedback((event: unknown) => feedback.push(event));
  assert.throws(() => api.chat.createChatParticipant("test.echo", () => {}), /already registered/);

  assert.deepEqual(state.listParticipants().map((p) => [p.id, p.name]), [["test.echo", "echo"]]);
  await state.run({ id: 1, text: "@echo hello" });
  assert.equal(markdownOf(chat, 1), "you said: hello (command none, history 0)!");
  const parts = chat.flatMap((message) => (message.kind === "part" && message.id === 1 ? [message.part.type] : []));
  assert.deepEqual([...new Set(parts)].sort(), ["anchor", "button", "filetree", "markdown", "progress", "reference"]);
  const done = doneOf(chat, 1);
  assert.equal(done.error, undefined);
  assert.deepEqual(done.followups, [{ prompt: "again", label: "Again", participant: "echo", command: undefined }]);

  // The participant is sticky for a message without a mention, and sees its history.
  await state.run({ id: 2, text: "next" });
  assert.equal(markdownOf(chat, 2), "you said: next (command none, history 2)!");

  state.feedback(2, true);
  assert.deepEqual(feedback, [{ result: { metadata: { n: 2 } }, kind: 1 }]);

  participant.dispose();
  assert.equal(state.listParticipants().length, 0);
});

test("a message without a participant or a model explains what is missing", async () => {
  const { api, chat, state } = startedHost();
  await state.run({ id: 1, text: "hello" });
  assert.match(doneOf(chat, 1).error ?? "", /No language model provider is installed/);
  assert.deepEqual(await api.lm.selectChatModels(), []);
  const participant = api.chat.createChatParticipant("a.b", async (request: any) => {
    await request.model.sendRequest([api.LanguageModelChatMessage.User("x")]);
  });
  await state.run({ id: 2, text: "@b hi" });
  assert.match(doneOf(chat, 2).error ?? "", /No language model is available/);
  participant.dispose();
});

test("language model providers, sendRequest, tools and the direct chat loop", async () => {
  const { api, chat, state } = startedHost();
  state.confirm = async () => 0;
  const provider = {
    provideLanguageModelChatInformation: async () => [{ id: "m1", name: "Model One", family: "fam", version: "1", maxInputTokens: 1000, maxOutputTokens: 100, capabilities: { toolCalling: true } }],
    provideLanguageModelChatResponse: async (_model: any, messages: any[], options: any, progress: any) => {
      const last = messages[messages.length - 1];
      const result = last.content.find((part: any) => part instanceof api.LanguageModelToolResultPart);
      if (result) {
        progress.report(new api.LanguageModelTextPart(`tool said ${result.content[0].value}`));
      } else if (options.tools?.some((tool: any) => tool.name === "test.upper")) {
        progress.report(new api.LanguageModelTextPart("calling... "));
        progress.report(new api.LanguageModelToolCallPart("c1", "test.upper", { text: "abc" }));
      } else {
        progress.report("plain");
      }
    },
    provideTokenCount: async (_model: any, text: any) => (typeof text === "string" ? text.length : 7),
  };
  const registration = api.lm.registerLanguageModelChatProvider("acme", provider);
  assert.throws(() => api.lm.registerLanguageModelChatProvider("acme", provider), /already registered/);

  const models = await api.lm.selectChatModels({ vendor: "acme", family: "fam" });
  assert.equal(models.length, 1);
  assert.equal(models[0].name, "Model One");
  assert.equal((await api.lm.selectChatModels({ family: "other" })).length, 0);
  assert.equal(await models[0].countTokens("hello"), 5);

  const response = await models[0].sendRequest([api.LanguageModelChatMessage.User("hi")], {});
  assert.deepEqual(await drain(response.text), ["plain"]);
  // `stream` and `text` can both be consumed.
  assert.equal((await drain(response.stream)).length, 1);

  const calls: any[] = [];
  const tool = api.lm.registerTool("test.upper", {
    invoke: async (options: any) => {
      calls.push(options.input);
      return new api.LanguageModelToolResult([new api.LanguageModelTextPart(String(options.input.text).toUpperCase())]);
    },
  });
  assert.ok(api.lm.tools.some((info: any) => info.name === "test.upper"));
  const direct = await api.lm.invokeTool("test.upper", { input: { text: "x" } });
  assert.equal(direct.content[0].value, "X");
  await assert.rejects(api.lm.invokeTool("no.such", { input: {} }), /not found/);

  await state.run({ id: 1, text: "shout abc" });
  assert.equal(doneOf(chat, 1).error, undefined);
  assert.equal(markdownOf(chat, 1), "calling... tool said ABC");
  assert.deepEqual(calls, [{ text: "x" }, { text: "abc" }]);
  const toolParts = chat.flatMap((message) => (message.kind === "part" && message.part.type === "toolcall" ? [message.part.status] : []));
  assert.deepEqual(toolParts, ["running", "done"]);
  assert.equal(state.wireState().models[0]!.id, "acme/m1");

  tool.dispose();
  registration.dispose();
  await assert.rejects(models[0].sendRequest([api.LanguageModelChatMessage.User("hi")]), (error: any) => error.code === "NotFound");
});

test("a provider that fails surfaces a LanguageModelError", async () => {
  const { api } = startedHost();
  api.lm.registerLanguageModelChatProvider("bad", {
    provideLanguageModelChatInformation: async () => [{ id: "b", name: "B" }],
    provideLanguageModelChatResponse: async () => {
      throw new Error("boom");
    },
  });
  const [model] = await api.lm.selectChatModels({ vendor: "bad" });
  const response = await model.sendRequest([api.LanguageModelChatMessage.User("x")]);
  await assert.rejects(drain(response.text), (error: any) => error instanceof api.LanguageModelError && /boom/.test(error.message));
});

test("MCP servers from a definition provider contribute tools", async () => {
  const { api, state } = startedHost();
  const asked: string[] = [];
  state.confirm = async (title) => {
    asked.push(title);
    return 0;
  };
  const fixture = resolve(ROOT, "test/fixtures/chat-lm/mcp-server.mjs");
  const registration = api.lm.registerMcpServerDefinitionProvider("test.mcp", {
    provideMcpServerDefinitions: async () => [new api.McpStdioServerDefinition("Fixture", process.execPath, [fixture])],
  });
  for (const reg of state.mcpProviders.values()) await reg.refreshing;
  const servers = state.wireMcpServers();
  assert.deepEqual(servers.map((server) => [server.label, server.status, server.tools, server.error]), [["Fixture", "running", 1, undefined]]);
  assert.match(asked[0]!, /Fixture/);
  const info = api.lm.tools.find((tool: any) => tool.tags.includes("mcp"));
  assert.equal(info.name, "mcp_Fixture_echo");
  const result = await api.lm.invokeTool(info.name, { input: { text: "hi" } });
  assert.equal(result.content[0].value, "echo: hi");
  registration.dispose();
  assert.equal(state.wireMcpServers().length, 0);
});

test("a declined MCP server is not started", async () => {
  const { api, state } = startedHost();
  state.confirm = async () => 1;
  const registration = api.lm.registerMcpServerDefinitionProvider("test.mcp2", {
    provideMcpServerDefinitions: async () => [new api.McpStdioServerDefinition("Nope", process.execPath, ["-e", "process.exit(9)"])],
  });
  for (const reg of state.mcpProviders.values()) await reg.refreshing;
  const [server] = state.wireMcpServers();
  assert.equal(server!.status, "error");
  assert.match(server!.error ?? "", /did not allow/);
  registration.dispose();
});
