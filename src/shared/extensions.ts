import type { Diagnostic, DocumentSymbol, FileEdits, FileEntry, SearchMatch, TextEdit, TextRange } from "./types.ts";
import type { ColorThemeKind } from "./color-theme.ts";

/**
 * Extensions: the manifest format (a VS Code compatible `package.json`), what
 * the extension manager knows about an installed extension, and the messages
 * the extension host exchanges with the view (relayed by the main process).
 */

export type CommandContribution = {
  command: string;
  title: string | { value: string; original?: string };
  category?: string | { value: string; original?: string };
  icon?: unknown;
  enablement?: string;
};

export type KeybindingContribution = {
  command: string;
  key?: string;
  mac?: string;
  linux?: string;
  win?: string;
  when?: string;
  args?: unknown;
};

export type ConfigurationProperty = {
  type?: string | string[];
  default?: unknown;
  description?: string;
  markdownDescription?: string;
  enum?: unknown[];
  enumDescriptions?: string[];
  minimum?: number;
  maximum?: number;
  scope?: string;
  order?: number;
  deprecationMessage?: string;
  markdownDeprecationMessage?: string;
};

export type ConfigurationContribution = {
  title?: string;
  order?: number;
  properties?: Record<string, ConfigurationProperty>;
};

export type MenuContribution = { command: string; when?: string; group?: string; alt?: string };

export type LanguageContribution = {
  id: string;
  aliases?: string[];
  extensions?: string[];
  filenames?: string[];
  filenamePatterns?: string[];
  firstLine?: string;
  configuration?: string;
};

export type SnippetContribution = { language?: string; path: string };

/** contributes.customEditors: a file the extension shows in a custom editor. */
export type CustomEditorContribution = {
  extensionId: string;
  viewType: string;
  displayName: string;
  /** "default" opens matching files with this editor; "option" only through "Reopen Editor With…". */
  priority: "default" | "option";
  selector: HostDocumentFilter[];
};

export type Contributes = {
  commands?: CommandContribution | CommandContribution[];
  keybindings?: KeybindingContribution | KeybindingContribution[];
  configuration?: ConfigurationContribution | ConfigurationContribution[];
  menus?: Record<string, MenuContribution[]>;
  languages?: LanguageContribution[];
  snippets?: SnippetContribution[];
  [point: string]: unknown;
};

export type ExtensionManifest = {
  name: string;
  publisher?: string;
  version: string;
  displayName?: string;
  description?: string;
  main?: string;
  browser?: string;
  icon?: string;
  categories?: string[];
  keywords?: string[];
  license?: string;
  repository?: string | { type?: string; url?: string };
  homepage?: string;
  engines?: { lumen?: string; vscode?: string; [engine: string]: string | undefined };
  activationEvents?: string[];
  extensionDependencies?: string[];
  extensionPack?: string[];
  extensionKind?: string[];
  contributes?: Contributes;
  /** Written by the transpiler (VS Code → Lumen). */
  lumen?: { transpiledFrom?: "vscode"; vscodeEngine?: string; transpilerVersion?: number; transpiledAt?: string };
  [field: string]: unknown;
};

export type SupportLevel = "supported" | "partial" | "unsupported";

/** What the transpiler found out about a VS Code extension. */
export type CompatReport = {
  transpilerVersion: number;
  /** `require("vscode")` / `import … from "vscode"` sites rewritten to "lumen". */
  rewrittenImports: number;
  filesScanned: number;
  filesRewritten: number;
  /** API members the code uses, e.g. `window.showQuickPick`. */
  apis: { name: string; status: SupportLevel; count: number; note?: string }[];
  contributions: { name: string; status: SupportLevel; note?: string }[];
  warnings: string[];
  /** Summary: everything used is supported / some features missing / core features missing / nothing it uses works. */
  level: "full" | "partial" | "limited" | "unsupported";
  /** Share (0–100) of the distinct APIs and contribution points it uses that work in Lumen; partial ones count half. */
  coverage?: number;
  /** With level "partial": how much of it works, by coverage (high: most of it, medium: about half, low: little). */
  partialGrade?: PartialGrade;
};

export type PartialGrade = "high" | "medium" | "low";

export type ExtensionSource = { type: "openvsx"; namespace: string; name: string } | { type: "vsix"; file: string } | { type: "folder"; path: string };

export type ExtensionDescription = {
  /** `publisher.name` */
  id: string;
  manifest: ExtensionManifest;
  /** Absolute folder of the extension. */
  location: string;
  enabled: boolean;
  /** "vscode": converted from a VS Code extension (or loaded through the compatibility layer). */
  kind: "lumen" | "vscode";
  /** Loaded from a folder in place (Developer: Install Extension from Location…). */
  development: boolean;
  source?: ExtensionSource;
  compat?: CompatReport;
  installedAt?: number;
  /** Data URL of the icon, filled in for the Extensions view. */
  iconUrl?: string;
  /** Data URLs of the icons of contributed view containers (activity bar), by container id. */
  containerIcons?: Record<string, string>;
  /** Data URLs of contributed commands' icon files (view toolbars), by command; codicons stay in the manifest. */
  commandIcons?: Record<string, string>;
};

export type MarketplaceExtension = {
  namespace: string;
  name: string;
  version: string;
  displayName?: string;
  description?: string;
  publisher?: string;
  iconUrl?: string;
  downloadCount?: number;
  averageRating?: number;
  verified?: boolean;
  timestamp?: string;
};

/** What the details page shows of an extension that is not installed (from Open VSX). */
export type MarketplaceDetails = {
  readme: string | null;
  changelog?: string | null;
  /** The package.json as published (Features tab). */
  manifest?: ExtensionManifest;
  license?: string;
  repository?: string;
  homepage?: string;
  categories?: string[];
  tags?: string[];
  timestamp?: string;
  error?: string;
};

/** Compatibility of a package analyzed without installing it. */
export type MarketplaceCompat = {
  kind?: "lumen" | "vscode";
  report?: CompatReport;
  vscodeEngine?: string;
  /** When the package was analyzed (ms since epoch); older than now when the result came from the cache. */
  analyzedAt?: number;
  cached?: boolean;
  error?: string;
};

/* ── extension host protocol ──────────────────────────────────────────────── */

export type HostSelection = { anchorLine: number; anchorCharacter: number; activeLine: number; activeCharacter: number };

export type HostDocumentData = {
  /** File path, or `untitled:Name`. */
  path: string;
  languageId: string;
  version: number;
  text: string;
  eol: "LF" | "CRLF";
  dirty: boolean;
};

export type HostContentChange = TextRange & { text: string; rangeOffset: number; rangeLength: number };

export type ConfigSnapshot = {
  /** Lumen's own settings (editor.fontSize, …). */
  lumen: Record<string, unknown>;
  /** Values the user set for extension settings. */
  user: Record<string, unknown>;
};

