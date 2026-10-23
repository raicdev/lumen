import type { SupportLevel } from "./extensions.ts";
import { AREA_SUPPORT } from "./extension-support/index.ts";

/**
 * The `lumen` extension API surface, member by member, with how complete it is
 * compared to VS Code's `vscode` module. The transpiler's compatibility report
 * reads this table; the extension host test checks that every member listed
 * as supported / partial really exists on the API object.
 */

type Entry = SupportLevel | [SupportLevel, string];

/**
 * `vscode.version` as extensions see it: the latest stable VS Code, so runtime
 * version checks (e.g. vscode-languageclient's) pass. What Lumen actually lacks
 * is reported per extension from the table below (partial / limited), not by
 * holding this number back.
 */
export const API_VERSION = "1.142.0";

const BASE_API_SUPPORT: Record<string, Entry> = {
  /* commands */
  "commands.registerCommand": "supported",
  "commands.registerTextEditorCommand": "supported",
  "commands.executeCommand": ["supported", "built-in commands use Lumen's command ids (most match VS Code)"],
  "commands.getCommands": "supported",

  /* window */
  "window.showInformationMessage": "supported",
  "window.showWarningMessage": "supported",
  "window.showErrorMessage": "supported",
  "window.showQuickPick": "supported",
  "window.showInputBox": "supported",
  "window.createQuickPick": "supported",
  "window.createInputBox": "supported",
  "window.showOpenDialog": "supported",
  "window.showSaveDialog": "supported",
  "window.showWorkspaceFolderPick": "supported",
  "window.createStatusBarItem": "supported",
  "window.setStatusBarMessage": "supported",
  "window.createOutputChannel": "supported",
  "window.showTextDocument": "supported",
  "window.activeTextEditor": "supported",
  "window.visibleTextEditors": "supported",
  "window.onDidChangeActiveTextEditor": "supported",
  "window.onDidChangeVisibleTextEditors": "supported",
  "window.onDidChangeTextEditorSelection": "supported",
  "window.onDidChangeTextEditorVisibleRanges": "supported",
  "window.onDidChangeTextEditorOptions": ["supported", "tab size and insert spaces are Lumen's indentation settings"],
  "window.createTextEditorDecorationType": "supported",
  "window.withProgress": "supported",
  "window.terminals": "supported",
  "window.activeTerminal": "supported",
  "window.onDidOpenTerminal": "supported",
  "window.onDidCloseTerminal": "supported",
  "window.onDidChangeActiveTerminal": "supported",
  "window.state": "supported",
  "window.onDidChangeWindowState": "supported",
  "window.activeColorTheme": "supported",
  "window.onDidChangeActiveColorTheme": "supported",
  "window.registerFileDecorationProvider": ["supported", "badges, tooltips and colors in the explorer"],
  "window.createWebviewPanel": ["supported", "hidden pages are dropped unless retainContextWhenHidden; enableFindWidget adds the find bar (Ctrl+F, F3)"],
  "window.registerWebviewViewProvider": "supported",
  "window.registerWebviewPanelSerializer": "supported",
  "window.registerCustomEditorProvider": [
    "supported",
    "text, readonly and editable providers; supportsMultipleEditorsPerDocument; backups of unsaved changes come back as openContext.backupId",
  ],
  "window.registerTreeDataProvider": "supported",
  "window.createTreeView": "supported",
  "window.tabGroups": "supported",

  /* workspace */
  "workspace.workspaceFolders": "supported",
  "workspace.rootPath": "supported",
  "workspace.name": "supported",
  "workspace.workspaceFile": "supported",
  "workspace.getWorkspaceFolder": "supported",
  "workspace.asRelativePath": "supported",
  "workspace.onDidChangeWorkspaceFolders": "supported",
  "workspace.getConfiguration": "supported",
  "workspace.onDidChangeConfiguration": "supported",
  "workspace.textDocuments": "supported",
  "workspace.openTextDocument": "supported",
  "workspace.onDidOpenTextDocument": "supported",
  "workspace.onDidCloseTextDocument": "supported",
  "workspace.onDidChangeTextDocument": "supported",
  "workspace.onDidSaveTextDocument": "supported",
  "workspace.onWillSaveTextDocument": "supported",
  "workspace.saveAll": "supported",
  "workspace.save": "supported",
  "workspace.findFiles": "supported",
  "workspace.fs": "supported",
  "workspace.createFileSystemWatcher": "supported",
  "workspace.isTrusted": "supported",
  "workspace.onDidGrantWorkspaceTrust": "supported",
  "workspace.onDidCreateFiles": "supported",
  "workspace.onDidDeleteFiles": "supported",
  "workspace.onDidRenameFiles": "supported",
  "workspace.onWillCreateFiles": "supported",
  "workspace.onWillDeleteFiles": "supported",
  "workspace.onWillRenameFiles": "supported",
  "workspace.registerTextDocumentContentProvider": ["supported", "read-only virtual documents"],
  "workspace.registerFileSystemProvider": [
    "supported",
    "including isCaseSensitive providers (case-insensitive URIs share documents, tabs, explorer entries and watcher events)",
  ],

  /* languages */
  "languages.registerCompletionItemProvider": "supported",
  "languages.registerHoverProvider": "supported",
  "languages.registerDefinitionProvider": "supported",
  "languages.registerReferenceProvider": "supported",
  "languages.registerDocumentFormattingEditProvider": "supported",
  "languages.registerDocumentRangeFormattingEditProvider": "supported",
  "languages.registerDocumentSymbolProvider": "supported",
  "languages.createDiagnosticCollection": "supported",
  "languages.getDiagnostics": "supported",
  "languages.onDidChangeDiagnostics": "supported",
  "languages.getLanguages": "supported",
  "languages.setTextDocumentLanguage": "supported",
  "languages.match": "supported",
  "languages.setLanguageConfiguration": ["supported", "comments, brackets, auto-closing pairs, word pattern, indentation and onEnter rules"],
  "languages.createLanguageStatusItem": ["supported", "shown in the status bar"],
  "languages.registerCodeActionsProvider": "supported",
  "languages.registerCodeLensProvider": "supported",
  "languages.registerSignatureHelpProvider": "supported",
  "languages.registerRenameProvider": "supported",
  "languages.registerDocumentHighlightProvider": "supported",
  "languages.registerFoldingRangeProvider": "supported",
  "languages.registerInlayHintsProvider": "supported",
  "languages.registerDocumentSemanticTokensProvider": "supported",
  "languages.registerDocumentRangeSemanticTokensProvider": "supported",
  "languages.registerColorProvider": "supported",
  "languages.registerDocumentLinkProvider": "supported",
  "languages.registerOnTypeFormattingEditProvider": ["supported", "when editor.formatOnType is on"],
  "languages.registerInlineCompletionItemProvider": "supported",
  "languages.registerTypeDefinitionProvider": "supported",
  "languages.registerImplementationProvider": "supported",
  "languages.registerDeclarationProvider": "supported",
  "languages.registerWorkspaceSymbolProvider": "supported",
  "languages.registerSelectionRangeProvider": "supported",
  "languages.registerLinkedEditingRangeProvider": "supported",

  /* env */
  "env.appName": "supported",
  "env.appRoot": "supported",
  "env.appHost": "supported",
  "env.language": "supported",
  "env.machineId": "supported",
  "env.sessionId": "supported",
  "env.uriScheme": "supported",
  "env.uiKind": "supported",
  "env.remoteName": "supported",
  "env.shell": "supported",
  "env.clipboard": "supported",
  "env.openExternal": ["supported", "http(s) and mailto links"],
  "env.asExternalUri": "supported",
  "env.isTelemetryEnabled": "supported",
  "env.onDidChangeTelemetryEnabled": "supported",
  "env.createTelemetryLogger": ["supported", "telemetry is off, so nothing is sent"],
  "env.logLevel": "supported",
  "env.onDidChangeLogLevel": "supported",
  "env.isNewAppInstall": "supported",
  "env.onDidChangeShell": "supported",

  /* extensions */
  "extensions.getExtension": "supported",
  "extensions.all": "supported",
  "extensions.onDidChange": "supported",

  /* l10n */
  "l10n.t": "supported",
  "l10n.bundle": "supported",
  "l10n.uri": "supported",

  /* debug */
  "debug.activeDebugSession": "supported",
  "debug.activeDebugConsole": "supported",
  "debug.activeStackItem": "supported",
  "debug.breakpoints": "supported",
  "debug.onDidChangeActiveDebugSession": "supported",
  "debug.onDidStartDebugSession": "supported",
  "debug.onDidReceiveDebugSessionCustomEvent": "supported",
  "debug.onDidTerminateDebugSession": "supported",
  "debug.onDidChangeBreakpoints": "supported",
  "debug.onDidChangeActiveStackItem": "supported",
  "debug.registerDebugConfigurationProvider": "supported",
  "debug.registerDebugAdapterDescriptorFactory": "supported",
  "debug.registerDebugAdapterTrackerFactory": "supported",
  "debug.startDebugging": ["supported", "launch.json configurations, provider configurations and default configurations for the active file's language"],
  "debug.stopDebugging": "supported",
  "debug.addBreakpoints": "supported",
  "debug.removeBreakpoints": "supported",
  "debug.asDebugSourceUri": ["partial", "sources with a path map to a file URI; others get a debug: URI that Lumen cannot open (no debug: content provider)"],
};

