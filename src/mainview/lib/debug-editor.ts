import { RangeSet, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, gutter, type DecorationSet } from "@codemirror/view";
import type { HostDebugBreakpoint } from "../../shared/extensions";
import { showContextMenu, type ContextMenuItem } from "./context-menu";
import { lineNumberMenuItems } from "../features/menus-walkthroughs/editor";

const withSeparator = (items: ContextMenuItem[]): ContextMenuItem[] => (items.length ? [{ type: "separator" }, ...items] : []);
import { breakpointsFor, debugUi, editBreakpoint, moveBreakpoints, samePath, setBreakpointEnabled, toggleBreakpoint } from "./debug-ui";
import { debugService } from "./debug";

/**
 * Debugging in the editor: a breakpoint gutter left of the line numbers
 * (click to toggle, right-click for conditions / logpoints), the line the
 * debugger stopped at, and breakpoints that follow the lines they are on
 * while the document is edited.
 */

type Mark = { id: string; line: number; bp: HostDebugBreakpoint };
type DebugMarks = { breakpoints: Mark[]; current: { line: number; top: boolean } | null };

const setDebugMarks = StateEffect.define<DebugMarks>();

class BreakpointMarker extends GutterMarker {
  readonly id: string;
  readonly className: string;
  readonly title: string;
  constructor(id: string, className: string, title: string) {
    super();
    this.id = id;
    this.className = className;
    this.title = title;
  }
  eq(other: BreakpointMarker) {
    return other.id === this.id && other.className === this.className && other.title === this.title;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = this.className;
    el.title = this.title;
    return el;
  }
}

class CurrentLineMarker extends GutterMarker {
  readonly top: boolean;
  constructor(top: boolean) {
    super();
    this.top = top;
  }
  eq(other: CurrentLineMarker) {
    return other.top === this.top;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = `cm-debug-arrow${this.top ? "" : " cm-debug-arrow-frame"}`;
    return el;
  }
}

