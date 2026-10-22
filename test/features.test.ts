import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ExtensionHost } from "../src/main/exthost/host.ts";
import { NOT_HANDLED, hostFeatures } from "../src/main/exthost/features/registry.ts";
import type { HostFeature } from "../src/main/exthost/features/registry.ts";
import type { HostToView } from "../src/shared/extensions.ts";

/**
 * The plug-in point of the extension host (src/main/exthost/features): API
 * members merged into namespaces, exported types, view messages / requests and
 * built-in commands.
 *
 *   node --test test/features.test.ts
 */

const ROOT = resolve(import.meta.dirname, "..");

function startedHost(): { host: ExtensionHost; posted: HostToView[] } {
  const host = new ExtensionHost();
  host.init = {
    extensions: [],
    config: { lumen: {}, user: {} },
    workspace: null,
    userData: mkdtempSync(join(tmpdir(), "lumen-feature-test-")),
    appRoot: ROOT,
    appName: "Lumen",
    appVersion: "0.1.0",
    languages: [],
    webviewPort: 1,
    webviewToken: "t",
  };
  const posted: HostToView[] = [];
  host.post = (message) => void posted.push(message);
  return { host, posted };
}

test("every area has a host feature that is registered once", () => {
  const areas = hostFeatures.map((feature) => feature.area);
  assert.equal(new Set(areas).size, areas.length);
  for (const area of [
    "tasks",
    "scm",
    "testing",
    "notebooks",
    "authentication",
    "comments",
    "chat-lm",
    "terminal",
    "languages-extra",
    "workspace-misc",
    "icon-themes",
    "theming-contribs",
    "menus-walkthroughs",
  ]) {
    assert.ok(areas.includes(area), area);
  }
});

test("features add and override API members and exports, and talk to the view", async () => {
  const seen: unknown[] = [];
  const feature: HostFeature = {
    area: "test-area",
    api: (ctx) => ({
      window: {
        showInformationMessage: () => "overridden",
        get activeThing() {
          return ctx.extensionId;
        },
      },
      tasks: { fetchTasks: () => ["a"] },
    }),
    types: { Widget: class Widget {} },
    commands: ["test.feature.command"],
    onViewMessage: (_host, payload) => void seen.push(payload),
    onViewRequest: (_host, method, args) => ({ method, args }),
    executeCommand: (_host, command, args) => (command === "test.feature.command" ? ["ran", ...args] : NOT_HANDLED),
  };
  (hostFeatures as HostFeature[]).push(feature);
  try {
    const { host, posted } = startedHost();
    const api = host.apiFor(null) as Record<string, Record<string, unknown>> & Record<string, unknown>;
    assert.equal((api.window!.showInformationMessage as () => string)(), "overridden");
    assert.equal(api.window!.activeThing, "unknown");
    assert.deepEqual((api.tasks!.fetchTasks as () => string[])(), ["a"]);
    assert.equal(typeof api.Widget, "function");
    // Namespaces keep their graceful fallbacks next to the feature's members.
    assert.equal(typeof api.window!.onDidChangeSomethingNew, "function");
    assert.equal(typeof api.tasks!.registerTaskProvider, "function");

    host.handleView({ type: "feature", area: "test-area", payload: { hello: 1 } });
    assert.deepEqual(seen, [{ hello: 1 }]);
    assert.deepEqual(await host.methods.feature("test-area", "ask", [1, 2]), { method: "ask", args: [1, 2] });
    await assert.rejects(host.methods.feature("no-such-area", "ask", []), /does not handle/);

    assert.deepEqual(await host.executeCommand("test.feature.command", [7]), ["ran", 7]);

    host.postFeature("test-area", { to: "view" });
    assert.ok(posted.some((message) => message.type === "feature" && message.area === "test-area"));
    const answer = host.requestFeatureView("test-area", "ping", [1]);
    const request = posted.find((message) => message.type === "request" && message.method === "feature");
    assert.ok(request && request.type === "request");
    assert.deepEqual(request.args, ["test-area", "ping", [1]]);
    host.handleView({ type: "reply", id: request.id, result: "pong" });
    assert.equal(await answer, "pong");
  } finally {
    (hostFeatures as HostFeature[]).splice((hostFeatures as HostFeature[]).indexOf(feature), 1);
  }
});
