import type { AreaSupport } from "./types.ts";

/** Support table changes of the "languages-extra" area. */
export const languagesExtraSupport: AreaSupport = {
  api: {
    "languages.registerCallHierarchyProvider": ["supported", "show Call Hierarchy panel (callers/callees), vscode.prepareCallHierarchy / provideIncomingCalls / provideOutgoingCalls"],
    "languages.registerTypeHierarchyProvider": ["supported", "show Type Hierarchy panel (supertypes/subtypes), vscode.prepareTypeHierarchy / provideSupertypes / provideSubtypes"],
    "languages.registerInlineValuesProvider": ["supported", "values are shown at the end of lines while a debug session is paused"],
    "languages.registerEvaluatableExpressionProvider": ["supported", "hover evaluates the expression in the paused frame; the word under the pointer is used without a provider"],
    "languages.registerDocumentDropEditProvider": ["partial", "the first edit is applied on drop (snippets, additionalEdit, yieldTo, mime filter); no drop-as picker; dropped OS files are sent as bytes without a path"],
    "languages.registerDocumentPasteEditProvider": ["partial", "the first edit is applied on paste (prepareDocumentPaste, resolve, snippets); 'Paste As…' lets you pick one; no paste widget"],
  },
  types: [
    "CallHierarchyItem", "TypeHierarchyItem", "CallHierarchyIncomingCall", "CallHierarchyOutgoingCall", "InlineValueText", "InlineValueVariableLookup",
    "InlineValueEvaluatableExpression", "EvaluatableExpression", "SnippetTextEdit", "DataTransferItem", "DataTransfer", "DocumentDropEdit", "DocumentPasteEdit",
    "DocumentDropOrPasteEditKind", "DocumentPasteTriggerKind", "SyntaxTokenType",
  ],
};