function markerFor(bp: HostDebugBreakpoint): BreakpointMarker {
  const kind = bp.logMessage ? "log" : bp.condition || bp.hitCondition ? "conditional" : "plain";
  const unverified = bp.enabled && bp.verified === false && debugService.getSnapshot().sessions.some((s) => s.state !== "terminated");
  const className = `cm-bp cm-bp-${kind}${bp.enabled ? "" : " cm-bp-disabled"}${unverified ? " cm-bp-unverified" : ""}`;
  const title = [
    bp.logMessage ? `Logpoint: ${bp.logMessage}` : bp.condition ? `Condition: ${bp.condition}` : "Breakpoint",
    bp.hitCondition ? `Hit count: ${bp.hitCondition}` : "",
    bp.enabled ? "" : "(disabled)",
    unverified ? `(unverified${bp.message ? `: ${bp.message}` : ""})` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return new BreakpointMarker(bp.id, className, title);
}

type FieldValue = { marks: RangeSet<BreakpointMarker>; current: { line: number; top: boolean } | null; moved: boolean };

const debugField = StateField.define<FieldValue>({
  create: () => ({ marks: RangeSet.empty, current: null, moved: false }),
  update(value, tr) {
    let { marks, current } = value;
    let moved = false;
    if (tr.docChanged) {
      const before = marks;
      marks = marks.map(tr.changes);
      // Only report a move when a breakpoint really changed lines.
      const lines = (set: RangeSet<BreakpointMarker>, doc: typeof tr.startState.doc) => {
        const out: string[] = [];
        set.between(0, doc.length, (from, _to, m) => void out.push(`${m.id}:${doc.lineAt(from).number}`));
        return out.join(",");
      };
      moved = lines(before, tr.startState.doc) !== lines(marks, tr.state.doc);
      if (current) current = current.line <= tr.state.doc.lines ? current : null;
    }
    for (const effect of tr.effects) {
      if (!effect.is(setDebugMarks)) continue;
      const doc = tr.state.doc;
      const ranges = effect.value.breakpoints
        .filter((m) => m.line >= 1 && m.line <= doc.lines)
        .map((m) => markerFor(m.bp).range(doc.line(m.line).from))
        .sort((a, b) => a.from - b.from);
      marks = RangeSet.of(ranges, true);
      current = effect.value.current && effect.value.current.line <= doc.lines ? effect.value.current : null;
      moved = false;
    }
    return { marks, current, moved };
  },
});

const currentLineDecoration = Decoration.line({ class: "cm-debug-current-line" });
const focusedFrameDecoration = Decoration.line({ class: "cm-debug-focused-line" });

const currentLineHighlight = EditorView.decorations.compute([debugField], (state): DecorationSet => {
  const current = state.field(debugField).current;
  if (!current) return Decoration.none;
  return Decoration.set([(current.top ? currentLineDecoration : focusedFrameDecoration).range(state.doc.line(current.line).from)]);
});

/** The editor's debug extension. `getPath` answers the document shown in this view. */
export function debugEditorExtension(getPath: () => string | null): Extension {
  let moveTimer: ReturnType<typeof setTimeout> | null = null;
  return [
    debugField,
    currentLineHighlight,
    gutter({
      class: "cm-breakpoint-gutter",
      markers: (view) => {
        const { marks, current } = view.state.field(debugField);
        if (!current) return marks;
        const ranges = [new CurrentLineMarker(current.top).range(view.state.doc.line(current.line).from) as ReturnType<GutterMarker["range"]>];
        marks.between(0, view.state.doc.length, (from, _to, m) => void ranges.push(m.range(from)));
        return RangeSet.of(ranges, true);
      },
      initialSpacer: () => new BreakpointMarker("", "cm-bp cm-bp-spacer", ""),
      domEventHandlers: {
        mousedown(view, block, event) {
          const path = getPath();
          if (!path || (event as MouseEvent).button !== 0) return false;
          toggleBreakpoint(path, view.state.doc.lineAt(block.from).number);
          return true;
        },
        contextmenu(view, block, event) {
          const path = getPath();
          if (!path) return false;
          event.preventDefault();
          const line = view.state.doc.lineAt(block.from).number;
          const existing = breakpointsFor(path).find((bp) => bp.line === line);
          const e = event as MouseEvent;
          void showContextMenu(e.clientX, e.clientY, [
            existing
              ? { type: "item", label: "Remove Breakpoint", action: "toggle" }
              : { type: "item", label: "Add Breakpoint", action: "toggle" },
            ...(existing
              ? [{ type: "item" as const, label: existing.enabled ? "Disable Breakpoint" : "Enable Breakpoint", action: "enable" }]
              : []),
            { type: "separator" },
            { type: "item", label: existing?.condition ? "Edit Condition…" : "Add Conditional Breakpoint…", action: "condition" },
            { type: "item", label: existing?.hitCondition ? "Edit Hit Count…" : "Add Hit Count Breakpoint…", action: "hitCondition" },
            { type: "item", label: existing?.logMessage ? "Edit Logpoint…" : "Add Logpoint…", action: "logMessage" },
            // VS Code shows the extensions' editor/lineNumber/context entries here too.
            ...withSeparator(lineNumberMenuItems(path, line)),
          ]).then((action) => {
            if (action === "toggle") toggleBreakpoint(path, line);
            else if (action === "enable" && existing) setBreakpointEnabled(existing.id, !existing.enabled);
            else if (action === "condition" || action === "hitCondition" || action === "logMessage") void editBreakpoint(path, line, action);
          });
          return true;
        },
      },
    }),
    // Edits move breakpoints with their lines; tell the host once typing settles.
    EditorView.updateListener.of((update) => {
      if (!update.docChanged || !update.state.field(debugField).moved) return;
      const path = getPath();
      if (!path) return;
      if (moveTimer) clearTimeout(moveTimer);
      const view = update.view;
      moveTimer = setTimeout(() => {
        moveTimer = null;
        const moved: { id: string; line: number }[] = [];
        view.state.field(debugField).marks.between(0, view.state.doc.length, (from, _to, m) => void moved.push({ id: m.id, line: view.state.doc.lineAt(from).number }));
        moveBreakpoints(path, moved);
      }, 400);
    }),
  ];
}

const lastSync = new WeakMap<EditorView, string>();

/**
 * Push the breakpoints and the debugger's current line for `path` into the view.
 * `force` re-applies them after the view got a new EditorState.
 */
export function syncDebugMarks(view: EditorView, path: string | null, force = false) {
  const breakpoints: Mark[] = path
    ? breakpointsFor(path).map((bp) => ({ id: bp.id, line: bp.line ?? 0, bp }))
    : [];
  const focused = debugUi.getSnapshot().focused;
  const current = path && focused?.line && samePath(focused.path, path) ? { line: focused.line, top: focused.top } : null;
  const running = debugService.getSnapshot().sessions.some((s) => s.state !== "terminated");
  // The debug store also changes for console output: skip when nothing shown changed.
  const key = JSON.stringify([path, running, current, breakpoints.map((m) => [m.id, m.line, m.bp.enabled, m.bp.verified, m.bp.condition, m.bp.hitCondition, m.bp.logMessage, m.bp.message])]);
  if (!force && lastSync.get(view) === key) return;
  lastSync.set(view, key);
  view.dispatch({ effects: setDebugMarks.of({ breakpoints, current }) });
}

/** Subscribe to everything that changes the marks; returns the unsubscribe. */
export function onDebugMarksChange(listener: () => void): () => void {
  const a = debugService.subscribe(listener);
  const b = debugUi.subscribe(listener);
  return () => {
    a();
    b();
  };
}
