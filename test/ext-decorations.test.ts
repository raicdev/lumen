import { test } from "node:test";
import assert from "node:assert/strict";
import { gutterIconRules, gutterIconStyle, gutterIconUrl, overviewLaneStyle, overviewMarkRect } from "../src/mainview/lib/ext-decoration-marks.ts";

/**
 * Gutter icons and overview ruler marks of extension decorations
 * (window.createTextEditorDecorationType): the pure placement / style helpers.
 *
 *   node --test test/ext-decorations.test.ts
 */

test("a gutter icon picks the variant of the active theme and falls back", () => {
  const icon = { light: "light.png", dark: "dark.png" };
  assert.equal(gutterIconUrl(icon, true), "dark.png");
  assert.equal(gutterIconUrl(icon, false), "light.png");
  assert.equal(gutterIconUrl({ dark: "dark.png" }, true), "dark.png");
  assert.equal(gutterIconUrl({ dark: "dark.png" }, false), "dark.png");
  assert.equal(gutterIconUrl({ light: "light.png" }, true), "light.png");
  assert.equal(gutterIconUrl(undefined, true), undefined);
});

test("gutterIconSize becomes the image CSS", () => {
  assert.deepEqual(gutterIconStyle(undefined), { width: "16px", height: "16px", backgroundSize: "contain" });
  assert.deepEqual(gutterIconStyle("auto"), { width: "16px", height: "16px", backgroundSize: "contain" });
  assert.deepEqual(gutterIconStyle("cover"), { width: "16px", height: "16px", backgroundSize: "cover" });
  assert.deepEqual(gutterIconStyle("12px"), { width: "12px", height: "12px", backgroundSize: "contain" });
  assert.deepEqual(gutterIconStyle("8"), { width: "8px", height: "8px", backgroundSize: "contain" });
  assert.deepEqual(gutterIconStyle("80%"), { width: "80%", height: "80%", backgroundSize: "contain" });
});

test("a gutter icon's rules switch light / dark images with the theme", () => {
  const both = gutterIconRules("icon-1", { light: "light.png", dark: "dark.png" });
  assert.equal(
    both,
    '.icon-1{background-image:url("dark.png")}:root.vscode-light .icon-1,:root.vscode-high-contrast-light .icon-1{background-image:url("light.png")}',
  );
  // Only one variant: it is used for both themes.
  assert.equal(gutterIconRules("icon-2", { dark: "dark.png" }), '.icon-2{background-image:url("dark.png")}');
  assert.equal(gutterIconRules("icon-3", {}), "");
});

test("overview ruler lanes follow VS Code's bitmap (Left 1, Center 2, Right 4, Full 7)", () => {
  assert.deepEqual(overviewLaneStyle(1), { left: "0", width: "3px" });
  assert.deepEqual(overviewLaneStyle(4), { right: "0", width: "3px" });
  assert.deepEqual(overviewLaneStyle(2), { left: "calc(50% - 1.5px)", width: "3px" });
  assert.deepEqual(overviewLaneStyle(7), { left: "0", width: "100%" });
  // No lane given: the center, like VS Code.
  assert.deepEqual(overviewLaneStyle(undefined), { left: "calc(50% - 1.5px)", width: "3px" });
});

test("overview marks map document offsets onto the ruler and stay visible", () => {
  // Half way down a 1000px document in a 100px ruler.
  assert.deepEqual(overviewMarkRect(500, 500, 100, 1000), { top: 50, height: 2 });
  assert.deepEqual(overviewMarkRect(0, 100, 100, 1000), { top: 0, height: 10 });
  // A range at the very end is clamped inside the ruler.
  const end = overviewMarkRect(1000, 1000, 100, 1000);
  assert.equal(end.top, 98);
  assert.equal(end.height, 2);
  assert.ok(end.top + end.height <= 100);
  // A mark outside the document cannot grow beyond the ruler.
  const beyond = overviewMarkRect(2000, 2000, 100, 1000);
  assert.ok(beyond.top + beyond.height <= 100);
});