/** A document filter as sent to the view (VS Code DocumentSelector entries). */
export type HostDocumentFilter = { language?: string; scheme?: string; pattern?: string };

export type ProviderKind =
  | "completion"
  | "hover"
  | "definition"
  | "formatting"
  | "rangeFormatting"
  | "documentSymbol"
  | "references"
  | "codeAction"
  | "codeLens"
  | "signatureHelp"
  | "rename"
  | "documentHighlight"
  | "foldingRange"
  | "inlayHints"
  | "semanticTokens"
  | "rangeSemanticTokens"
  | "color"
  | "documentLink"
  | "onTypeFormatting"
  | "inlineCompletion"
  | "typeDefinition"
  | "implementation"
  | "declaration"
  | "workspaceSymbol"
  | "selectionRange"
  | "callHierarchy"
  | "linkedEditingRange";

export type HostProvider = {
  id: number;
  kind: ProviderKind;
  extensionId: string;
  selector: HostDocumentFilter[];
  triggerCharacters?: string[];
};

export type HostCompletionItem = {
  label: string;
  detail?: string;
  documentation?: string;
  kind?: string;
  /** Plain text, or a VS Code snippet when `snippet` is set. */
  insertText: string;
  snippet?: boolean;
  /** Replaced range (defaults to the word before the cursor). */
  range?: TextRange;
  sortText?: string;
  filterText?: string;
  preselect?: boolean;
  /** Runs after the item was inserted. */
  command?: { command: string; arguments?: unknown[] };
  additionalTextEdits?: TextEdit[];
};

export type HostHover = { contents: string[]; range?: TextRange };

/** One inline completion (languages.registerInlineCompletionItemProvider). */
export type HostInlineCompletionItem = {
  /** Plain text; a VS Code SnippetString is sent as its value. */
  insertText: string;
  /** The text the completion replaces (defaults to the cursor). */
  range?: TextRange;
  /** Runs after the completion was inserted. */
  command?: { command: string; arguments?: unknown[] };
};

/** An inlay hint (languages.registerInlayHintsProvider). */
export type HostInlayHint = {
  line: number;
  character: number;
  label: string;
  tooltip?: string;
  paddingLeft?: boolean;
  paddingRight?: boolean;
  kind?: "type" | "parameter";
};

/** One decoded semantic token (languages.registerDocumentSemanticTokensProvider). */
export type HostSemanticToken = {
  line: number;
  character: number;
  length: number;
  type: string;
  modifiers: string[];
};

/** A code lens shown above a line (languages.registerCodeLensProvider). */
export type HostCodeLens = { id: string; line: number; title: string; tooltip?: string };

/** A code action (languages.registerCodeActionsProvider); its edit stays in the host. */
export type HostCodeAction = {
  id: string;
  title: string;
  /** CodeActionKind, e.g. "quickfix", "refactor.extract". */
  kind?: string;
  isPreferred?: boolean;
  disabled?: boolean;
  /** CodeAction.disabled.reason. */
  disabledReason?: string;
};

/** A folding range from an extension (languages.registerFoldingRangeProvider); 0-based lines. */
export type HostFoldingRange = { start: number; end: number; kind?: "comment" | "imports" | "region" };

/** One parameter of a signature: a plain label, or a range into the signature's label. */
export type HostSignatureParameter = { label: string | [number, number]; documentation?: string };

export type HostSignature = { label: string; documentation?: string; parameters: HostSignatureParameter[] };

export type HostSignatureHelp = { signatures: HostSignature[]; activeSignature: number; activeParameter: number };

export type HostLocation = { path: string; line: number; character: number; endLine?: number; endCharacter?: number };

/** A document highlight (languages.registerDocumentHighlightProvider). */
export type HostDocumentHighlight = { range: TextRange; kind: "text" | "read" | "write" };

/** A result of a workspace symbol provider (languages.registerWorkspaceSymbolProvider). */
export type HostWorkspaceSymbol = {
  /** Handle used by resolveWorkspaceSymbol. */
  id: number;
  name: string;
  kind: string;
  containerName?: string;
  /** The file the symbol is in. */
  path: string;
  /** Where to jump; absent when the provider only reported the file (resolve it when picked). */
  line?: number;
  character?: number;
  endLine?: number;
  endCharacter?: number;
};

/** The ranges that mirror each other around a position (languages.registerLinkedEditingRangeProvider). */
export type HostLinkedEditingRanges = { ranges: TextRange[]; wordPattern?: { source: string; flags: string } };

/** A link in a document (languages.registerDocumentLinkProvider); `target` is missing until it is resolved. */
export type HostDocumentLink = { range: TextRange; target?: string; tooltip?: string };

/** A colour found in a document (languages.registerColorProvider). */
export type HostColor = { red: number; green: number; blue: number; alpha: number };

export type HostColorInformation = { range: TextRange; color: HostColor };

/** One way of writing a colour (the label, and the edit that replaces its range). */
export type HostColorPresentation = { label: string; textEdit?: TextEdit };

/** A rename provider's prepareRename result (or the error it threw). */
export type HostPrepareRename = { range: TextRange; placeholder: string } | { error: string } | null;

/** A rename provider's WorkspaceEdit, converted to per-file text edits (or the error it threw). */
export type HostRenameEdits = { edits: FileEdits[] } | { error: string } | null;

export type HostStatusBarItem = {
  id: string;
  extensionId: string;
  text: string;
  /** A plain string, or a MarkdownString as `{ markdown }`. */
  tooltip?: string | { markdown: string };
  command?: { command: string; arguments?: unknown[] };
  alignment: "left" | "right";
  priority: number;
  color?: string;
  backgroundColor?: string;
  visible: boolean;
};

/** The before / after text of a decoration (ThemableDecorationAttachmentRenderOptions). */
export type HostDecorationAttachment = {
  contentText?: string;
  /** The content icon as data URLs (both set to the same URL for one image). */
  contentIcon?: { light?: string; dark?: string };
  border?: string;
  borderColor?: string;
  textDecoration?: string;
  color?: string;
  backgroundColor?: string;
  margin?: string;
  width?: string;
  height?: string;
  fontStyle?: string;
  fontWeight?: string;
};

export type HostDecorationStyle = {
  backgroundColor?: string;
  color?: string;
  border?: string;
  borderColor?: string;
  borderStyle?: string;
  borderWidth?: string;
  borderSpacing?: string;
  borderRadius?: string;
  outline?: string;
  outlineColor?: string;
  outlineStyle?: string;
  outlineWidth?: string;
  fontWeight?: string;
  fontStyle?: string;
  textDecoration?: string;
  opacity?: string;
  cursor?: string;
  letterSpacing?: string;
  overviewRulerColor?: string;
  before?: HostDecorationAttachment;
  after?: HostDecorationAttachment;
};

