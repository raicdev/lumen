import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { textMateTokenStyle } from "../src/mainview/lib/textmate-scopes.ts";

/**
 * TextMate support: the pure scope → CodeMirror style mapping, and a tiny
 * grammar tokenized with the real vscode-textmate + oniguruma engines.
 *
 *   node --test test/textmate.test.ts
 */

const require = createRequire(import.meta.url);
// vscode-textmate and vscode-oniguruma are CommonJS bundles.
const { INITIAL, Registry, parseRawGrammar } = require("vscode-textmate") as typeof import("vscode-textmate");
const { createOnigScanner, createOnigString, loadWASM } = require("vscode-oniguruma") as typeof import("vscode-oniguruma");

test("scope → style: the most specific scope wins", () => {
  assert.equal(textMateTokenStyle(["source.ruby", "keyword.control.ruby"]), "keyword");
  assert.equal(textMateTokenStyle(["source.js", "storage.type.js"]), "keyword");
  assert.equal(textMateTokenStyle(["source.js", "keyword.operator.assignment.js"]), "operator");
  assert.equal(textMateTokenStyle(["source.js", "constant.numeric.integer.js"]), "number");
  assert.equal(textMateTokenStyle(["source.js", "constant.language.boolean.js"]), "atom");
  assert.equal(textMateTokenStyle(["source.js", "constant.character.escape.js"]), "escape");
  assert.equal(textMateTokenStyle(["source.js", "string.quoted.double.js"]), "string");
  assert.equal(textMateTokenStyle(["source.js", "comment.block.documentation.js"]), "comment");
});

test("scope → style: names, variables and markup", () => {
  assert.equal(textMateTokenStyle(["source.js", "entity.name.function.js"]), "variableName.function");
  assert.equal(textMateTokenStyle(["source.js", "support.function.builtin.js"]), "variableName.function");
  assert.equal(textMateTokenStyle(["source.ts", "entity.name.type.ts"]), "typeName");
  assert.equal(textMateTokenStyle(["source.ts", "entity.name.class.ts"]), "typeName");
  assert.equal(textMateTokenStyle(["source.ts", "support.class.ts"]), "typeName");
  assert.equal(textMateTokenStyle(["text.html", "entity.name.tag.html"]), "tagName");
  assert.equal(textMateTokenStyle(["text.html", "entity.other.attribute-name.html"]), "attributeName");
  assert.equal(textMateTokenStyle(["source.js", "variable.parameter.js"]), "variableName");
  assert.equal(textMateTokenStyle(["source.js", "variable.other.readwrite.js"]), "variableName");
  assert.equal(textMateTokenStyle(["source.js", "punctuation.terminator.js"]), "punctuation");
  assert.equal(textMateTokenStyle(["text.md", "markup.heading.md"]), "heading");
  assert.equal(textMateTokenStyle(["text.md", "markup.bold.md"]), "strong");
  assert.equal(textMateTokenStyle(["text.md", "markup.italic.md"]), "emphasis");
  assert.equal(textMateTokenStyle(["source.js", "invalid.illegal.js"]), "invalid");
});

test("scope → style: source/meta alone are not styled", () => {
  assert.equal(textMateTokenStyle(["source.ruby"]), null);
  assert.equal(textMateTokenStyle(["meta.embedded.block.sql"]), null);
  assert.equal(textMateTokenStyle([]), null);
  // A container scope does not hide a more specific scope.
  assert.equal(textMateTokenStyle(["source.js", "meta.function.js", "entity.name.function.js"]), "variableName.function");
});

test("tokenizes a tiny grammar with vscode-textmate", async () => {
  await loadWASM(readFileSync(require.resolve("vscode-oniguruma/release/onig.wasm")));
  const raw = {
    scopeName: "source.tiny",
    patterns: [
      { name: "keyword.control.tiny", match: "\\b(?:let|const)\\b" },
      { name: "constant.numeric.tiny", match: "\\b\\d+\\b" },
      { name: "string.quoted.double.tiny", begin: '"', end: '"' },
      { name: "comment.line.double-slash.tiny", match: "//.*$" },
    ],
  };
  const registry = new Registry({
    onigLib: Promise.resolve({ createOnigScanner, createOnigString }),
    loadGrammar: async (scopeName) =>
      scopeName === raw.scopeName ? parseRawGrammar(JSON.stringify(raw), "tiny.tmLanguage.json") : null,
  });
  const grammar = await registry.loadGrammar(raw.scopeName);
  assert.ok(grammar);

  const line = 'let answer = 42 "hi" // note';
  const result = grammar.tokenizeLine(line, INITIAL);
  const styled = result.tokens.map((token) => [line.slice(token.startIndex, token.endIndex), textMateTokenStyle(token.scopes)] as const);
  const styleOf = (text: string) => styled.find(([value]) => value.includes(text))?.[1];

  assert.equal(styleOf("let"), "keyword");
  assert.equal(styleOf("42"), "number");
  assert.equal(styleOf("hi"), "string");
  assert.equal(styleOf("// note"), "comment");
  assert.equal(styleOf("="), null);
  assert.equal(styleOf("answer"), null);
  registry.dispose();
});