/** Classes, enums and helpers exported at the top level of the module. */
const BASE_API_TYPES = [
  "Uri",
  "Position",
  "Range",
  "Selection",
  "Location",
  "Diagnostic",
  "DiagnosticSeverity",
  "DiagnosticTag",
  "DiagnosticRelatedInformation",
  "TextEdit",
  "WorkspaceEdit",
  "SnippetString",
  "MarkdownString",
  "CompletionItem",
  "CompletionItemKind",
  "CompletionItemTag",
  "CompletionList",
  "CompletionTriggerKind",
  "Hover",
  "DocumentSymbol",
  "SymbolInformation",
  "SymbolKind",
  "SymbolTag",
  "ThemeColor",
  "ThemeIcon",
  "StatusBarAlignment",
  "ViewColumn",
  "EndOfLine",
  "TextEditorRevealType",
  "TextEditorCursorStyle",
  "TextEditorLineNumbersStyle",
  "TextEditorSelectionChangeKind",
  "ConfigurationTarget",
  "Disposable",
  "EventEmitter",
  "CancellationTokenSource",
  "CancellationError",
  "ProgressLocation",
  "FileType",
  "FileSystemError",
  "FileChangeType",
  "RelativePattern",
  "DecorationRangeBehavior",
  "OverviewRulerLane",
  "TextDocumentSaveReason",
  "TextDocumentChangeReason",
  "QuickPickItemKind",
  "QuickInputButtons",
  "ExtensionMode",
  "ExtensionKind",
  "UIKind",
  "LogLevel",
  "ColorThemeKind",
  "CodeActionKind",
  "CodeAction",
  "CodeActionTriggerKind",
  "CodeLens",
  "FoldingRange",
  "FoldingRangeKind",
  "SignatureHelp",
  "SignatureInformation",
  "ParameterInformation",
  "DocumentLink",
  "DocumentHighlight",
  "DocumentHighlightKind",
  "Color",
  "ColorInformation",
  "ColorPresentation",
  "InlayHint",
  "InlayHintKind",
  "InlayHintLabelPart",
  "SemanticTokensLegend",
  "SemanticTokensBuilder",
  "SemanticTokens",
  "IndentAction",
  "LanguageStatusSeverity",
  "TreeItem",
  "TreeItemCollapsibleState",
  "TreeItemCheckboxState",
  "InlineCompletionItem",
  "InlineCompletionList",
  "InlineCompletionTriggerKind",
  "FileDecoration",
  "SemanticTokensEdit",
  "SemanticTokensEdits",
  "SelectionRange",
  "LinkedEditingRanges",
  "SignatureHelpTriggerKind",
  "EnvironmentVariableMutatorType",
  "TerminalExitReason",
  "TerminalLocation",
  "DebugConfigurationProviderTriggerKind",
  "DebugConsoleMode",
  "Breakpoint",
  "SourceBreakpoint",
  "FunctionBreakpoint",
  "DebugAdapterExecutable",
  "DebugAdapterServer",
  "DebugAdapterNamedPipeServer",
  "DebugAdapterInlineImplementation",
  "DebugThread",
  "DebugStackFrame",
  "TabInputText",
  "TabInputTextDiff",
  "TabInputCustom",
  "TabInputWebview",
  "TabInputTerminal",
];

