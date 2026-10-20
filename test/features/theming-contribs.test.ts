import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectColorContributions,
  collectSemanticContributions,
  colorCustomizationsFor,
  colorsCss,
  defaultColorFor,
  parseSemanticSelector,
  semanticSelectorCss,
  semanticTypeChain,
} from "../../src/shared/theming-contribs.ts";

const extensions = [
  {
    manifest: {
      contributes: {
        colors: [
          { id: "myext.bg", description: "Background", defaults: { dark: "#112233", light: "#ffeedd", highContrast: "#000000" } },
          { id: "myext.fg", description: "Ref", defaults: { dark: "editor.foreground", light: "#000" } },
          { id: "bad id", defaults: { dark: "#fff" } },
        ],
        semanticTokenTypes: [{ id: "templateType", superType: "type", description: "t" }, { id: "9bad" }],
        semanticTokenModifiers: [{ id: "native", description: "n" }],
        semanticTokenScopes: [
          { language: "typescript", scopes: { templateType: ["entity.name.type.template"], "property.readonly": ["variable.other.constant.property"] } },
          { scopes: { "*.native": ["support.function"], "bad selector!": ["x"] } },
        ],
      },
    },
  },
];

test("colors: contributions are validated and defaults follow the theme kind", () => {
  const colors = collectColorContributions(extensions);
  assert.deepEqual(colors.map((color) => color.id), ["myext.bg", "myext.fg"]);
  assert.equal(defaultColorFor(colors[0]!, "dark"), "#112233");
  assert.equal(defaultColorFor(colors[0]!, "light"), "#ffeedd");
  assert.equal(defaultColorFor(colors[0]!, "hcDark"), "#000000");
  // No hcLight value: highContrast, which VS Code also uses.
  assert.equal(defaultColorFor(colors[0]!, "hcLight"), "#000000");
  assert.equal(defaultColorFor(colors[1]!, "dark"), "var(--vscode-editor-foreground)");
  assert.equal(defaultColorFor(colors[1]!, "hcDark"), "var(--vscode-editor-foreground)");
});

test("colors: theme values win over defaults, colorCustomizations over both", () => {
  const colors = collectColorContributions(extensions);
  const css = colorsCss({ colors, kind: "dark", themeColors: { "myext.bg": "#abcdef" }, customizations: { "myext.fg": "#ff0000", "editor.background": "rgba(0, 0, 0, 0.5)" } });
  assert.ok(!css.includes("--vscode-myext-bg"), "theme-set colors are left to the theme");
  assert.ok(css.includes("--vscode-myext-fg: #ff0000 !important;"));
  assert.ok(css.includes("--vscode-editor-background: rgba(0, 0, 0, 0.5) !important;"));
  assert.ok(colorsCss({ colors, kind: "light", themeColors: {}, customizations: {} }).includes("--vscode-myext-bg: #ffeedd;"));
});

test("colorCustomizations: per-theme sections and unsafe values", () => {
  const setting = { "editor.background": "#111111", "[Lumen Dark]": { "editor.background": "#222222", "myext.bg": "red" }, "[Other]": { "editor.background": "#333333" }, "x.y": "#fff; } body { display: none", "bad id": "#fff" };
  assert.deepEqual(colorCustomizationsFor(setting, { id: "dark", label: "Lumen Dark" }), { "editor.background": "#222222", "myext.bg": "red" });
  assert.deepEqual(colorCustomizationsFor(null, { id: "a", label: "b" }), {});
});

test("semantic tokens: types, modifiers and scope mappings", () => {
  const contributions = collectSemanticContributions(extensions);
  assert.deepEqual(contributions.types.map((type) => [type.id, type.superType]), [["templateType", "type"]]);
  assert.deepEqual(contributions.modifiers.map((modifier) => modifier.id), ["native"]);
  assert.deepEqual(
    contributions.scopes.map((scope) => [scope.selector, scope.language]),
    [["templateType", "typescript"], ["property.readonly", "typescript"], ["*.native", undefined]],
  );
  const parents = new Map(contributions.types.map((type) => [type.id, type.superType]));
  assert.deepEqual(semanticTypeChain("templateType", parents), ["templateType", "type"]);
  assert.deepEqual(semanticTypeChain("loop", new Map([["loop", "loop"]])), ["loop"]);
});

test("semantic selectors become class selectors", () => {
  assert.deepEqual(parseSemanticSelector("method.static.async:go"), { type: "method", modifiers: ["static", "async"], language: "go" });
  assert.equal(parseSemanticSelector("a b"), null);
  assert.equal(semanticSelectorCss("*.native"), ".cm-sem-mod-native");
  assert.equal(semanticSelectorCss("property.readonly", "typescript"), ".cm-sem-property.cm-sem-mod-readonly.cm-sem-lang-typescript");
  assert.equal(semanticSelectorCss("*"), null);
});
