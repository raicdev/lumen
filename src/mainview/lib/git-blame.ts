import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import type { GitBlame } from "../../shared/types";
import { displayLanguage, t } from "./i18n";
import { getSettings } from "./settings";

/**
 * Git blame of the editor's document: who last changed the cursor's line, shown
 * after the line (`git.blame.editorDecoration.enabled`) and in the status bar
 * (`git.blame.statusBarItem.enabled`). An edit drops the blame until the window
 * blames the new text (lines would no longer match).
 */

const UNCOMMITTED = "0".repeat(40);

export type BlameLine = {
  hash: string;
  author: string;
  email: string;
  date: number;
  summary: string;
  uncommitted: boolean;
};

export const setBlame = StateEffect.define<GitBlame | null>();

const blameField = StateField.define<GitBlame | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setBlame)) return effect.value;
    return tr.docChanged ? null : value;
  },
});

/** The blame of a 1-based line, if the document has one. */
export function blameAt(state: EditorState, line: number): BlameLine | null {
  const blame = state.field(blameField, false);
  const hash = blame?.lines[line - 1];
  if (!blame || !hash) return null;
  const commit = blame.commits[hash];
  if (!commit) return null;
  return { hash, ...commit, uncommitted: hash === UNCOMMITTED };
}

const relativeFormat = new Intl.RelativeTimeFormat(displayLanguage, { numeric: "auto" });

/** "3 days ago", in the display language. */
export function relativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.round((timestamp - now) / 1000);
  // [unit, its length in seconds, the first length shown in the next unit]
  const units: [Intl.RelativeTimeFormatUnit, number, number][] = [
    ["second", 1, 60],
    ["minute", 60, 3600],
    ["hour", 3600, 86400],
    ["day", 86400, 604800],
    ["week", 604800, 2629800],
    ["month", 2629800, 31557600],
    ["year", 31557600, Infinity],
  ];
  const [unit, size] = units.find(([, , next]) => Math.abs(seconds) < next)!;
  return relativeFormat.format(Math.round(seconds / size), unit);
}

/** "Ada, 3 days ago • Fix the parser" (or "Not Committed Yet"). */
export function blameText(line: BlameLine, withSummary = true): string {
  if (line.uncommitted) return t("Not Committed Yet");
  const who = t("{0}, {1}", line.author, relativeTime(line.date));
  return withSummary && line.summary ? `${who} • ${line.summary}` : who;
}

/** The longer hover text: commit id, author, full date and subject. */
export function blameTooltip(line: BlameLine): string {
  if (line.uncommitted) return t("Not Committed Yet");
  return `${line.hash.slice(0, 8)}  ${line.author} <${line.email}>\n${new Date(line.date).toLocaleString(displayLanguage)}\n\n${line.summary}`;
}

class BlameWidget extends WidgetType {
  readonly text: string;
  readonly title: string;
  constructor(text: string, title: string) {
    super();
    this.text = text;
    this.title = title;
  }
  eq(other: BlameWidget) {
    return other.text === this.text;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-git-blame";
    el.textContent = this.text;
    el.title = this.title;
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

/** After the cursor's line, while it is a single cursor without a selection. */
const blameDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(_value, tr) {
    const state = tr.state;
    const selection = state.selection;
    if (!getSettings()["git.blame.editorDecoration.enabled"] || selection.ranges.length > 1 || !selection.main.empty) return Decoration.none;
    const line = state.doc.lineAt(selection.main.head);
    const blame = blameAt(state, line.number);
    if (!blame) return Decoration.none;
    const widget = new BlameWidget(blameText(blame), blameTooltip(blame));
    return Decoration.set([Decoration.widget({ widget, side: 1 }).range(line.to)]);
  },
  provide: (field) => EditorView.decorations.from(field),
});

export const gitBlameExtension: Extension = [blameField, blameDecorations];
