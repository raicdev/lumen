import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ExtensionHost } from "../../src/main/exthost/host.ts";
import type { HostToView } from "../../src/shared/extensions.ts";
import type { TestingHostEvent } from "../../src/shared/testing.ts";
import { reviveMenuArg } from "../../src/main/exthost/features/menus-walkthroughs.ts";
import "../../src/main/exthost/features/registry.ts";

/**
 * vscode.tests: controllers, items, profiles, runs, coverage.
 *
 *   node --test test/features/testing.test.ts
 */

const ROOT = resolve(import.meta.dirname, "..", "..");

function startedHost() {
  const host = new ExtensionHost();
  host.init = { extensions: [], config: { lumen: {}, user: {} }, workspace: null, userData: mkdtempSync(join(tmpdir(), "lumen-testing-test-")), appRoot: ROOT, appName: "Lumen", appVersion: "0.1.0", languages: [], webviewPort: 1, webviewToken: "t" };
  const posted: HostToView[] = [];
  host.post = (message) => void posted.push(message);
  const events = () => posted.filter((m) => m.type === "feature" && m.area === "testing").map((m) => (m as { payload: TestingHostEvent }).payload);
  const api = host.apiFor(null) as any;
  return { host, api, events };
}

const wait = (ms = 30) => new Promise((done) => setTimeout(done, ms));
const send = (host: ExtensionHost, payload: unknown) => host.handleView({ type: "feature", area: "testing", payload } as never);

test("controllers build a tree that is synced to the window", async () => {
  const { api, events } = startedHost();
  const controller = api.tests.createTestController("demo", "Demo");
  const file = controller.createTestItem("file", "a.test.ts", api.Uri.file("/w/a.test.ts"));
  const child = controller.createTestItem("t1", "adds", api.Uri.file("/w/a.test.ts"));
  child.range = new api.Range(1, 0, 3, 1);
  child.tags = [new api.TestTag("fast")];
  file.children.add(child);
  controller.items.add(file);
  assert.equal(child.parent, file);
  assert.equal(controller.items.size, 1);
  await wait();
  const tree = events().filter((e) => e.kind === "tree").at(-1)!;
  assert.ok(tree.kind === "tree");
  const item = tree.controllers[0]!.items[0]!;
  assert.equal(item.label, "a.test.ts");
  assert.equal(item.children[0]!.id, "demo\u0000file\u0000t1");
  assert.deepEqual(item.children[0]!.tags, ["fast"]);
  assert.equal(item.children[0]!.range!.endLine, 3);

  assert.throws(() => api.tests.createTestController("demo", "Again"), /duplicate controller/);
  file.children.delete("t1");
  assert.equal(child.parent, undefined);
  controller.dispose();
  await wait();
  const last = events().filter((e) => e.kind === "tree").at(-1)!;
  assert.ok(last.kind === "tree" && last.controllers.length === 0);
});

test("run profiles run through the window request and report results", async () => {
  const { host, api, events } = startedHost();
  const controller = api.tests.createTestController("c", "C");
  const a = controller.createTestItem("a", "a");
  const b = controller.createTestItem("b", "b");
  controller.items.replace([a, b]);
  let seen: any;
  controller.createRunProfile(
    "Run",
    api.TestRunProfileKind.Run,
    async (request: any, token: any) => {
      seen = request;
      const run = controller.createTestRun(request);
      for (const item of request.include ?? [a, b]) {
        run.started(item);
        if (item === a) run.passed(item, 5);
        else {
          const message = api.TestMessage.diff("nope", "1", "2");
          message.location = new api.Location(api.Uri.file("/w/b.ts"), new api.Position(4, 2));
          run.failed(item, message, 7);
        }
      }
      run.appendOutput("hello\r\n", undefined, a);
      assert.equal(token.isCancellationRequested, false);
      run.end();
      run.passed(a); // ignored after end()
    },
    true,
  );

  const result = (await host.methods.feature("testing", "run", [{ kind: api.TestRunProfileKind.Run, include: [] }])) as { started: number };
  assert.equal(result.started, 1);
  await wait();
  assert.equal(seen.include, undefined);
  assert.equal(seen.profile.label, "Run");
  const states = events().filter((e) => e.kind === "state");
  assert.equal(states.length, 4);
  const failed = states.find((e) => e.kind === "state" && e.state === "failed");
  assert.ok(failed && failed.kind === "state");
  assert.equal(failed.testId, "c\u0000b");
  assert.equal(failed.messages![0]!.expected, "1");
  assert.equal(failed.messages![0]!.range!.startLine, 4);
  // testing/* menus: the TestItem and `{ test, message }` of a failure.
  const ref = (fields: Record<string, unknown>) => ({ $ref: { area: "testing", ...fields } });
  const [item, pair] = reviveMenuArg([ref({ item: "c\u0000b" }), ref({ item: "c\u0000b", run: failed.runId, message: 0 })], host) as any[];
  assert.equal(item, b);
  assert.equal(pair.test, b);
  assert.equal(pair.message.expectedOutput, "1");
  assert.equal(reviveMenuArg(ref({ item: "c\u0000b", run: "other", message: 0 }), host), undefined);
  assert.ok(events().some((e) => e.kind === "output" && e.testId === "c\u0000a"));
  assert.equal(events().filter((e) => e.kind === "runEnd").length, 1);

  await host.methods.feature("testing", "run", [{ kind: api.TestRunProfileKind.Run, include: ["c\u0000b"] }]);
  await wait();
  assert.deepEqual(
    seen.include.map((item: any) => item.id),
    ["b"],
  );
  const none = (await host.methods.feature("testing", "run", [{ kind: api.TestRunProfileKind.Debug, include: [] }])) as { started: number; error?: string };
  assert.equal(none.started, 0);
  assert.ok(none.error);
});