/**
 * Classes and enums that are data-only stand-ins (editor tab input types, …),
 * exported so libraries that reference them (vscode-languageclient, …) still load.
 */
const BASE_API_TYPES_COMPAT: string[] = [];

/**
 * Classes and enums of the `vscode` module that Lumen does not export at all:
 * the compatibility report flags extensions that use them (`new X()` throws).
 */
const BASE_API_TYPES_MISSING: string[] = [];

export function supportOf(member: string): { status: SupportLevel; note?: string } | null {
  const entry = API_SUPPORT[member] ?? API_SUPPORT[`${member.split(".")[0]}.*`];
  if (!entry) return null;
  return typeof entry === "string" ? { status: entry } : { status: entry[0], note: entry[1] };
}

/** Contribution points of package.json and how far Lumen honours them. */
const BASE_CONTRIBUTION_SUPPORT: Record<string, Entry> = {
  commands: "supported",
  keybindings: "supported",
  configuration: "supported",
  languages: ["supported", "the icon field is not used (Lumen draws its own file icons)"],
  snippets: "supported",
  configurationDefaults: [
    "partial",
    'extension settings and the defaults of Lumen\'s own settings (below user settings); language-scoped defaults ("[python]") are not applied in the editor yet',
  ],
  codeActions: ["partial", "metadata only: code actions come from registered providers; not used for codeActionsOnSave completion"],
  documentation: ["partial", "ignored: refactorings work, but the refactor menu shows no documentation entries"],
  grammars: [
    "partial",
    "highlighting for languages CodeMirror has no built-in support for, in Lumen's theme; no embedded-language highlighting or TextMate themes",
  ],
  themes: "supported",
  views: "supported",
  viewsContainers: "supported",
  viewsWelcome: "supported",
  debuggers: [
    "partial",
    "type, label, program/runtime/args (with platform overrides), languages and initialConfigurations; the adapter runs when no descriptor factory is registered; variables, configurationSnippets, configurationAttributes (launch.json IntelliSense), when and hiddenWhen are not used",
  ],
  breakpoints: [
    "partial",
    "enablement, conditions, hit counts and log points are sent to the adapter; breakpoints can be set in any file (the declared languages and when clauses are not used)",
  ],
  jsonValidation: "supported",
  customEditors: "supported",
  // Points of the Java extensions: redhat.java and the Java pack read them from extensions.all[].packageJSON.
  javaExtensions: ["supported", "read by the Language Support for Java extension (redhat.java), not by Lumen"],
  javaShortcuts: ["supported", "read by the Language Support for Java extension (redhat.java), not by Lumen"],
  javaBuildFilePatterns: ["supported", "read by the Language Support for Java extension (redhat.java), not by Lumen"],
  javaBuildTools: ["supported", "read by the Language Support for Java extension (redhat.java), not by Lumen"],
};

