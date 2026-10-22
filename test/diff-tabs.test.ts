import { test } from "node:test";
import assert from "node:assert/strict";
import { ExtensionHost } from "../src/main/exthost/host.ts";
import { TabInputTextDiff, TabInputWebview } from "../src/main/exthost/compat-types.ts";
import * as T from "../src/main/exthost/types.ts";
import type { HostTab } from "../src/shared/extensions.ts";

/**
 * Diff tabs and webview panels in window.tabGroups: the tab inputs an
 * extension sees, and `vscode.diff` reaching the view.
 *
 *   node --test test/diff-tabs.test.ts
 */

function makeHost(): ExtensionHost {
  const host = new ExtensionHost();
  host.init = { extensions: [], config: { lumen: {}, user: {} }, workspace: null, userData: process.cwd(), appRoot: process.cwd(), appName: "Lumen", appVersion: "0.1.0", languages: [], webviewPort: 1, webviewToken: "t" };
  host.send = () => {};
  return host;
}

const tab = (overrides: Partial<HostTab> & Pick<HostTab, "label" | "path" | "kind">): HostTab => ({
  isActive: false,
  isDirty: false,
  isPinned: true,
  isPreview: false,
  ...overrides,
});

test("diff tabs map to TabInputTextDiff and close through the view", async () => {
  const host = makeHost();
  const original = "C:\\work\\a.txt";
  const modified = "C:\\work\\b.txt";
  const diffPath = `diff:${JSON.stringify([original, modified])}`;
  host.handleView({
    type: "tabs",
    groups: [
      {
        viewColumn: 1,
        isActive: true,
        tabs: [tab({ label: "a.txt ↔ b.txt", path: diffPath, kind: "diff", original, modified, isActive: true })],
      },
    ],
  });

  const opened = host.tabGroups.all[0]!.tabs[0]!;
  assert.ok(opened.input instanceof TabInputTextDiff);
  assert.equal(opened.input.original.fsPath.toLowerCase(), original.toLowerCase());
  assert.equal(opened.input.modified.fsPath.toLowerCase(), modified.toLowerCase());

  const closed: string[][] = [];
  (host as unknown as { requestView: (method: string, ...args: unknown[]) => Promise<boolean> }).requestView = async (method, ...args) => {
    assert.equal(method, "closeTabs");
    closed.push(args[0] as string[]);
    return true;
  };
  assert.equal(await host.tabGroups.close(opened), true);
  assert.deepEqual(closed, [[diffPath]]);
});

test("webview tab inputs carry the mainThreadWebview- view type", () => {
  const host = makeHost();
  host.handleView({
    type: "tabs",
    groups: [
      {
        viewColumn: 1,
        isActive: true,
        tabs: [tab({ label: "Cat Coding", path: "webview:w1", kind: "webview", viewType: "catCoding", isActive: true })],
      },
    ],
  });
  const input = host.tabGroups.all[0]!.tabs[0]!.input;
  assert.ok(input instanceof TabInputWebview);
  assert.equal(input.viewType, "mainThreadWebview-catCoding");
});

test("vscode.diff asks the view for a diff tab with its options", async () => {
  const host = makeHost();
  const left = T.Uri.file("C:\\work\\a.txt");
  const right = T.Uri.file("C:\\work\\b.txt");
  const requests: { method: string; args: unknown[] }[] = [];
  (host as unknown as { requestView: (method: string, ...args: unknown[]) => Promise<boolean> }).requestView = async (method, ...args) => {
    requests.push({ method, args });
    return true;
  };

  const selection = new T.Range(1, 2, 3, 4);
  assert.equal(await host.executeCommand("vscode.diff", [left, right, "My Diff", { preview: true, viewColumn: 2, preserveFocus: true, selection }]), true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.method, "openDiff");
  assert.deepEqual(requests[0]!.args, [
    left.fsPath,
    right.fsPath,
    {
      title: "My Diff",
      preview: true,
      preserveFocus: true,
      viewColumn: 2,
      selection: { startLine: 1, startCharacter: 2, endLine: 3, endCharacter: 4 },
    },
  ]);
});

test("vscode.diff keeps virtual document keys", async () => {
  const host = makeHost();
  const left = T.Uri.parse("git:/a.txt?ref=HEAD");
  const right = T.Uri.file("C:\\work\\a.txt");
  const requests: { method: string; args: unknown[] }[] = [];
  (host as unknown as { requestView: (method: string, ...args: unknown[]) => Promise<boolean> }).requestView = async (method, ...args) => {
    requests.push({ method, args });
    return true;
  };
  await host.executeCommand("vscode.diff", [left, right]);
  assert.equal(requests[0]!.method, "openDiff");
  assert.equal((requests[0]!.args as string[])[0], left.toString());
  assert.equal((requests[0]!.args as string[])[1], right.fsPath);
});