export type HostDecorationType = HostDecorationStyle & {
  isWholeLine?: boolean;
  /** DecorationRangeBehavior: OpenOpen 0 (default), ClosedClosed 1, OpenClosed 2, ClosedOpen 3. */
  rangeBehavior?: number;
  /** The style of light themes: the base options merged with the `light` options. */
  light?: HostDecorationStyle;
  /** The style of dark themes: the base options merged with the `dark` options. */
  dark?: HostDecorationStyle;
  /** The gutter icon as data URLs, loaded by the host (light / dark variants). */
  gutterIcon?: { light?: string; dark?: string };
  gutterIconSize?: string;
  overviewRulerLane?: number;
};

/** One range's own before / after attachments (ThemableDecorationInstanceRenderOptions). */
export type HostDecorationInstanceRenderOptions = {
  before?: HostDecorationAttachment;
  after?: HostDecorationAttachment;
};

/** DecorationOptions.renderOptions, with the light / dark variants as the extension gave them. */
export type HostDecorationRenderOptions = HostDecorationInstanceRenderOptions & {
  light?: HostDecorationInstanceRenderOptions;
  dark?: HostDecorationInstanceRenderOptions;
};

export type HostDecoration = TextRange & { hover?: string; renderOptions?: HostDecorationRenderOptions };

/** A file decoration from a FileDecorationProvider (window.registerFileDecorationProvider). */
export type HostFileDecoration = {
  /** Up to two characters, shown on the right of the file. */
  badge?: string;
  tooltip?: string;
  /** A theme color id (e.g. "gitDecoration.modifiedResourceForeground"). */
  color?: string;
  /** The decoration applies to a folder's children too. */
  propagate?: boolean;
};

export type HostFileDecorations = { path: string; decoration: HostFileDecoration }[];

/* ── debugging ──────────────────────────────────────────────────────────── */

/** A launch configuration offered to the view (from launch.json or a provider). */
export type HostDebugConfiguration = {
  name: string;
  type: string;
  request?: string;
  /** Workspace folder the configuration belongs to (the view's spelling). */
  folder?: string;
  /** The whole configuration, so the view can inspect custom attributes. */
  [key: string]: unknown;
};

export type HostDebugCompound = { name: string; configurations: string[]; folder?: string };

export type HostDebugConfigurations = {
  configurations: HostDebugConfiguration[];
  compounds: HostDebugCompound[];
  /** A launch.json parse error (initial configurations may be offered instead). */
  error?: string;
};

export type HostDebugSessionState = "starting" | "running" | "stopped" | "terminated";

export type HostDebugSession = {
  id: string;
  type: string;
  name: string;
  parentId: string | null;
  state: HostDebugSessionState;
  stoppedThreadId?: number;
  stoppedReason?: string;
  stoppedDescription?: string;
};

export type HostDebugBreakpoint = {
  id: string;
  kind: "source" | "function";
  enabled: boolean;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
  /** Source breakpoints: the file and 1-based line the user set. */
  path?: string;
  line?: number;
  /** The adapter verified it (and where it really landed). */
  verified?: boolean;
  verifiedLine?: number;
  message?: string;
  /** Function breakpoints. */
  functionName?: string;
  /** A verified source breakpoint the adapter moved into another file. */
  sourcePath?: string;
};

export type HostDebugStopped = {
  sessionId: string;
  threadId: number;
  reason: string;
  description?: string;
  /** Where the editor should reveal (from the first stack frame). */
  path?: string;
  line?: number;
  column?: number;
  frameId?: number;
};

export type HostDebugOutput = { sessionId: string; category: string; text: string; path?: string; line?: number; column?: number };

export type HostDebugExceptionFilter = {
  filter: string;
  label: string;
  description?: string;
  default?: boolean;
  supportsCondition?: boolean;
  conditionDescription?: string;
};

export type HostDebugCapabilities = { sessionId: string; capabilities: Record<string, unknown>; exceptionBreakpointFilters: HostDebugExceptionFilter[] };

export type HostDebugCustomEvent = { sessionId: string; event: string; body: unknown };

export type HostDebugThread = { id: number; name: string };
export type HostDebugSource = { name?: string; path?: string; sourceReference?: number };
export type HostDebugStackFrame = { id: number; name: string; source?: HostDebugSource; line: number; column: number };
export type HostDebugScope = { name: string; variablesReference: number; expensive: boolean };
export type HostDebugVariable = { name: string; value: string; type?: string; variablesReference: number; evaluateName?: string };
export type HostDebugEvaluateResult = { result: string; type?: string; variablesReference: number };
export type HostDebugSetBreakpoint = { line: number; enabled?: boolean; condition?: string; hitCondition?: string; logMessage?: string };

/* ── editor layout (window.tabGroups) ───────────────────────────────────── */

/** "feature": an editor a feature plug-in renders (`uri` is the file, `viewType` the opener id). */
export type HostTabKind = "text" | "webview" | "custom" | "terminal" | "feature" | "diff" | "other";

export type HostTab = {
  label: string;
  /** The view's key for the tab (`null` when it has none). */
  path: string | null;
  kind: HostTabKind;
  isActive: boolean;
  isDirty: boolean;
  isPinned: boolean;
  isPreview: boolean;
  /** A custom editor tab: the file and the provider's view type; a webview tab: the panel's view type. */
  uri?: string;
  viewType?: string;
  /** A diff tab: the two documents (view keys) it compares. */
  original?: string;
  modified?: string;
};

export type HostTabGroup = { viewColumn: number; isActive: boolean; tabs: HostTab[] };

/** A quick input button (title bar) or a quick pick item button. */
export type HostQuickInputButton = {
  /** Codicon id, or an image URL when `image` is set. */
  icon: string;
  /** `icon` is an image URL (from a Uri iconPath) rather than a codicon id. */
  image?: boolean;
  tooltip?: string;
  /** Index in the extension's button array; reported back when the button is pressed. */
  index: number;
};

export type HostQuickPickItem = {
  label: string;
  description?: string;
  detail?: string;
  picked?: boolean;
  separator?: boolean;
  alwaysShow?: boolean;
  /** Buttons shown on the right of the item (QuickPickItem.buttons). */
  buttons?: HostQuickInputButton[];
};

export type HostQuickPick = {
  id: number;
  title?: string;
  placeholder?: string;
  value?: string;
  items: HostQuickPickItem[];
  canPickMany: boolean;
  busy?: boolean;
  matchOnDescription?: boolean;
  matchOnDetail?: boolean;
  /** Indexes of the highlighted / selected items. */
  activeItems?: number[];
  selectedItems?: number[];
  /** Keep the list as given (filtering is done by the extension). */
  noFilter?: boolean;
  /** QuickInput.buttons, shown in the title bar (QuickInputButtons.Back on the left). */
  buttons?: HostQuickInputButton[];
};

