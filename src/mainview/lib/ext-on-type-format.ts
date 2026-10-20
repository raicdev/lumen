import type { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { TextEdit } from "../../shared/types";
import { extensionService } from "./extensions";
import { getSettings } from "./settings";
import { offsetOf } from "./text-edits";

/**
 * On-type formatting from extensions
 * (languages.registerOnTypeFormattingEditProvider): after the user types one
 * of a provider's trigger characters, its edits are applied as one undoable
 * change. Like VS Code this is off unless `editor.formatOnType` is on.
 */

/** The document formatting is asked for (null when no editor document is shown). */
export type OnTypeFormattingSource = () => { path: string; language: string } | null;

/** Apply TextEdits (positions refer to the current text) as one change. */
function applyEdits(view: EditorView, edits: TextEdit[]): void {
  if (!edits.length) return;
  const text = view.state.doc.toString();
  const changes = edits.map((edit) => ({
    from: offsetOf(text, edit.startLine, edit.startCharacter),
    to: offsetOf(text, edit.endLine, edit.endCharacter),
    insert: edit.newText,
  }));
  const changeSet = view.state.changes(changes);
  // A cursor where text is inserted ends up after it, like in VS Code.
  const selection = view.state.selection.ranges.every((range) => range.empty) ? view.state.selection.map(changeSet, 1) : undefined;
  view.dispatch({ changes: changeSet, selection, userEvent: "input.formatOnType" });
}

export function onTypeFormattingExtension(source: OnTypeFormattingSource): Extension {
  return ViewPlugin.fromClass(
    class {
      readonly view: EditorView;
      /** The text the pending request was made against. */
      pending: string | null = null;

      constructor(view: EditorView) {
        this.view = view;
      }

      update(update: ViewUpdate) {
        if (!update.docChanged) return;
        if (!getSettings()["editor.formatOnType"]) return;
        // Only what the user typed; formatting our own edits must not loop.
        if (!update.transactions.some((tr) => tr.isUserEvent("input.type"))) return;
        const target = source();
        if (!target) return;
        const providers = extensionService.providersFor("onTypeFormatting", target.path, target.language);
        if (!providers.length) return;
        const triggers = new Set<string>();
        for (const provider of providers) for (const character of provider.triggerCharacters ?? []) triggers.add(character);
        if (!triggers.size) return;
        // The last trigger character typed in this update.
        let trigger = "";
        update.transactions.forEach((tr) =>
          tr.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
            const text = inserted.toString();
            const last = text[text.length - 1];
            if (last && triggers.has(last)) trigger = last;
          }),
        );
        if (!trigger) return;
        const head = update.state.selection.main.head;
        const line = update.state.doc.lineAt(head);
        const text = update.state.doc.toString();
        const settings = getSettings();
        this.pending = text;
        void extensionService
          .call("provideOnTypeFormatting", target.path, line.number - 1, head - line.from, trigger, {
            tabSize: settings["editor.tabSize"],
            insertSpaces: settings["editor.insertSpaces"],
          })
          .then((edits) => {
            // Anything typed or changed while the provider ran makes the positions stale.
            if (this.pending !== text || this.view.state.doc.toString() !== text) return;
            const current = source();
            if (!current || current.path !== target.path) return;
            applyEdits(this.view, edits);
          })
          .catch(() => {});
      }
    },
  );
}