/* -- the tables with what the feature areas changed (shared/extension-support/<area>.ts) -- */

/** Applies the areas' entries (`null` removes one) over a table. */
function withAreas(
  base: Record<string, Entry>,
  pick: (area: (typeof AREA_SUPPORT)[number]) => Record<string, Entry | null> | undefined,
): Record<string, Entry> {
  const out = { ...base };
  for (const area of AREA_SUPPORT) {
    for (const [key, entry] of Object.entries(pick(area) ?? {})) {
      if (entry === null) delete out[key];
      else out[key] = entry;
    }
  }
  return out;
}

/** Types the feature areas export: they move to API_TYPES and leave API_TYPES_COMPAT / API_TYPES_MISSING. */
const AREA_TYPES = new Set(AREA_SUPPORT.flatMap((area) => area.types ?? []));

export const API_SUPPORT: Record<string, Entry> = withAreas(BASE_API_SUPPORT, (area) => area.api);
export const API_TYPES = [...new Set([...BASE_API_TYPES, ...AREA_TYPES])];
export const API_TYPES_COMPAT = BASE_API_TYPES_COMPAT.filter((type) => !AREA_TYPES.has(type));
export const API_TYPES_MISSING = BASE_API_TYPES_MISSING.filter((type) => !AREA_TYPES.has(type));
export const CONTRIBUTION_SUPPORT: Record<string, Entry> = withAreas(BASE_CONTRIBUTION_SUPPORT, (area) => area.contributions);