export type HostInputBox = {
  /** Validation and value events refer to it. */
  id?: number;
  /** createInputBox: value changes are reported back as they happen. */
  live?: boolean;
  title?: string;
  prompt?: string;
  value?: string;
  placeholder?: string;
  password?: boolean;
  /** Validation message from the extension for the current value. */
  validationMessage?: string;
  /** InputBox.buttons, shown in the title bar (QuickInputButtons.Back on the left). */
  buttons?: HostQuickInputButton[];
};

/** Host → view requests that need an answer. */
export type ViewMethods = {
  showMessage: (
    kind: "info" | "warning" | "error",
    message: string,
    items: string[],
    options: { modal?: boolean; detail?: string; source?: string },
  ) => number | null;
  showQuickPick: (pick: HostQuickPick) => number[] | null;
  showInputBox: (options: HostInputBox) => string | null;
  showTextDocument: (path: string, options: { selection?: TextRange; preview?: boolean; preserveFocus?: boolean; beside?: boolean }) => boolean;
  /** Open a side-by-side diff of two documents (`vscode.diff`); the modified side is editable. */
  openDiff: (
    original: string,
    modified: string,
    options: { title?: string; preview?: boolean; preserveFocus?: boolean; viewColumn?: number; selection?: TextRange },
  ) => boolean;
  /** Open an untitled editor under the path the host chose (`untitled:Name`). */
  openUntitled: (path: string, language: string, content: string) => boolean;
  setDocumentLanguage: (path: string, language: string) => boolean;
  editDocument: (path: string, edits: TextEdit[], options: { undoStopBefore?: boolean }) => boolean;
  applyWorkspaceEdit: (edits: FileEdits[]) => boolean;
  /** A file operation of workspace.applyEdit is done: editors follow renamed files and close deleted ones. */
  fileOperation: (kind: "create" | "delete" | "rename", files: HostFileOperation[]) => boolean;
  setSelections: (path: string, selections: HostSelection[]) => boolean;
  revealRange: (path: string, range: TextRange) => boolean;
  insertSnippet: (path: string, snippet: string, ranges: TextRange[] | null) => boolean;
  saveDocument: (path: string) => boolean;
  saveAll: () => boolean;
  executeCommand: (command: string, args: unknown[]) => unknown;
  clipboardRead: () => string;
  clipboardWrite: (text: string) => boolean;
  createTerminal: (options: { name?: string; cwd?: string; shellPath?: string }) => string;
  terminalSendText: (id: string, text: string, addNewLine: boolean) => boolean;
  terminalShow: (id: string, preserveFocus: boolean) => boolean;
  terminalDispose: (id: string) => boolean;
  /** A request of a host feature to the view feature of `area` (main/exthost/features to mainview/features). */
  feature: (area: string, method: string, args: unknown[]) => unknown;
  updateConfiguration: (key: string, value: unknown) => boolean;
  /** Close editor tabs by view path (window.tabGroups.close); true when all are gone. */
  closeTabs: (paths: string[]) => boolean;
  /** Save a document under a chosen name (workspace.saveAs, custom text editor Save As). */
  saveDocumentAs: (path: string, destination: string) => boolean;
};

/** Host → main requests (dialogs and the operating system). */
export type MainMethods = {
  showOpenDialog: (options: { title?: string; defaultPath?: string; folders?: boolean; many?: boolean }) => string[];
  showSaveDialog: (options: { title?: string; defaultPath?: string }) => string | null;
  openExternal: (url: string) => boolean;
  /** Folders a webview may load files from (served by the webview resource server). */
  setWebviewRoots: (webviewId: string, roots: string[]) => boolean;
};

export const MAIN_METHODS: readonly (keyof MainMethods)[] = ["showOpenDialog", "showSaveDialog", "openExternal", "setWebviewRoots"];

/* ── webviews ──────────────────────────────────────────────────────────── */

export type HostWebviewOptions = {
  enableScripts: boolean;
  enableForms: boolean;
  enableCommandUris: boolean;
  retainContextWhenHidden: boolean;
  enableFindWidget?: boolean;
};

export type HostWebview = {
  id: string;
  kind: "panel" | "view";
  extensionId: string;
  /** Panel view type, or the contributed view id of a webview view. */
  viewType: string;
  title: string;
  options: HostWebviewOptions;
  /** For a custom editor panel (window.registerCustomEditorProvider): the file it shows. */
  uri?: string;
  /** The kind of its provider (CustomTextEditorProvider / CustomReadonlyEditorProvider / CustomEditorProvider). */
  customKind?: "text" | "readonly" | "editable";
  /** A custom editor whose document has unsaved changes. */
  dirty?: boolean;
  /** Where the page is served (filled in by the main process). */
  url?: string;
};

/** A view contributed to a view container (contributes.views). */
export type ViewContribution = { id: string; name: string; type?: string; when?: string; icon?: string; visibility?: string; initialSize?: number };

export type ViewContainerContribution = { id: string; title: string; icon?: string };

/** contributes.viewsWelcome: shown in an empty tree view. */
export type ViewWelcomeContribution = { view: string; contents: string; when?: string };

/* ── tree views ────────────────────────────────────────────────────────── */

/** A tree item's icon: a codicon, an image (data or web URL) or the file icon of a name. */
export type HostTreeIcon = { codicon: string; color?: string } | { url: string } | { file: string; folder: boolean };

/** A tree item's tooltip: rendered as Markdown when `markdown` is set, plain text otherwise. */
export type HostTreeTooltip = string | { markdown: string };

export type HostTreeItem = {
  /** Stable across refreshes (from TreeItem.id, or the parent's handle and the label). */
  handle: string;
  label: string;
  /** Label ranges to highlight ([start, end) offsets). */
  highlights?: [number, number][];
  description?: string;
  /** A MarkdownString is sent as `{ markdown }`; a plain string stays plain. */
  tooltip?: HostTreeTooltip;
  collapsible: "none" | "collapsed" | "expanded";
  icon?: HostTreeIcon;
  /** `viewItem` in the when clauses of item menus. */
  contextValue?: string;
  /** A click runs the item's command (the host keeps its arguments). */
  hasCommand: boolean;
  checkbox?: "checked" | "unchecked";
};

/** What the view shows around a tree (TreeView.title, message, …). */
export type HostTreeView = {
  viewId: string;
  extensionId: string;
  title?: string;
  description?: string;
  message?: string;
  badge?: { value: number; tooltip: string } | null;
  showCollapseAll: boolean;
  canSelectMany: boolean;
  /** MIME types of the drag-and-drop controller (empty: the tree cannot be dragged / dropped on). */
  dragMimeTypes: string[];
  dropMimeTypes: string[];
};

/** A file the user created / deleted / renamed in the explorer (`oldPath` / `newPath` for renames). */
export type HostFileOperation = { path?: string; oldPath?: string; newPath?: string };

