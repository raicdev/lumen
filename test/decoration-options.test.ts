import { test } from "node:test";
import assert from "node:assert/strict";
import { ChangeSet } from "@codemirror/state";
import { Decoration, WidgetType } from "@codemirror/view";
import { decorationRenderOptions, decorationTypeOptions, type DecorationConverters } from "../src/main/exthost/decoration-options.ts";
import { attachmentSide, rangeInclusive } from "../src/mainview/lib/ext-decoration-marks.ts";

/**
 * Decoration options of window.createTextEditorDecorationType (VS Code's
 * DecorationRenderOptions) and the CodeMirror inclusivity they map to.
 *
 *   node --test test/decoration-options.test.ts
 */

/** Theme colors become CSS variables; local images become data URLs (in the host for real). */
const convert: DecorationConverters = {
  color: (value) =>
    typeof value === "string" ? value : value && typeof value === "object" && "id" in value ? `var(--${(value as { id: string }).id})` : undefined,
  image: (value) => (typeof value === "string" ? { light: `data:${value}`, dark: `data:${value}` } : undefined),
};

test("light and dark options are sent as separate variants on top of the base options", () => {
  const type = decorationTypeOptions(
    {
      backgroundColor: "white",
      color: "black",
      borderColor: "red",
      isWholeLine: true,
      rangeBehavior: 2,
      light: { backgroundColor: "snow", before: { contentText: "L" } },
      dark: { backgroundColor: "black", before: { color: "white" } },
    },
    convert,
  );
  // The base itself keeps the base options (no dark variant wins).
  assert.equal(type.backgroundColor, "white");
  assert.equal(type.color, "black");
  assert.equal(type.border, "1px solid red");
  assert.equal(type.light?.backgroundColor, "snow");
  assert.equal(type.dark?.backgroundColor, "black");
  // Variants inherit everything they do not override.
  assert.equal(type.light?.color, "black");
  assert.equal(type.light?.border, "1px solid red");
  assert.deepEqual(type.light?.before, { contentText: "L" });
  assert.deepEqual(type.dark?.before, { color: "white" });
  assert.equal(type.isWholeLine, true);
  assert.equal(type.rangeBehavior, 2);
});

test("rangeBehavior defaults to OpenOpen and is kept as given", () => {
  assert.equal(decorationTypeOptions({}, convert).rangeBehavior, 0);
  assert.equal(decorationTypeOptions({ rangeBehavior: 3 }, convert).rangeBehavior, 3);
});

test("ThemeColor options are resolved and gutter icons stay light / dark images", () => {
  const type = decorationTypeOptions(
    {
      backgroundColor: { id: "editor.findMatchBackground" },
      dark: { color: { id: "editor.foreground" } },
      gutterIconPath: "icon.svg",
      gutterIconSize: "12px",
      overviewRulerColor: { id: "editorOverviewRuler.findMatchForeground" },
      overviewRulerLane: 4,
    },
    convert,
  );
  assert.equal(type.backgroundColor, "var(--editor.findMatchBackground)");
  assert.equal(type.dark?.color, "var(--editor.foreground)");
  assert.deepEqual(type.gutterIcon, { light: "data:icon.svg", dark: "data:icon.svg" });
  assert.equal(type.gutterIconSize, "12px");
  assert.equal(type.overviewRulerColor, "var(--editorOverviewRuler.findMatchForeground)");
  assert.equal(type.overviewRulerLane, 4);
});

test("before / after attachments carry every supported option", () => {
  const type = decorationTypeOptions(
    {
      before: {
        contentText: "↑",
        contentIconPath: "arrow.svg",
        border: "1px solid red",
        borderColor: "blue",
        textDecoration: "underline",
        color: "green",
        backgroundColor: "white",
        margin: "0 4px",
        width: "12px",
        height: "12px",
        fontStyle: "italic",
        fontWeight: "bold",
      },
      after: { contentText: "↓" },
    },
    convert,
  );
  assert.deepEqual(type.before, {
    contentText: "↑",
    contentIcon: { light: "data:arrow.svg", dark: "data:arrow.svg" },
    border: "1px solid red",
    borderColor: "blue",
    textDecoration: "underline",
    color: "green",
    backgroundColor: "white",
    margin: "0 4px",
    width: "12px",
    height: "12px",
    fontStyle: "italic",
    fontWeight: "bold",
  });
  assert.deepEqual(type.after, { contentText: "↓" });
});

