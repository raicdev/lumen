import { EditorSelection, EditorState, Prec, countColumn, type Extension } from "@codemirror/state";
import { getIndentUnit, indentService, indentString } from "@codemirror/language";
import { keymap } from "@codemirror/view";
import type { HostLanguageConfiguration, HostOnEnterRule } from "../../shared/extensions";

/**
 * CodeMirror support for an extension's language configuration
 * (`languages.setLanguageConfiguration`, or a contributed
 * `language-configuration.json`): comment tokens (toggle comment / block
 * comment), closing brackets, word characters, indentation rules and
 * `onEnterRules`. Also works for languages Lumen has no parser for.
 */

/** `language-configuration.json` patterns never carry flags; compile defensively. */
function compile(source: string | undefined): RegExp | null {
  if (!source) return null;
  try {
    return new RegExp(source);
  } catch {
    return null;
  }
}

/** Printable ASCII, the alphabet a negated wordPattern's characters are taken from. */
const ASCII_PRINTABLE = "!#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";

/** Best-effort `wordChars` (a character set) from a VS Code `wordPattern`. */
function wordCharsFromPattern(pattern: HostLanguageConfiguration["wordPattern"]): string | undefined {
  if (!pattern?.source) return undefined;
  const positive = new Set<string>();
  const negated = new Set<string>();
  const classes = /\[(\^?)((?:\\.|[^\]\\])*)\]/g;
  let match: RegExpExecArray | null;
  while ((match = classes.exec(pattern.source))) {
    const target = match[1] === "^" ? negated : positive;
    const body = match[2]!;
    for (let i = 0; i < body.length; i++) {
      const ch = body[i]!;
      if (ch === "\\") {
        const escape = body[++i];
        if (!escape) break;
        if (escape === "d") for (const digit of "0123456789") target.add(digit);
        else if (escape === "w") for (const word of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_") target.add(word);
        else if (escape !== "s") target.add(escape === "n" ? "\n" : escape === "t" ? "\t" : escape);
        continue;
      }
      if (body[i + 1] === "-" && body[i + 2]) {
        const from = ch.charCodeAt(0);
        const to = body.charCodeAt(i + 2);
        for (let code = from; code <= to && code - from < 256; code++) target.add(String.fromCharCode(code));
        i += 2;
        continue;
      }
      target.add(ch);
    }
  }
  if (positive.size) return [...positive].join("");
  if (negated.size) return [...ASCII_PRINTABLE].filter((ch) => !negated.has(ch)).join("");
  return undefined;
}

/** The language data (commentTokens, closeBrackets, wordChars) a configuration contributes. */
function languageData(config: HostLanguageConfiguration): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const comments = config.comments;
  if (comments?.lineComment || comments?.blockComment) {
    const block = comments.blockComment;
    data.commentTokens = { line: comments.lineComment, block: block ? { open: block[0], close: block[1] } : undefined };
  }
  const openings = [...(config.brackets ?? []).map(([open]) => open), ...(config.autoClosingPairs ?? []).map((pair) => pair.open)];
  if (openings.length) data.closeBrackets = { brackets: [...new Set(openings)], before: ")]}:;>" };
  const wordChars = wordCharsFromPattern(config.wordPattern);
  if (wordChars) data.wordChars = wordChars;
  return data;
}

/** VS Code `indentationRules`: indent after a matching line, outdent one matching it. */
function indentRules(config: HostLanguageConfiguration): Extension {
  const increase = compile(config.indentationRules?.increaseIndentPattern);
  const decrease = compile(config.indentationRules?.decreaseIndentPattern);
  if (!increase && !decrease) return [];
  return indentService.of((context, pos) => {
    const line = context.lineAt(pos, -1);
    const indent = context.lineIndent(line.from, -1);
    if (decrease?.test(line.text)) return Math.max(0, indent - context.unit);
    if (increase?.test(line.text)) return indent + context.unit;
    return undefined;
  });
}

type CompiledEnterRule = { beforeText: RegExp; afterText: RegExp | null; previousLineText: RegExp | null; action: HostOnEnterRule["action"] };

function compileEnterRules(rules: HostOnEnterRule[] | undefined): CompiledEnterRule[] {
  const out: CompiledEnterRule[] = [];
  for (const rule of rules ?? []) {
    const beforeText = compile(rule.beforeText);
    if (!beforeText) continue;
    out.push({ beforeText, afterText: compile(rule.afterText), previousLineText: compile(rule.previousLineText), action: rule.action });
  }
  return out;
}

/** The first `onEnterRule` matching the cursor's line (or null). */
function matchEnterRule(state: EditorState, from: number, to: number, rules: CompiledEnterRule[]): CompiledEnterRule | null {
  if (from !== to) return null;
  const line = state.doc.lineAt(from);
  const before = state.sliceDoc(line.from, from);
  const after = state.sliceDoc(to, line.to);
  const previous = line.number > 1 ? state.doc.line(line.number - 1).text : "";
  for (const rule of rules) {
    if (!rule.beforeText.test(before)) continue;
    if (rule.afterText && !rule.afterText.test(after)) continue;
    if (rule.previousLineText && !rule.previousLineText.test(previous)) continue;
    return rule;
  }
  return null;
}

/** Enter with the configuration's `onEnterRules`; falls back to insertNewlineAndIndent. */
function enterRules(config: HostLanguageConfiguration): Extension {
  const rules = compileEnterRules(config.onEnterRules);
  if (!rules.length) return [];
  return Prec.high(
    keymap.of([
      {
        key: "Enter",
        run: (view) => {
          const { state } = view;
          const change = state.changeByRange((range) => {
            const rule = matchEnterRule(state, range.from, range.to, rules);
            if (!rule) return { changes: [], range };
            const line = state.doc.lineAt(range.from);
            const current = countColumn(/^\s*/.exec(line.text)![0], state.tabSize);
            const unit = getIndentUnit(state) || state.tabSize;
            const { indentAction, appendText } = rule.action;
            let insert: string;
            if (indentAction === "indentOutdent") {
              insert = state.lineBreak + indentString(state, current + unit) + state.lineBreak + indentString(state, current);
            } else {
              const column = indentAction === "indent" ? current + unit : indentAction === "outdent" ? Math.max(0, current - unit) : current;
              insert = state.lineBreak + indentString(state, column);
            }
            if (appendText) insert += appendText;
            return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.cursor(range.from + insert.length) };
          });
          if (change.changes.empty) return false;
          view.dispatch(state.update(change, { scrollIntoView: true, userEvent: "input" }));
          return true;
        },
      },
    ]),
  );
}

/** CodeMirror extensions applying an extension's language configuration. */
export function languageConfigExtensions(config: HostLanguageConfiguration | null | undefined): Extension[] {
  if (!config) return [];
  const extensions: Extension[] = [];
  const data = languageData(config);
  // Higher precedence so the extension's comment tokens / brackets win over the parser's.
  if (Object.keys(data).length) extensions.push(Prec.high(EditorState.languageData.of(() => [data])));
  extensions.push(indentRules(config), enterRules(config));
  return extensions;
}