/** View → host calls that return a result. */
export type HostMethods = {
  executeCommand: (command: string, args: unknown[]) => unknown;
  /** A request of a view feature to the host feature of `area` (mainview/features to main/exthost/features). */
  feature: (area: string, method: string, args: unknown[]) => unknown;
  provideCompletions: (path: string, line: number, character: number, triggerCharacter: string | null) => HostCompletionItem[];
  provideHover: (path: string, line: number, character: number) => HostHover | null;
  /** Inlay hints of the matching providers inside a range (empty when none). */
  provideInlayHints: (path: string, range: TextRange) => HostInlayHint[];
  /** Semantic tokens of the document, decoded with the providers' legends (empty when none). */
  provideSemanticTokens: (path: string) => HostSemanticToken[];
  /** Code lenses for a document (`resolveCodeLens` is applied in the host). */
  provideCodeLenses: (path: string) => HostCodeLens[];
  /** Run the command of a code lens the host handed out. */
  runCodeLens: (id: string) => void;
  /** Code actions (quick fixes, refactors) at a range; `only` is a CodeActionKind filter. */
  provideCodeActions: (path: string, range: TextRange, diagnostics: Diagnostic[], only?: string) => HostCodeAction[];
  /** Apply the code action the host handed out, then run its command. */
  runCodeAction: (id: string) => void;
  provideSignatureHelp: (path: string, line: number, character: number, triggerCharacter: string | null) => HostSignatureHelp | null;
  provideDefinition: (path: string, line: number, character: number) => HostLocation[];
  provideTypeDefinition: (path: string, line: number, character: number) => HostLocation[];
  provideImplementation: (path: string, line: number, character: number) => HostLocation[];
  provideDeclaration: (path: string, line: number, character: number) => HostLocation[];
  provideReferences: (path: string, line: number, character: number) => HostLocation[];
  /** Document highlights for the symbol at a position (empty when none). */
  provideDocumentHighlights: (path: string, line: number, character: number) => HostDocumentHighlight[];
  /** The links of a document (languages.registerDocumentLinkProvider). */
  provideDocumentLinks: (path: string) => HostDocumentLink[];
  /** Resolve the link at `index` (its target was missing); `null` when it cannot be resolved. */
  resolveDocumentLink: (path: string, index: number) => HostDocumentLink | null;
  /** The colours an extension found in a document (languages.registerColorProvider). */
  provideDocumentColors: (path: string) => HostColorInformation[];
  /** How the extension would write `color` at `range` (colour picker labels). */
  provideColorPresentations: (path: string, color: HostColor, range: TextRange) => HostColorPresentation[];
  /** What a rename provider offers to rename at a position (`null`: it does not handle it). */
  prepareRename: (path: string, line: number, character: number) => HostPrepareRename;
  /** The edits a rename provider wants to make across files (`null`: it does not handle it). */
  provideRenameEdits: (path: string, line: number, character: number, newName: string) => HostRenameEdits;
  provideFormatting: (path: string, options: { tabSize: number; insertSpaces: boolean }, range: TextRange | null) => TextEdit[] | null;
  /** On-type formatting edits after `ch` was typed at the position (empty when none). */
  provideOnTypeFormatting: (path: string, line: number, character: number, ch: string, options: { tabSize: number; insertSpaces: boolean }) => TextEdit[];
  /** Inline completions at a position (`triggerKind`: 0 invoked, 1 automatic). */
  provideInlineCompletions: (path: string, line: number, character: number, triggerKind: number) => HostInlineCompletionItem[];
  provideSymbols: (path: string) => DocumentSymbol[] | null;
  /** Folding ranges an extension provider returned (0-based lines). */
  provideFoldingRanges: (path: string) => HostFoldingRange[];
  /** Selection ranges per position (innermost first), from an extension provider. */
  provideSelectionRanges: (path: string, positions: { line: number; character: number }[]) => TextRange[][];
  /** Symbols matching a workspace-wide query (empty when no provider is registered). */
  provideWorkspaceSymbols: (query: string) => HostWorkspaceSymbol[];
  /** Fills in the location of a workspace symbol that had none (resolveWorkspaceSymbol). */
  resolveWorkspaceSymbol: (id: number) => HostLocation | null;
  /** The ranges that mirror each other around a position (registerLinkedEditingRangeProvider). */
  provideLinkedEditingRanges: (path: string, line: number, character: number) => HostLinkedEditingRanges | null;
  /** Bring back a webview panel saved with the window (registerWebviewPanelSerializer). */
  deserializeWebviewPanel: (viewType: string, webviewId: string, title: string, state: unknown, options: HostWebviewOptions | null) => boolean;
  /** Documents of file systems provided by extensions (registerFileSystemProvider). */
  readVirtualFile: (path: string) => { content: string; language: string; readOnly?: boolean; readOnlyMessage?: string };
  writeVirtualFile: (path: string, content: string) => boolean;
  /** Schemes with a file system provider. */
  virtualSchemes: () => string[];
  /** Children of a folder of a provided file system (workspace folders in the explorer). */
  providerReadDirectory: (path: string) => { entries: FileEntry[]; readOnly?: boolean; readOnlyMessage?: string; error?: string };
  /** Explorer operations of provided folders; the provider's read-only message is the error. */
  providerCreateFile: (path: string, content: string) => { success: boolean; error?: string };
  providerCreateDirectory: (path: string) => { success: boolean; error?: string };
  providerRename: (oldPath: string, newPath: string) => { success: boolean; error?: string };
  /** Copy a file or folder inside one provided file system (provider.copy, else read + write). */
  providerCopy: (source: string, destination: string) => { success: boolean; error?: string };
  providerDelete: (path: string) => { success: boolean; error?: string };
  /** Watch a provided workspace folder the explorer shows (recursive) / stop watching it. */
  providerWatch: (path: string, recursive: boolean) => boolean;
  providerUnwatch: (path: string) => boolean;
  /** Files under provided workspace folders, for Quick Open (bounded depth and count). */
  providerListFiles: (roots: string[], limit?: number) => string[];
  /** Find in Files for provided workspace folders. */
  providerSearchFiles: (
    roots: string[],
    query: string,
    options: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean; include?: string; exclude?: string; maxResults?: number },
  ) => { matches: SearchMatch[]; truncated: boolean };
  /** Replace in Files for provided workspace folders (only `paths`, when given). */
  providerReplaceFiles: (
    roots: string[],
    query: string,
    replacement: string,
    options: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean; include?: string; exclude?: string; maxResults?: number },
    paths?: string[],
  ) => { replacements: number; files: number; error?: string };
  /** Children of a tree item (`null`: the root); `null` when no provider is registered for the view. */
  treeChildren: (viewId: string, handle: string | null) => HostTreeItem[] | null;
  /** TreeDataProvider.resolveTreeItem: the item's tooltip, once the user hovers it. */
  resolveTreeItem: (viewId: string, handle: string) => { tooltip?: HostTreeTooltip } | null;
  /** A drag started in a tree view: the extension fills a DataTransfer; the id is passed to treeDrop. */
  treeDrag: (viewId: string, handles: string[]) => string | null;
  /** A drop on a tree item (`null`: the root); `files` are paths dragged from the Lumen explorer. */
  treeDrop: (viewId: string, targetHandle: string | null, dragId: string | null, files?: string[]) => boolean;
  /** The user is about to save a document: extensions may return edits to apply first. */
  willSaveDocument: (path: string, reason: number) => TextEdit[];
  /** The user is about to create / delete / rename files: fires workspace.onWill* and returns edits to apply first. */
  willFileOperation: (kind: "create" | "delete" | "rename", files: HostFileOperation[]) => { path: string; edits: TextEdit[] }[];
  /** File decorations for the explorer's files (window.registerFileDecorationProvider). */
  provideFileDecorations: (paths: string[]) => HostFileDecorations;
  /** Open a file in a contributed custom editor; the webview id and provider kind, or `null`. */
  openCustomEditor: (
    path: string,
    viewType: string,
    options: { preview?: boolean; beside?: boolean },
  ) => { id: string; kind: "text" | "readonly" | "editable" } | null;
  /** Save an editable custom document (CustomEditorProvider.saveCustomDocument). */
  saveCustomEditor: (path: string, viewType: string) => boolean;
  /** Save an editable custom document under a new name (saveCustomDocumentAs); asks for the path. */
  saveCustomEditorAs: (path: string, viewType: string) => boolean;
  /** Revert an editable custom document (revertCustomDocument). */
  revertCustomEditor: (path: string, viewType: string) => boolean;
  /** Undo / redo the last edit of an editable custom document (CustomDocumentEditEvent). */
  undoCustomEditor: (path: string, viewType: string) => boolean;
  redoCustomEditor: (path: string, viewType: string) => boolean;
  /** Back up an unsaved editable custom document (backupCustomDocument); the backup id, or null. */
  backupCustomEditor: (path: string, viewType: string, destination?: string) => string | null;
  /** Bring back a custom editor tab saved with the window (the provider is asked again). */
  deserializeCustomEditor: (path: string, viewType: string, webviewId: string, state: unknown) => boolean;

  /* debugging */
  /** The launch configurations and compounds of a folder (launch.json + provider configurations). */
  debugListConfigurations: (folder: string | null) => HostDebugConfigurations;
  /** Start the named configuration of a folder; the workspace folder's launch.json is read when needed. */
  debugStart: (folder: string | null, name: string) => { sessionId?: string; error?: string };
  /** Start an explicit configuration object (already chosen by the user, or a default one). */
  debugStartConfiguration: (folder: string | null, config: Record<string, unknown>) => { sessionId?: string; error?: string };
  debugStop: (sessionId: string | null) => boolean;
  debugRestart: (sessionId: string) => { sessionId?: string; error?: string };
  debugResume: (sessionId: string, threadId: number) => boolean;
  debugPause: (sessionId: string, threadId: number) => boolean;
  /** Step: "next" (over), "in" (into), "out" (out of). */
  debugStep: (sessionId: string, threadId: number, kind: "next" | "in" | "out") => boolean;
  debugThreads: (sessionId: string) => HostDebugThread[];
  debugStackTrace: (sessionId: string, threadId: number, startFrame: number, levels: number) => HostDebugStackFrame[];
  debugScopes: (sessionId: string, frameId: number) => HostDebugScope[];
  debugVariables: (sessionId: string, variablesReference: number, filter?: "named" | "indexed", start?: number, count?: number) => HostDebugVariable[];
  debugSetVariable: (sessionId: string, variablesReference: number, name: string, value: string) => HostDebugVariable | null;
  debugEvaluate: (sessionId: string, expression: string, frameId: number | null, context: "repl" | "watch" | "hover") => HostDebugEvaluateResult | null;
  /** Any DAP request (DebugSession.customRequest). */
  debugCustomRequest: (sessionId: string, command: string, args: unknown) => unknown;
  /** Replace the source breakpoints of a file; returns the new breakpoint list. */
  debugSetBreakpoints: (path: string, breakpoints: HostDebugSetBreakpoint[]) => HostDebugBreakpoint[];
  /** Add or remove a breakpoint on a line; returns the new breakpoint list. */
  debugToggleBreakpoint: (path: string, line: number) => HostDebugBreakpoint[];
  debugSetBreakpointEnabled: (id: string, enabled: boolean) => HostDebugBreakpoint[];
  debugEditBreakpoint: (id: string, changes: { condition?: string; hitCondition?: string; logMessage?: string }) => HostDebugBreakpoint[];
  debugRemoveAllBreakpoints: () => HostDebugBreakpoint[];
  debugSetExceptionBreakpoints: (sessionId: string, filters: string[]) => boolean;
  debugLoadedSources: (sessionId: string) => HostDebugSource[];
};

