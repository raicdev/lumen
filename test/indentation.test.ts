import { test } from "node:test";
import assert from "node:assert/strict";
import { detectIndentation } from "../src/mainview/lib/indentation.ts";

/**
 * Files are edited with the indentation they already use.
 *
 *   node --test test/indentation.test.ts
 */

test("detects spaces and their width", () => {
  assert.deepEqual(detectIndentation("a {\n    b;\n    c {\n        d;\n    }\n}\n"), { insertSpaces: true, tabSize: 4 });
  assert.deepEqual(detectIndentation("a:\n  b:\n    c: 1\n  d: 2\n"), { insertSpaces: true, tabSize: 2 });
});

test("detects tabs", () => {
  assert.deepEqual(detectIndentation("func main() {\n\tif x {\n\t\ty()\n\t}\n}\n"), { insertSpaces: false, tabSize: 4 });
});

test("block comment continuations do not count as a one-space indentation", () => {
  const text = "/**\n * doc\n * more\n */\nfunction f() {\n    return 1;\n}\nclass A {\n    m() {\n        x();\n    }\n}\n";
  assert.deepEqual(detectIndentation(text), { insertSpaces: true, tabSize: 4 });
});

test("too little indentation to tell: the settings apply", () => {
  assert.equal(detectIndentation("one line\n"), null);
  assert.equal(detectIndentation(""), null);
});
