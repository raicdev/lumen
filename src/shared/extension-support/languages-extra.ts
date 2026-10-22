import type { AreaSupport } from "./types.ts";

/** Support table changes of the "languages-extra" area. */
export const languagesExtraSupport: AreaSupport = {
  api: {
    "languages.registerCallHierarchyProvider": [
      "supported",
      "show Call Hierarchy panel (callers/callees), vscode.prepareCallHierarchy / provideIncomingCalls / provideOutgoingCalls",
    ],
    "languages.registerTypeHierarchyProvider": [
      "supported",
      "show Type Hierarchy panel (supertypes/subtypes), vscode.prepareTypeHierarchy / provideSupertypes / provideSubtypes",
    ],
    "languages.registerInlineValuesProvider": ["supported", "values are shown at the end of lines while a debug session is paused"],
    "languages.registerEvaluatableExpressionProvider": [
      "supported",
      "hover evaluates the expression in the paused frame; the word under the pointer is used without a provider",
    ],
    "languages.registerDocumentDropEditProvider": [
      "partial",
      "the first edit is applied on drop and a widget switches to the others (snippets, additionalEdit, yieldTo, mime filter, file URIs of dropped files); switching does not undo edits in other documents",
    ],
    "languages.registerDocumentPasteEditProvider": [
      "partial",
      "the first edit is applied on paste and a widget switches to the others; 'Paste As…' picks one (prepareDocumentPaste, resolve, snippets); switching does not undo edits in other documents",
    ],
  },
  types: [
    "CallHierarchyItem",
    "TypeHierarchyItem",
    "CallHierarchyIncomingCall",
    "CallHierarchyOutgoingCall",
    "InlineValueText",
    "InlineValueVariableLookup",
    "InlineValueEvaluatableExpression",
    "EvaluatableExpression",
    "SnippetTextEdit",
    "DataTransferItem",
    "DataTransfer",
    "DocumentDropEdit",
    "DocumentPasteEdit",
    "DocumentDropOrPasteEditKind",
    "DocumentPasteTriggerKind",
    "SyntaxTokenType",
  ],
};