test("cancel reaches the run token; handler errors are reported", async () => {
  const { host, api, events } = startedHost();
  const controller = api.tests.createTestController("c", "C");
  let cancelled = false;
  controller.createRunProfile(
    "Run",
    api.TestRunProfileKind.Run,
    (_request: any, token: any) => new Promise<void>((done) => token.onCancellationRequested(() => ((cancelled = true), done()))),
    true,
  );
  controller.createRunProfile(
    "Debug",
    api.TestRunProfileKind.Debug,
    () => {
      throw new Error("boom");
    },
    true,
  );
  await host.methods.feature("testing", "run", [{ kind: 1, include: [] }]);
  send(host, { kind: "cancel" });
  await wait();
  assert.ok(cancelled);
  await host.methods.feature("testing", "run", [{ kind: 2, include: [] }]);
  await wait();
  assert.ok(events().some((e) => e.kind === "error" && /boom/.test(e.message)));
});

test("resolve and refresh handlers, default profiles", async () => {
  const { host, api, events } = startedHost();
  const controller = api.tests.createTestController("c", "C");
  const roots: unknown[] = [];
  controller.resolveHandler = async (item: any) => {
    roots.push(item?.id);
    if (!item) {
      const dir = controller.createTestItem("dir", "dir");
      dir.canResolveChildren = true;
      controller.items.add(dir);
    } else item.children.add(controller.createTestItem("leaf", "leaf"));
  };
  let refreshed = 0;
  controller.refreshHandler = () => void refreshed++;
  await wait();
  assert.deepEqual(roots, [undefined]);
  send(host, { kind: "resolve", id: "c\u0000dir" });
  send(host, { kind: "refresh", controllerId: "c" });
  await wait(50);
  assert.deepEqual(roots, [undefined, "dir"]);
  assert.equal(refreshed, 1);
  const profile = controller.createRunProfile("P", 1, () => {}, false);
  send(host, { kind: "setDefaults", profileIds: [profile.id] });
  assert.equal(profile.isDefault, true);
  await wait();
  const tree = events().filter((e) => e.kind === "tree").at(-1)!;
  assert.ok(tree.kind === "tree" && tree.controllers[0]!.items[0]!.children[0]!.label === "leaf" && tree.controllers[0]!.canRefresh);
});

test("coverage classes and detailed coverage", async () => {
  const { host, api, events } = startedHost();
  const uri = api.Uri.file("/w/src.ts");
  const details = [
    new api.StatementCoverage(2, new api.Range(0, 0, 0, 10), [new api.BranchCoverage(true), new api.BranchCoverage(0)]),
    new api.StatementCoverage(false, new api.Position(1, 0)),
    new api.DeclarationCoverage("f", 1, new api.Range(0, 0, 2, 0)),
  ];
  const file = api.FileCoverage.fromDetails(uri, details);
  assert.deepEqual([file.statementCoverage.covered, file.statementCoverage.total], [1, 2]);
  assert.deepEqual([file.branchCoverage.covered, file.branchCoverage.total], [1, 2]);
  assert.deepEqual([file.declarationCoverage.covered, file.declarationCoverage.total], [1, 1]);
  assert.throws(() => new api.TestCoverageCount(2, 1));

  const controller = api.tests.createTestController("c", "C");
  const profile = controller.createRunProfile(
    "Cov",
    api.TestRunProfileKind.Coverage,
    (request: any) => {
      const run = controller.createTestRun(request);
      run.addCoverage(file);
      run.end();
    },
    true,
  );
  profile.loadDetailedCoverage = async (_run: unknown, coverage: unknown) => (coverage === file ? details : []);
  await host.methods.feature("testing", "run", [{ kind: 3, include: [] }]);
  await wait();
  const cov = events().find((e) => e.kind === "coverage");
  assert.ok(cov && cov.kind === "coverage");
  assert.equal(cov.file.statements.total, 2);
  const detail = (await host.methods.feature("testing", "detailedCoverage", [cov.runId, 0])) as any[];
  assert.equal(detail.length, 3);
  assert.equal(detail[0].branches.length, 2);
  assert.equal(detail[2].kind, "declaration");
});

