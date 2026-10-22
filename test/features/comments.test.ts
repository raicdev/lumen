import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ExtensionHost } from "../../src/main/exthost/host.ts";
import { evaluateWhen } from "../../src/main/exthost/features/comments.ts";
import type { HostToView } from "../../src/shared/extensions.ts";
import type { CommentThreadWire } from "../../src/shared/comments-wire.ts";

/** vscode.comments: controllers, threads, commenting ranges, reply commands.  node --test test/features/comments.test.ts */

const ROOT = resolve(import.meta.dirname, "..", "..");

function startedHost() {
  const host = new ExtensionHost();
  const userData = mkdtempSync(join(tmpdir(), "lumen-comments-test-"));
  host.init = {
    extensions: [],
    config: { lumen: {}, user: {} },
    workspace: null,
    userData,
    appRoot: ROOT,
    appName: "Lumen",
    appVersion: "0.1.0",
    languages: [],
    webviewPort: 1,
    webviewToken: "t",
  };
  const posted: HostToView[] = [];
  host.post = (message) => void posted.push(message);
  return { host, posted, userData };
}

const feature = (posted: HostToView[]) => posted.filter((message) => message.type === "feature").map((message) => (message as { payload: any }).payload);

test("when clauses", () => {
  const context = { commentController: "demo", commentThread: "open", commentThreadIsEmpty: false };
  assert.ok(evaluateWhen(undefined, context));
  assert.ok(evaluateWhen("commentController == demo", context));
  assert.ok(!evaluateWhen("commentController == other", context));
  assert.ok(evaluateWhen("commentController == demo && commentThread == open", context));
  assert.ok(evaluateWhen("commentController == x || commentThread =~ /^op/", context));
  assert.ok(evaluateWhen("!commentThreadIsEmpty && (commentThread != closed)", context));
});

test("types are real enums", () => {
  const { host } = startedHost();
  const api = host.apiFor(null) as Record<string, any>;
  assert.equal(api.CommentThreadCollapsibleState.Expanded, 1);
  assert.equal(api.CommentThreadState.Resolved, 1);
  assert.equal(api.CommentMode.Preview, 1);
  assert.equal(api.CommentState.Draft, 1);
});

test("threads are posted, updated and removed", async () => {
  const { host, posted } = startedHost();
  const api = host.apiFor(null) as Record<string, any>;
  const controller = api.comments.createCommentController("demo", "Demo");
  const uri = api.Uri.file(join(tmpdir(), "demo.txt"));
  const thread = controller.createCommentThread(uri, new api.Range(2, 0, 4, 0), [
    { body: "hello **there**", author: { name: "Ann" }, mode: api.CommentMode.Preview },
  ]);
  thread.label = "Review";
  thread.collapsibleState = api.CommentThreadCollapsibleState.Expanded;
  await Promise.resolve();
  const upserts = feature(posted).filter((payload) => payload.t === "upsert");
  assert.equal(upserts.length, 1);
  const wire = upserts[0].thread as CommentThreadWire;
  assert.equal(wire.controllerId, "demo");
  assert.equal(wire.endLine, 4);
  assert.equal(wire.label, "Review");
  assert.equal(wire.collapsed, false);
  assert.equal(wire.comments[0]!.body, "hello **there**");
  assert.equal(wire.comments[0]!.author, "Ann");

  thread.dispose();
  assert.deepEqual(feature(posted).at(-1), { t: "remove", id: wire.id });
  controller.dispose();
});

test("commenting ranges, a draft thread and the reply command", async () => {
  const { host, posted, userData } = startedHost();
  const file = join(userData, "doc.txt");
  writeFileSync(file, "a\nb\nc\nd\n");
  const api = host.apiFor(null) as Record<string, any>;
  const controller = api.comments.createCommentController("demo", "Demo");
  controller.options = { placeHolder: "Say something" };
  controller.commentingRangeProvider = { provideCommentingRanges: () => [new api.Range(1, 0, 2, 0)] };
  const ranges = (await host.methods.feature("comments", "ranges", [file])) as { controllerId: string; startLine: number; endLine: number }[];
  assert.deepEqual(ranges, [{ controllerId: "demo", startLine: 1, endLine: 2 }]);

  const received: any[] = [];
  api.commands.registerCommand("demo.reply", (reply: any) => {
    received.push(reply);
    reply.thread.comments = [...reply.thread.comments, { body: reply.text, author: { name: "Me" }, mode: 0 }];
  });
  const id = (await host.methods.feature("comments", "createDraft", ["demo", file, 1])) as string;
  await Promise.resolve();
  const draft = feature(posted)
    .filter((p) => p.t === "upsert")
    .at(-1).thread as CommentThreadWire;
  assert.equal(draft.id, id);
  assert.equal(draft.draft, true);
  assert.equal(draft.collapsed, false);
  assert.equal(draft.placeHolder, "Say something");

  await host.methods.feature("comments", "action", [{ threadId: id, kind: "reply", command: "demo.reply", text: "first" }]);
  assert.equal(received[0].text, "first");
  await Promise.resolve();
  const after = feature(posted)
    .filter((p) => p.t === "upsert")
    .at(-1).thread as CommentThreadWire;
  assert.equal(after.draft, false);
  assert.equal(after.comments.length, 1);
  assert.equal(after.comments[0]!.body, "first");
});

test("a discarded draft is removed", async () => {
  const { host, posted, userData } = startedHost();
  const file = join(userData, "doc.txt");
  writeFileSync(file, "a\n");
  const api = host.apiFor(null) as Record<string, any>;
  api.comments.createCommentController("demo", "Demo");
  const id = (await host.methods.feature("comments", "createDraft", ["demo", file, 0])) as string;
  await host.methods.feature("comments", "discard", [id]);
  assert.deepEqual(feature(posted).at(-1), { t: "remove", id });
});
