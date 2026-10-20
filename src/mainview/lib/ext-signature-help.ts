import { StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, showTooltip, type ViewUpdate } from "@codemirror/view";
import type { HostSignature, HostSignatureHelp } from "../../shared/extensions";
import { extensionService } from "./extensions";
import { renderMarkdown } from "./markdown";

/**
 * Signature help from extensions (languages.registerSignatureHelpProvider):
 * a tooltip above the cursor with the active signature (its active parameter
 * in bold), its documentation and "1/3" when there are several. It opens on a
 * trigger character or Ctrl+Shift+Space (editor.action.triggerParameterHints),
 * and closes on Escape, on ")" or when the cursor leaves the call.
 */

type ActiveHelp = { help: HostSignatureHelp; pos: number; open: number };

const setSignatureHelp = StateEffect.define<ActiveHelp | null>();

/** Offset of the '(' that starts the call around `pos` (the innermost), or -1. */
function callOpen(doc: Text, pos: number): number {
  let depth = 0;
  for (let i = pos - 1; i >= 0; i--) {
    const ch = doc.sliceString(i, i + 1);
    if (ch === ")") depth++;
    else if (ch === "(") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

/** The span of the call opened at `open`: to its matching ')' (or the line's end). */
function callRange(doc: Text, open: number): { from: number; to: number } | null {
  if (open < 0 || open >= doc.length || doc.sliceString(open, open + 1) !== "(") return null;
  let depth = 0;
  for (let i = open; i < doc.length; i++) {
    const ch = doc.sliceString(i, i + 1);
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return { from: open, to: i };
  }
  return { from: open, to: doc.lineAt(open).to };
}

const signatureHelpField = StateField.define<ActiveHelp | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setSignatureHelp)) return effect.value;
    if (!value) return null;
    if (tr.docChanged) {
      // Typing ")" closes the tooltip, like VS Code.
      let closed = false;
      tr.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
        if (inserted.toString().includes(")")) closed = true;
      });
      if (closed) return null;
      value = {
        help: value.help,
        pos: tr.changes.mapPos(value.pos, 1),
        open: value.open < 0 ? -1 : tr.changes.mapPos(value.open, -1),
      };
    }
    // Moving the cursor outside the call closes it.
    if (tr.selection && value.open >= 0) {
      const head = tr.state.selection.main.head;
      const range = callRange(tr.state.doc, value.open);
      if (!range || head < range.from || head > range.to) return null;
    }
    return value;
  },
});

/** The active parameter's character range inside the signature label. */
function parameterRange(signature: HostSignature, index: number): { start: number; end: number } | null {
  const parameter = signature.parameters[index];
  if (!parameter) return null;
  if (Array.isArray(parameter.label)) return { start: parameter.label[0], end: parameter.label[1] };
  const start = signature.label.indexOf(parameter.label);
  return start < 0 ? null : { start, end: start + parameter.label.length };
}

function createSignatureDom(help: HostSignatureHelp): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "cm-ext-signature";
  const index = Math.min(Math.max(0, help.activeSignature), help.signatures.length - 1);
  const signature = help.signatures[index]!;
  const active = Math.min(Math.max(0, help.activeParameter), Math.max(0, signature.parameters.length - 1));

  const header = document.createElement("div");
  header.className = "cm-ext-signature-label";
  const label = document.createElement("span");
  const range = parameterRange(signature, active);
  if (range && range.start >= 0 && range.end > range.start && range.end <= signature.label.length) {
    const strong = document.createElement("strong");
    strong.textContent = signature.label.slice(range.start, range.end);
    label.appendChild(document.createTextNode(signature.label.slice(0, range.start)));
    label.appendChild(strong);
    label.appendChild(document.createTextNode(signature.label.slice(range.end)));
  } else {
    label.textContent = signature.label;
  }
  header.appendChild(label);
  if (help.signatures.length > 1) {
    const counter = document.createElement("span");
    counter.className = "cm-ext-signature-index";
    counter.textContent = `${index + 1}/${help.signatures.length}`;
    header.appendChild(counter);
  }
  dom.appendChild(header);

  const parts = [signature.documentation, signature.parameters[active]?.documentation].filter((part): part is string => !!part);
  if (parts.length) {
    const documentation = document.createElement("div");
    documentation.className = "cm-ext-signature-doc markdown-body";
    documentation.innerHTML = renderMarkdown(parts.join("\n\n"));
    dom.appendChild(documentation);
  }
  return dom;
}

/** The document signature help is asked for (null when no editor document is shown). */
export type SignatureHelpSource = () => { path: string; language: string } | null;

/** Sequence per editor: a late answer of an older request must not show. */
const sequences = new WeakMap<EditorView, number>();

/** Ask the extensions for signature help and show (or clear) the tooltip. */
export async function requestSignatureHelp(view: EditorView, source: SignatureHelpSource, triggerCharacter: string | null): Promise<void> {
  const target = source();
  if (!target) return;
  if (!extensionService.providersFor("signatureHelp", target.path, target.language).length) return;
  const id = (sequences.get(view) ?? 0) + 1;
  sequences.set(view, id);
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  let help: HostSignatureHelp | null;
  try {
    help = await extensionService.call("provideSignatureHelp", target.path, line.number - 1, head - line.from, triggerCharacter);
  } catch {
    return;
  }
  if (sequences.get(view) !== id || !view.dom.isConnected) return;
  const current = source();
  if (!current || current.path !== target.path) return;
  const pos = view.state.selection.main.head;
  view.dispatch({ effects: setSignatureHelp.of(help?.signatures.length ? { help, pos, open: callOpen(view.state.doc, pos) } : null) });
}

/** Close the signature help tooltip, if one is shown. */
export function closeSignatureHelp(view: EditorView | null): void {
  if (view?.state.field(signatureHelpField)) view.dispatch({ effects: setSignatureHelp.of(null) });
}

export function signatureHelpExtension(source: SignatureHelpSource): Extension {
  return [
    signatureHelpField,
    showTooltip.compute([signatureHelpField], (state) => {
      const active = state.field(signatureHelpField);
      if (!active || !active.help.signatures.length) return null;
      return { pos: active.pos, above: true, create: () => ({ dom: createSignatureDom(active.help) }) };
    }),
    keymap.of([
      {
        key: "Escape",
        run: (view) => {
          if (!view.state.field(signatureHelpField)) return false;
          view.dispatch({ effects: setSignatureHelp.of(null) });
          return true;
        },
      },
    ]),
    ViewPlugin.fromClass(
      class {
        readonly view: EditorView;
        constructor(view: EditorView) {
          this.view = view;
        }
        update(update: ViewUpdate) {
          if (!update.docChanged) return;
          const target = source();
          if (!target) return;
          const triggers = new Set<string>();
          for (const provider of extensionService.providersFor("signatureHelp", target.path, target.language)) {
            for (const character of provider.triggerCharacters ?? []) triggers.add(character);
          }
          if (!triggers.size) return;
          // Retrigger when one of the providers' trigger characters was typed.
          let trigger = "";
          update.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
            const text = inserted.toString();
            const last = text[text.length - 1];
            if (last && triggers.has(last)) trigger = last;
          });
          if (trigger) void requestSignatureHelp(this.view, source, trigger);
        }
      },
    ),
  ];
}