test("continuous runs call the handler once with continuous and stop by cancelling", async () => {
  const { host, api, events } = startedHost();
  const controller = api.tests.createTestController("c", "C");
  const a = controller.createTestItem("a", "a");
  const b = controller.createTestItem("b", "b");
  controller.items.replace([a, b]);
  let calls = 0;
  let seen: any;
  let cancelled = false;
  const profile = controller.createRunProfile(
    "Watch",
    api.TestRunProfileKind.Run,
    (request: any, token: any) => {
      calls++;
      seen = request;
      controller.createTestRun(request);
      return new Promise<void>((done) => token.onCancellationRequested(() => ((cancelled = true), done())));
    },
    true,
    undefined,
    true,
  );
  assert.equal(profile.supportsContinuousRun, true);
  assert.equal(profile.toWire().supportsContinuousRun, true);
  const continuous = () => (events() as any[]).filter((e) => e.kind === "continuous").at(-1) as any;

  send(host, { kind: "startContinuous", profileId: profile.id, ids: [] });
  await wait();
  assert.equal(calls, 1);
  assert.equal(seen.continuous, true);
  assert.equal(seen.include, undefined);
  assert.equal(continuous().runs.length, 1);
  assert.equal(continuous().runs[0].profileId, profile.id);
  assert.deepEqual(continuous().runs[0].testIds, []);
  // A test run created for the continuous request uses its token and is linked to the state.
  const runStart = events().filter((e) => e.kind === "runStart").at(-1) as any;
  assert.equal(continuous().runs[0].runId, runStart.runId);

  // Starting the same continuous run again does not call the handler twice.
  send(host, { kind: "startContinuous", profileId: profile.id, ids: [] });
  await wait();
  assert.equal(calls, 1);

  send(host, { kind: "stopContinuous", key: continuous().runs[0].key });
  await wait();
  assert.ok(cancelled);
  assert.equal(continuous().runs.length, 0);
  assert.equal(events().filter((e) => e.kind === "runEnd" && e.runId === runStart.runId).length, 1);
});

test("continuous runs can target one item, use commands, and stop when unsupported or deleted", async () => {
  const { host, api, events } = startedHost();
  const controller = api.tests.createTestController("c", "C");
  const a = controller.createTestItem("a", "a");
  const b = controller.createTestItem("b", "b");
  controller.items.replace([a, b]);
  const requests: any[] = [];
  const makeProfile = (label: string, supported: boolean) =>
    controller.createRunProfile(
      label,
      api.TestRunProfileKind.Run,
      (request: any) => {
        requests.push(request);
        return new Promise<void>(() => {});
      },
      true,
      undefined,
      supported,
    );
  const profile = makeProfile("Watch", true);
  const unsupported = makeProfile("Plain", false);

  await host.executeCommand("testing.startContinuousRun", [{ profileId: profile.id, testIds: ["c\u0000a"] }]);
  await wait();
  assert.equal(requests.length, 1);
  assert.deepEqual(
    requests[0].include.map((item: any) => item.id),
    ["a"],
  );
  assert.equal(requests[0].continuous, true);
  const active = () => (events() as any[]).filter((e) => e.kind === "continuous").at(-1) as any;
  assert.deepEqual(active().runs[0].testIds, ["c\u0000a"]);

  // Unknown / unsupported profiles do not start anything.
  const result = (await host.executeCommand("testing.startContinuousRun", [{ profileId: unsupported.id }])) as string[];
  await wait();
  assert.deepEqual(result, []);
  assert.equal(requests.length, 1);

  // Turning supportsContinuousRun off stops the run.
  profile.supportsContinuousRun = false;
  await wait();
  assert.equal(active().runs.length, 0);

  // Deleting the item / stopping through the command with all runs.
  profile.supportsContinuousRun = true;
  await host.executeCommand("testing.startContinuousRun", [{ profileId: profile.id, testIds: ["c\u0000b"] }]);
  await wait();
  assert.equal(active().runs.length, 1);
  await host.executeCommand("testing.stopContinuousRun");
  await wait();
  assert.equal(active().runs.length, 0);
});

test("TestMessage, TestRunRequest and friends", () => {
  const { api } = startedHost();
  const message = new api.TestMessage("x");
  assert.equal(message.message, "x");
  const request = new api.TestRunRequest([], undefined, undefined, true, false);
  assert.equal(request.continuous, true);
  assert.equal(request.preserveFocus, false);
  assert.equal(new api.TestMessageStackFrame("f", api.Uri.file("/a"), new api.Position(1, 2)).position.line, 1);
  assert.equal(api.TestRunProfileKind.Coverage, 3);
});