test("border and outline parts without a shorthand get CSS defaults", () => {
  const type = decorationTypeOptions({ borderColor: "red", outlineWidth: "2px", borderRadius: "3px", letterSpacing: "1px" }, convert);
  assert.equal(type.border, "1px solid red");
  assert.equal(type.borderColor, "red");
  assert.equal(type.outline, "2px solid currentColor");
  assert.equal(type.outlineWidth, "2px");
  assert.equal(type.borderRadius, "3px");
  assert.equal(type.letterSpacing, "1px");
});

test("per-range renderOptions keep their before / after and light / dark variants", () => {
  const options = decorationRenderOptions(
    {
      before: { contentText: "B", color: "red" },
      light: { before: { contentText: "L" } },
      dark: { after: { contentText: "D", fontWeight: "bold" } },
    },
    convert,
  );
  assert.deepEqual(options?.before, { contentText: "B", color: "red" });
  assert.deepEqual(options?.light?.before, { contentText: "L" });
  assert.equal(options?.light?.after, undefined);
  assert.deepEqual(options?.dark?.after, { contentText: "D", fontWeight: "bold" });
  assert.equal(options?.dark?.before, undefined);
  assert.equal(decorationRenderOptions({}, convert), undefined);
});

test("DecorationRangeBehavior maps to open / closed range edges", () => {
  assert.deepEqual(rangeInclusive(undefined), { inclusiveStart: true, inclusiveEnd: true });
  assert.deepEqual(rangeInclusive(0), { inclusiveStart: true, inclusiveEnd: true });
  assert.deepEqual(rangeInclusive(1), { inclusiveStart: false, inclusiveEnd: false });
  assert.deepEqual(rangeInclusive(2), { inclusiveStart: true, inclusiveEnd: false });
  assert.deepEqual(rangeInclusive(3), { inclusiveStart: false, inclusiveEnd: true });
  // A widget side of -1 maps before text inserted at its position (open), +1 after it (closed).
  assert.equal(attachmentSide("before", 0), -1);
  assert.equal(attachmentSide("before", 1), 1);
  assert.equal(attachmentSide("after", 0), 1);
  assert.equal(attachmentSide("after", 1), -1);
});

/** Where CodeMirror maps a marked range after inserting one character at `at`. */
function mapMark(behavior: number, at: number, from: number, to: number): [number, number] {
  const { inclusiveStart, inclusiveEnd } = rangeInclusive(behavior);
  const set = Decoration.set([Decoration.mark({ inclusiveStart, inclusiveEnd }).range(from, to)]);
  const cursor = set.map(ChangeSet.of({ from: at, insert: "x" }, 10)).iter();
  return [cursor.from, cursor.to];
}

test("CodeMirror grows marks at open edges only", () => {
  // Text typed at the start (position 2): OpenOpen / OpenClosed take it in, ClosedClosed / ClosedOpen do not.
  assert.deepEqual(mapMark(0, 2, 2, 5), [2, 6]);
  assert.deepEqual(mapMark(1, 2, 2, 5), [3, 6]);
  assert.deepEqual(mapMark(2, 2, 2, 5), [2, 6]);
  assert.deepEqual(mapMark(3, 2, 2, 5), [3, 6]);
  // Text typed at the end (position 5): OpenOpen / ClosedOpen take it in.
  assert.deepEqual(mapMark(0, 5, 2, 5), [2, 6]);
  assert.deepEqual(mapMark(1, 5, 2, 5), [2, 5]);
  assert.deepEqual(mapMark(2, 5, 2, 5), [2, 5]);
  assert.deepEqual(mapMark(3, 5, 2, 5), [2, 6]);
});

class TestWidget extends WidgetType {
  toDOM() {
    return document.createElement("span");
  }
  eq() {
    return true;
  }
}

/** Where CodeMirror maps a before / after widget after inserting one character at `at`. */
function mapWidget(behavior: number, edge: "before" | "after", at: number, pos: number): number {
  const set = Decoration.set([Decoration.widget({ widget: new TestWidget(), side: attachmentSide(edge, behavior) }).range(pos)]);
  return set.map(ChangeSet.of({ from: at, insert: "x" }, 10)).iter().from;
}

test("before / after widgets follow the same open / closed edges", () => {
  // A before widget at the range start (2): with an open start the typed text stays after it (inside).
  assert.equal(mapWidget(0, "before", 2, 2), 2);
  assert.equal(mapWidget(1, "before", 2, 2), 3);
  // An after widget at the range end (5): with an open end it moves after the typed text.
  assert.equal(mapWidget(0, "after", 5, 5), 6);
  assert.equal(mapWidget(1, "after", 5, 5), 5);
});
