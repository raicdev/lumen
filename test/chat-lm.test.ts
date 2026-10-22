import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ExtensionHost } from "../src/main/exthost/host.ts";
import { chatLmState } from "../src/main/exthost/features/chat-lm/core.ts";
import { chatLmFeature } from "../src/main/exthost/features/chat-lm.ts";
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

test("a participant's iconPath is sent to the panel as an image or a codicon", () => {
  const { api, state } = startedHost();
  const dir = mkdtempSync(join(tmpdir(), "lumen-chat-icon-"));
  const lightPath = join(dir, "light.png");
  const darkPath = join(dir, "dark.svg");
  writeFileSync(lightPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(darkPath, "<svg xmlns='http://www.w3.org/2000/svg'/>");
  const participant = api.chat.createChatParticipant("test.icon", async () => ({}));
  const icon = () => (state.wireState().participants[0] as any).icon;

  assert.equal(icon(), undefined);
  participant.iconPath = new api.ThemeIcon("rocket", new api.ThemeColor("charts.blue"));
  assert.deepEqual(icon(), { codicon: "rocket", color: "charts.blue" });
  participant.iconPath = new api.ThemeIcon("rocket");
  assert.deepEqual(icon(), { codicon: "rocket" });

  participant.iconPath = api.Uri.file(lightPath);
  assert.match(icon().url, /^data:image\/png;base64,/);

  participant.iconPath = { light: api.Uri.file(lightPath), dark: api.Uri.file(darkPath) };
  assert.match(icon().url, /^data:image\/png;base64,/);
  assert.match(icon().dark, /^data:image\/svg\+xml;base64,/);

  participant.iconPath = api.Uri.parse("https://example.test/icon.svg");
  assert.deepEqual(icon(), { url: "https://example.test/icon.svg" });

  participant.iconPath = api.Uri.file(join(dir, "missing.png"));
  assert.equal(icon(), undefined);
  participant.dispose();
});

test("lm.invokeTool hands tokenization options to the tool", async () => {
  const { api, chat, state } = startedHost();
  const counted: string[] = [];
  const registration = api.lm.registerLanguageModelChatProvider("acme", {
    provideLanguageModelChatInformation: async () => [{ id: "m1", name: "Model", maxInputTokens: 4096, capabilities: { toolCalling: true } }],
    provideLanguageModelChatResponse: async (_model: any, messages: any[], _options: any, progress: any) => {
      const last = messages[messages.length - 1];
      if (last.content.some((part: any) => part instanceof api.LanguageModelToolResultPart)) progress.report(new api.LanguageModelTextPart("done"));
      else progress.report(new api.LanguageModelToolCallPart("c1", "test.tokens", {}));
    },
    provideTokenCount: async (_model: any, text: any) => {
      counted.push(String(text));
      return String(text).length * 2;
    },
  });
  const seen: any[] = [];
  const counts: number[] = [];
  const tool = api.lm.registerTool("test.tokens", {
    invoke: async (options: any) => {
      seen.push(options.tokenizationOptions);
      if (options.tokenizationOptions) counts.push(await options.tokenizationOptions.countTokens("abc"));
      return new api.LanguageModelToolResult([new api.LanguageModelTextPart("result")]);
    },
  });

  // The budget of the caller is kept; counting goes through the selected model's provider.
  await api.lm.invokeTool("test.tokens", { input: {}, tokenizationOptions: { tokenBudget: 77 } });
  assert.equal(seen[0].tokenBudget, 77);
  assert.equal(typeof seen[0].countTokens, "function");
  assert.equal(counts[0], 6);

  // Without tokenizationOptions (an extension's plain tool call) the tool gets none, like VS Code.
  await api.lm.invokeTool("test.tokens", { input: {} });
  assert.equal(seen[1], undefined);

  // The tool call of the chat loop gets the model's input size as its budget.
  await state.run({ id: 1, text: "go" });
  assert.equal(doneOf(chat, 1).error, undefined);
  assert.equal(markdownOf(chat, 1), "done");
  assert.equal(seen[2].tokenBudget, 4096);
  assert.equal(counts[1], 6);

  // An empty tokenizationOptions still gets a budget and a counter.
  await api.lm.invokeTool("test.tokens", { input: {}, tokenizationOptions: {} });
  assert.equal(seen[3].tokenBudget, 4096);

  // Without a model the counter approximates (about four characters per token).
  registration.dispose();
  await api.lm.invokeTool("test.tokens", { input: {}, tokenizationOptions: { tokenBudget: 5 } });
  assert.equal(seen[4].tokenBudget, 5);
  assert.equal(counts[3], 1);
  assert.ok(counted.includes("abc"));
  tool.dispose();
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

test("sending through another extension's model asks for consent once per pair", async () => {
  const { api, state } = startedHost();
  const asked: [string, string, string, string | undefined][] = [];
  state.modelConsent = async (extensionId, providerExtensionId, vendor, justification) => {
    asked.push([extensionId, providerExtensionId, vendor, justification]);
    return true;
  };
  let responses = 0;
  const registration = state.registerProvider("provider.ext", "acme", {
    provideLanguageModelChatInformation: async () => [{ id: "m1", name: "Model", family: "fam", version: "1", maxInputTokens: 1000 }],
    provideLanguageModelChatResponse: async (_model: any, _messages: any[], _options: any, progress: any) => {
      responses++;
      progress.report("ok");
    },
  });
  const [model] = await state.selectChatModels({ vendor: "acme" }, "consumer.ext");
  assert.deepEqual(await drain((await model!.sendRequest([api.LanguageModelChatMessage.User("hi")], { justification: "summarise the file" })).text), ["ok"]);
  assert.deepEqual(asked, [["consumer.ext", "provider.ext", "acme", "summarise the file"]]);

  // The pair is remembered: no second prompt for the same extension and provider.
  assert.deepEqual(await drain((await model!.sendRequest([api.LanguageModelChatMessage.User("again")])).text), ["ok"]);
  assert.equal(asked.length, 1);

  // The provider itself needs no consent, and neither does code that is not an extension (the Chat panel).
  await drain((await (await state.selectChatModels({ vendor: "acme" }, "provider.ext"))[0]!.sendRequest([api.LanguageModelChatMessage.User("x")])).text);
  await drain((await (await state.selectChatModels({ vendor: "acme" }))[0]!.sendRequest([api.LanguageModelChatMessage.User("x")])).text);
  assert.equal(asked.length, 1);

  // A justification passed to selectChatModels is shown when the user is asked.
  const [quiet] = await state.selectChatModels({ vendor: "acme", justification: "from the selector" }, "other.ext");
  await drain((await quiet!.sendRequest([api.LanguageModelChatMessage.User("x")])).text);
  assert.deepEqual(asked[1], ["other.ext", "provider.ext", "acme", "from the selector"]);

  // A denial remembers itself and rejects with LanguageModelError.NoPermissions.
  state.modelConsent = async () => false;
  const [denied] = await state.selectChatModels({ vendor: "acme" }, "denied.ext");
  const before = responses;
  await assert.rejects(denied!.sendRequest([api.LanguageModelChatMessage.User("x")]), (error: any) => error.code === "NoPermissions");
  await assert.rejects(denied!.sendRequest([api.LanguageModelChatMessage.User("x")]), (error: any) => error.code === "NoPermissions");
  assert.equal(responses, before);
  assert.equal(asked.length, 2);
  registration.dispose();
});

test("the Manage Language Models view lists provider, vendor, family and id", async () => {
  const { api, host } = startedHost();
  const registration = api.lm.registerLanguageModelChatProvider("acme.html", {
    provideLanguageModelChatInformation: async () => [
      { id: "fast", name: "Fast", family: "fam-a", version: "1" },
      { id: "smart", name: "Smart", family: "fam-b", version: "2" },
    ],
    provideLanguageModelChatResponse: async () => {},
  });
  await api.lm.selectChatModels({ vendor: "acme.html" });
  const result = (await chatLmFeature.onViewRequest!(host, "models", [])) as { models: any[] };
  assert.deepEqual(
    result.models.map((model) => [model.id, model.vendor, model.family, model.extensionId]),
    [
      ["acme.html/fast", "acme.html", "fam-a", "unknown"],
      ["acme.html/smart", "acme.html", "fam-b", "unknown"],
    ],
  );
  registration.dispose();
  assert.deepEqual(((await chatLmFeature.onViewRequest!(host, "models", [])) as { models: any[] }).models, []);
});