/** How an onEnterRule changes the indentation (VS Code `IndentAction`). */
export type HostIndentAction = "none" | "indent" | "indentOutdent" | "outdent";

/** One `onEnterRules` entry (VS Code `OnEnterRule`): patterns as regex sources. */
export type HostOnEnterRule = {
  beforeText: string;
  afterText?: string;
  previousLineText?: string;
  action: { indentAction: HostIndentAction; appendText?: string };
};

/**
 * A language configuration (`languages.setLanguageConfiguration`, or a
 * `language-configuration.json`), serialised for the view: patterns are plain
 * regex sources so the whole thing survives the host → view message.
 */
export type HostLanguageConfiguration = {
  comments?: { lineComment?: string; blockComment?: [string, string] };
  brackets?: [string, string][];
  autoClosingPairs?: { open: string; close: string; notIn?: string[] }[];
  surroundingPairs?: [string, string][];
  wordPattern?: { source: string; flags: string };
  indentationRules?: { increaseIndentPattern?: string; decreaseIndentPattern?: string };
  onEnterRules?: HostOnEnterRule[];
};

/** View → host notifications (relayed by main, in order). */
export type ViewToHost =
  | { type: "documentOpen"; doc: HostDocumentData }
  | { type: "documentChange"; path: string; version: number; dirty: boolean; changes: HostContentChange[] }
  | { type: "documentDirty"; path: string; dirty: boolean }
  | { type: "documentClose"; path: string }
  | { type: "documentSave"; path: string }
  | { type: "activeEditor"; path: string | null; selections: HostSelection[]; visible: string[] }
  /** The window's color theme (window.activeColorTheme). */
  | { type: "colorTheme"; kind: ColorThemeKind }
  | { type: "selection"; path: string; selections: HostSelection[] }
  /** The visible ranges of the active editor (after scrolling). */
  | { type: "visibleRanges"; path: string; ranges: TextRange[] }
  /** Indentation options of the active editor (tab size / insert spaces). */
  | { type: "options"; path: string; options: { tabSize: number; insertSpaces: boolean } }
  | { type: "configuration"; config: ConfigSnapshot; changed: string[] }
  | { type: "workspace"; root: string | null }
  | { type: "executeCommand"; command: string; args: unknown[] }
  | { type: "activate"; event: string }
  | { type: "reply"; id: number; result?: unknown; error?: string }
  | {
      type: "quickPickEvent";
      id: number;
      event: "value" | "active" | "accept" | "hide" | "button" | "itemButton";
      value?: string;
      items?: number[];
      index?: number;
    }
  | { type: "inputBoxValue"; id: number; value: string }
  | { type: "terminalClosed"; id: string }
  /** The terminal the user is looking at (or `null` when none is active). */
  | { type: "activeTerminal"; id: string | null }
  | { type: "focus"; focused: boolean }
  /** The editor layout: every tab group with its tabs (window.tabGroups). Sent when tabs change. */
  | { type: "tabs"; groups: HostTabGroup[] }
  /** A webview view became visible for the first time (resolveWebviewView). */
  | { type: "webviewViewVisible"; viewId: string; webviewId: string; state: unknown }
  | { type: "webviewMessage"; id: string; message: unknown }
  | { type: "webviewViewState"; id: string; visible: boolean; active: boolean }
  /** The user closed a webview panel. */
  | { type: "webviewClosed"; id: string }
  /** Something happened in a tree view (items by handle). */
  | {
      type: "treeEvent";
      viewId: string;
      event: "expand" | "collapse" | "select" | "open" | "visible" | "hidden" | "checkbox";
      handles: string[];
      checked?: boolean;
    }
  /** A command from an item's menu, run with the item (and the selection). */
  | { type: "treeCommand"; viewId: string; command: string; handles: string[] }
  /** A create / delete / rename the user did in the explorer finished (workspace.onDid*). */
  | { type: "didFileOperation"; kind: "create" | "delete" | "rename"; files: HostFileOperation[] }
  /** A message of a view feature to the host feature of `area` (`api.sendToHost`). */
  | { type: "feature"; area: string; payload: unknown };

