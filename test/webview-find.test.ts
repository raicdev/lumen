import { test } from "node:test";
import assert from "node:assert/strict";
import { documentFor, webviewFindAction } from "../src/shared/webview-document.ts";

/**
 * The webview find widget (enableFindWidget): which keys open it, and the
 * bootstrap that runs it inside the page.
 *
 *   node --test test/webview-find.test.ts
 */

test("Ctrl/Cmd+F opens the find bar, F3 / Shift+F3 move between matches", () => {
  assert.equal(webviewFindAction({ key: "f", ctrlKey: true }), "open");
  assert.equal(webviewFindAction({ key: "F", metaKey: true }), "open");
  assert.equal(webviewFindAction({ key: "F3" }), "next");
  assert.equal(webviewFindAction({ key: "F3", shiftKey: true }), "previous");
  assert.equal(webviewFindAction({ key: "f", ctrlKey: true, shiftKey: true }), null);
  assert.equal(webviewFindAction({ key: "f", ctrlKey: true, altKey: true }), null);
  assert.equal(webviewFindAction({ key: "g", ctrlKey: true }), null);
  assert.equal(webviewFindAction({ key: "F3", ctrlKey: true }), null);
});

test("the bootstrap carries the find bar and its match highlights", () => {
  const html = documentFor("<html><head></head><body>hi</body></html>");
  assert.match(html, /__lumenFind/);
  assert.match(html, /::highlight\(lumen-find\)/);
  assert.match(html, /lumen-find-widget/);
  // The bootstrap is valid JavaScript.
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
  assert.doesNotThrow(() => new Function(script));
});