/** Host → view messages. */
export type HostToView =
  /** The host (re)started with these (enabled) extensions: the view re-sends its documents. */
  | { type: "ready"; extensions: ExtensionDescription[] }
  | { type: "commands"; commands: { command: string; extensionId: string }[] }
  | { type: "providers"; providers: HostProvider[] }
  /** An inlay hints provider asked to be asked again (onDidChangeInlayHints). */
  | { type: "inlayHintsChanged" }
  /** A language configuration was set (or removed, `config` null): the view applies it to that language. */
  | { type: "languageConfiguration"; languageId: string; config: HostLanguageConfiguration | null }
  /** A code lens provider fired onDidChangeCodeLenses: the view refetches them. */
  | { type: "codeLensesChanged" }
  | { type: "statusBar"; item: HostStatusBarItem }
  | { type: "statusBarDispose"; id: string }
  | {
      type: "output";
      channel: string;
      extensionId?: string;
      op: "append" | "replace" | "clear" | "show" | "dispose";
      text?: string;
      preserveFocus?: boolean;
      log?: boolean;
    }
  | { type: "diagnostics"; owner: string; entries: [string, Diagnostic[]][]; clear?: boolean }
  | { type: "decorationType"; id: string; options: HostDecorationType | null }
  | { type: "decorations"; path: string; typeId: string; ranges: HostDecoration[] }
  | { type: "progress"; id: number; title?: string; message?: string; percent?: number; done?: boolean; notification?: boolean }
  | { type: "context"; key: string; value: unknown }
  | { type: "activated"; extensionId: string; ms: number; error?: string }
  | { type: "quickPickUpdate"; pick: HostQuickPick | null }
  | { type: "inputBoxValidation"; id: number; message: string | null; close?: boolean }
  /** An InputBox's buttons changed while it is shown (InputBox.buttons). */
  | { type: "inputBoxButtons"; id: number; buttons: HostQuickInputButton[] }
  | { type: "request"; id: number; method: keyof ViewMethods; args: unknown[] }
  /** A message of a host feature to the view feature of `area` (`host.postFeature`). */
  | { type: "feature"; area: string; payload: unknown }
  | { type: "message"; kind: "info" | "warning" | "error"; message: string; extensionId?: string }
  | { type: "crashed"; error: string }
  | { type: "webviewCreate"; webview: HostWebview; reveal?: { preserveFocus: boolean; beside: boolean } }
  | { type: "webviewHtml"; id: string; html: string }
  | {
      type: "webviewUpdate";
      id: string;
      title?: string;
      description?: string;
      badge?: { value: number; tooltip: string } | null;
      options?: HostWebviewOptions;
      dirty?: boolean;
      uri?: string;
    }
  | { type: "webviewPost"; id: string; message: unknown }
  | { type: "webviewReveal"; id: string; preserveFocus: boolean }
  | { type: "webviewDispose"; id: string }
  /** Files of an extension's file system changed (onDidChangeFile). */
  | { type: "virtualFilesChanged"; paths: string[]; changes?: { path: string; type: number }[] }
  | { type: "fileSystems"; schemes: string[]; readOnly?: Record<string, string | true>; caseSensitive?: string[] }
  /** A file decoration provider's onDidChangeFileDecorations fired (all when `paths` is missing). */
  | { type: "fileDecorationsChanged"; paths?: string[] }
  /** A tree view's provider registered or its title, message, … changed. */
  | { type: "treeView"; view: HostTreeView }
  | { type: "treeDispose"; viewId: string }
  /** onDidChangeTreeData: reload these items' children (`null`: everything). */
  | { type: "treeChanged"; viewId: string; handles: string[] | null }
  /** TreeView.reveal: the item's handle with its ancestors', root first. */
  | { type: "treeReveal"; viewId: string; path: string[]; select: boolean; focus: boolean; expand: boolean | number }
  /** Every debug session, changed: started / stopped / running / terminated. */
  | { type: "debugSessions"; sessions: HostDebugSession[] }
  /** The active debug session (what the debug UI shows), or null. */
  | { type: "debugActiveSession"; sessionId: string | null }
  /** A session stopped: reveal the location, show the call stack. */
  | { type: "debugStopped"; stopped: HostDebugStopped }
  /** A session continued (or a thread did). */
  | { type: "debugContinued"; sessionId: string; threadId?: number; allThreadsContinued?: boolean }
  /** Debug console output (category console/stdout/stderr/telemetry, or an adapter's). */
  | { type: "debugOutput"; output: HostDebugOutput }
  /** The host's breakpoints changed (user action, adapter verification, restore). */
  | { type: "debugBreakpoints"; breakpoints: HostDebugBreakpoint[] }
  /** The adapter's capabilities (after initialize) / its exception filters. */
  | { type: "debugCapabilities"; capabilities: HostDebugCapabilities }
  /** A custom DAP event from the adapter (debug.onDidReceiveDebugSessionCustomEvent). */
  | { type: "debugCustomEvent"; event: HostDebugCustomEvent }
  /** The active stack item (frame or thread), or null. */
  | { type: "debugActiveStackItem"; sessionId: string | null; threadId?: number; frameId?: number };

/* ── language configurations ──────────────────────────────────────────────── */

type RegexLike = RegExp | string | undefined;

function regexSource(value: RegexLike): string | undefined {
  if (value instanceof RegExp) return value.source;
  if (typeof value === "string") return value;
  return undefined;
}

export function wireRegex(value: RegexLike): { source: string; flags: string } | undefined {
  if (value instanceof RegExp) return { source: value.source, flags: value.flags };
  if (typeof value === "string") return { source: value, flags: "" };
  return undefined;
}

function wirePairs(value: unknown): [string, string][] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: [string, string][] = [];
  for (const entry of value) {
    if (Array.isArray(entry) && entry.length >= 2) out.push([String(entry[0]), String(entry[1])]);
    else if (entry && typeof entry === "object" && "open" in entry && "close" in entry) {
      const pair = entry as { open?: unknown; close?: unknown };
      out.push([String(pair.open), String(pair.close)]);
    }
  }
  return out.length ? out : undefined;
}

function wireAutoClosingPairs(value: unknown): HostLanguageConfiguration["autoClosingPairs"] {
  if (!Array.isArray(value)) return undefined;
  const out: NonNullable<HostLanguageConfiguration["autoClosingPairs"]> = [];
  for (const entry of value) {
    let open: unknown;
    let close: unknown;
    let notIn: unknown;
    if (Array.isArray(entry) && entry.length >= 2) [open, close] = entry;
    else if (entry && typeof entry === "object") {
      const pair = entry as { open?: unknown; close?: unknown; notIn?: unknown };
      ({ open, close, notIn } = pair);
    }
    if (typeof open !== "string" || typeof close !== "string") continue;
    out.push({ open, close, notIn: Array.isArray(notIn) ? notIn.map(String) : undefined });
  }
  return out.length ? out : undefined;
}

const INDENT_ACTIONS: HostIndentAction[] = ["none", "indent", "indentOutdent", "outdent"];

function wireIndentAction(value: unknown): HostIndentAction {
  if (typeof value === "number") return INDENT_ACTIONS[value] ?? "none";
  if (typeof value === "string" && (INDENT_ACTIONS as string[]).includes(value)) return value as HostIndentAction;
  return "none";
}

function wireOnEnterRules(value: unknown): HostOnEnterRule[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: HostOnEnterRule[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const rule = entry as {
      beforeText?: RegexLike;
      afterText?: RegexLike;
      previousLineText?: RegexLike;
      action?: { indentAction?: unknown; appendText?: unknown };
    };
    const beforeText = regexSource(rule.beforeText);
    if (!beforeText) continue;
    out.push({
      beforeText,
      afterText: regexSource(rule.afterText),
      previousLineText: regexSource(rule.previousLineText),
      action: {
        indentAction: wireIndentAction(rule.action?.indentAction),
        appendText: typeof rule.action?.appendText === "string" ? rule.action.appendText : undefined,
      },
    });
  }
  return out.length ? out : undefined;
}

/**
 * Normalise a `LanguageConfiguration` (from the API — RegExps and tuples — or
 * from a `language-configuration.json` — plain strings) into the serialisable
 * shape the view applies. Returns `null` when there is nothing usable.
 */
export function wireLanguageConfiguration(value: unknown): HostLanguageConfiguration | null {
  if (!value || typeof value !== "object") return null;
  const source = value as {
    comments?: { lineComment?: unknown; blockComment?: unknown };
    brackets?: unknown;
    autoClosingPairs?: unknown;
    surroundingPairs?: unknown;
    wordPattern?: RegexLike;
    indentationRules?: { increaseIndentPattern?: RegexLike; decreaseIndentPattern?: RegexLike };
    onEnterRules?: unknown;
  };
  const config: HostLanguageConfiguration = {};
  const comments = source.comments;
  if (comments && typeof comments === "object") {
    const block =
      Array.isArray(comments.blockComment) && comments.blockComment.length >= 2
        ? ([String(comments.blockComment[0]), String(comments.blockComment[1])] as [string, string])
        : undefined;
    const line = typeof comments.lineComment === "string" ? comments.lineComment : undefined;
    if (line || block) config.comments = { lineComment: line, blockComment: block };
  }
  const brackets = wirePairs(source.brackets);
  if (brackets) config.brackets = brackets;
  const autoClosingPairs = wireAutoClosingPairs(source.autoClosingPairs);
  if (autoClosingPairs) config.autoClosingPairs = autoClosingPairs;
  const surroundingPairs = wirePairs(source.surroundingPairs);
  if (surroundingPairs) config.surroundingPairs = surroundingPairs;
  const wordPattern = wireRegex(source.wordPattern);
  if (wordPattern) config.wordPattern = wordPattern;
  const rules = source.indentationRules;
  if (rules && typeof rules === "object") {
    const increaseIndentPattern = regexSource(rules.increaseIndentPattern);
    const decreaseIndentPattern = regexSource(rules.decreaseIndentPattern);
    if (increaseIndentPattern || decreaseIndentPattern) config.indentationRules = { increaseIndentPattern, decreaseIndentPattern };
  }
  const onEnterRules = wireOnEnterRules(source.onEnterRules);
  if (onEnterRules) config.onEnterRules = onEnterRules;
  return Object.keys(config).length ? config : null;
}

/**
 * contributes.customEditors of one extension, normalised: the view type, its
 * label, the priority and the file selector (filenamePattern as a glob).
 */
export function customEditorContributions(extensionId: string, contributes: Contributes | undefined): CustomEditorContribution[] {
  const editors = (contributes as { customEditors?: unknown } | undefined)?.customEditors;
  if (!Array.isArray(editors)) return [];
  const out: CustomEditorContribution[] = [];
  for (const entry of editors) {
    if (!entry || typeof entry !== "object") continue;
    const { viewType, displayName, selector, priority } = entry as { viewType?: unknown; displayName?: unknown; selector?: unknown; priority?: unknown };
    if (typeof viewType !== "string" || !viewType) continue;
    const filters: HostDocumentFilter[] = [];
    for (const rule of [selector].flat()) {
      if (!rule || typeof rule !== "object") continue;
      const pattern = (rule as { filenamePattern?: unknown }).filenamePattern;
      if (typeof pattern === "string" && pattern) filters.push({ pattern });
    }
    out.push({
      extensionId,
      viewType,
      displayName: typeof displayName === "string" && displayName ? displayName : viewType,
      priority: priority === "option" ? "option" : "default",
      selector: filters,
    });
  }
  return out;
}
