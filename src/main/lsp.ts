import ts from "typescript";
import { dirname, isAbsolute, join, normalize, relative } from "path";
import { existsSync, readdirSync, statSync, readFileSync } from "fs";
import { createRequire } from "module";
import type {
  CompletionItem,
  DefinitionLocation,
  Diagnostic,
  DocumentSymbol,
  FileEdits,
  HoverInfo,
  ReferenceLocation,
  TextEdit,
  TextRange,
} from "../shared/types.ts";
import { isTypeScriptFamily } from "./language.ts";
import { applyTsServerPlugins, setTsPluginConfig, type TsServerPluginSpec } from "./menus-walkthroughs-ts-plugins.ts";
import { jsonCompletions, jsonDiagnostics, jsonHover, setJsonSchemas, type JsonSchemaAssociation } from "./json-service.ts";

type OpenDoc = {
  path: string;
  content: string;
  language: string;
  version: number;
  scriptKind: ts.ScriptKind;
};

const COMPLETION_KIND: Record<string, string> = {
  [ts.ScriptElementKind.keyword]: "keyword",
  [ts.ScriptElementKind.classElement]: "class",
  [ts.ScriptElementKind.interfaceElement]: "interface",
  [ts.ScriptElementKind.typeElement]: "type",
  [ts.ScriptElementKind.enumElement]: "enum",
  [ts.ScriptElementKind.enumMemberElement]: "enumMember",
  [ts.ScriptElementKind.variableElement]: "variable",
  [ts.ScriptElementKind.localVariableElement]: "variable",
  [ts.ScriptElementKind.functionElement]: "function",
  [ts.ScriptElementKind.localFunctionElement]: "function",
  [ts.ScriptElementKind.memberFunctionElement]: "method",
  [ts.ScriptElementKind.memberGetAccessorElement]: "property",
  [ts.ScriptElementKind.memberSetAccessorElement]: "property",
  [ts.ScriptElementKind.memberVariableElement]: "property",
  [ts.ScriptElementKind.constructorImplementationElement]: "constructor",
  [ts.ScriptElementKind.parameterElement]: "variable",
  [ts.ScriptElementKind.typeParameterElement]: "typeParameter",
  [ts.ScriptElementKind.moduleElement]: "module",
  [ts.ScriptElementKind.constElement]: "constant",
  [ts.ScriptElementKind.letElement]: "variable",
  [ts.ScriptElementKind.alias]: "reference",
  [ts.ScriptElementKind.directory]: "folder",
  [ts.ScriptElementKind.string]: "text",
};

function normalizePath(p: string): string {
  return normalize(p);
}

function toScriptKind(path: string, language: string): ts.ScriptKind {
  const lower = path.toLowerCase();
  if (lower.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (lower.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return ts.ScriptKind.JS;
  if (language === "javascript") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function offsetAt(content: string, line: number, character: number): number {
  const lines = content.split(/\r?\n/);
  let offset = 0;
  for (let i = 0; i < line && i < lines.length; i++) {
    offset += lines[i]!.length + 1;
  }
  return offset + character;
}

function positionAt(content: string, offset: number): { line: number; character: number } {
  const lines = content.split(/\r?\n/);
  let remaining = offset;
  for (let i = 0; i < lines.length; i++) {
    const len = lines[i]!.length + 1;
    if (remaining < len) return { line: i, character: remaining };
    remaining -= len;
  }
  const last = Math.max(0, lines.length - 1);
  return { line: last, character: lines[last]?.length ?? 0 };
}

function isSubsequence(needle: string, haystack: string): boolean {
  let index = 0;
  for (const char of haystack) if (char === needle[index]) index++;
  return index === needle.length;
}

function displayPartsToString(parts?: ts.SymbolDisplayPart[]): string {
  return (parts ?? []).map((p) => p.text).join("");
}

/** Resolve typescript/lib so default libs work even when the app is packaged. */
function resolveTsLibDir(): string {
  try {
    const require = createRequire(import.meta.url);
    return dirname(require.resolve("typescript/lib/lib.d.ts"));
  } catch {
    /* fall through */
  }
  const candidates = [
    join(process.cwd(), "node_modules", "typescript", "lib"),
    join(process.cwd(), "..", "node_modules", "typescript", "lib"),
    join(process.cwd(), "..", "..", "node_modules", "typescript", "lib"),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "lib.d.ts"))) return c;
  }
  // Last resort: next to the TS package entry
  try {
    return dirname(ts.sys.getExecutingFilePath());
  } catch {
    return process.cwd();
  }
}

const TS_LIB_DIR = resolveTsLibDir();

/**
 * A TypeScript default lib (`lib.es2022.d.ts`) asked for at a path that does not exist
 * (the packaged app's): the file in TS_LIB_DIR. Never a project's own file: a `dist/lib.d.ts`
 * in the workspace is read from disk, or does not exist.
 */
function defaultLibFallback(fileName: string, root: string | null): string | null {
  const base = fileName.replace(/\\/g, "/").split("/").pop()!;
  if (!base.startsWith("lib.") || !base.endsWith(".d.ts") || existsSync(fileName)) return null;
  if (root) {
    const inside = relative(root, fileName);
    if (inside && !inside.startsWith("..") && !isAbsolute(inside)) return null;
  }
  const libPath = join(TS_LIB_DIR, base);
  return existsSync(libPath) ? libPath : null;
}

/** A change to one of these makes a new program (see filesChanged): compiler options, or installed packages. */
const PROJECT_FILE = /(^|[\\/])(tsconfig[^\\/]*|jsconfig)\.json$|[\\/]node_modules[\\/]/i;

// ─── JSON / lightweight language diagnostics ───────────────────────────

function asHints(diagnostics: Diagnostic[]): Diagnostic[] {
  return diagnostics.map((diagnostic) => ({ ...diagnostic, severity: "hint" }));
}

function pythonDiagnostics(path: string, content: string): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const lines = content.split(/\r?\n/);

  // Unclosed triple quotes / basic bracket balance
  let tripleSingle = 0;
  let tripleDouble = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // count """ and ''' outside of simple cases
    const dd = line.split('"""').length - 1;
    const ss = line.split("'''").length - 1;
    tripleDouble += dd;
    tripleSingle += ss;

    // tab/space mix warning on indented lines
    if (/^\t+ +|^\t* +\t/.test(line)) {
      diags.push({
        path,
        message: "Mixed tabs and spaces in indentation",
        severity: "warning",
        startLine: i,
        startCharacter: 0,
        endLine: i,
        endCharacter: line.length,
        source: "python",
      });
    }
  }
  if (tripleDouble % 2 !== 0) {
    diags.push({
      path,
      message: 'Unterminated triple-quoted string (""")',
      severity: "error",
      startLine: Math.max(0, lines.length - 1),
      startCharacter: 0,
      endLine: Math.max(0, lines.length - 1),
      endCharacter: 1,
      source: "python",
    });
  }
  if (tripleSingle % 2 !== 0) {
    diags.push({
      path,
      message: "Unterminated triple-quoted string (''')",
      severity: "error",
      startLine: Math.max(0, lines.length - 1),
      startCharacter: 0,
      endLine: Math.max(0, lines.length - 1),
      endCharacter: 1,
      source: "python",
    });
  }

  // Simple def/class without colon
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (/^(def|class|if|elif|else|for|while|try|except|finally|with)\b/.test(t) && !t.endsWith(":") && !t.endsWith("\\")) {
      // allow single-line pass after colon is required — skip comments
      if (t.startsWith("#")) continue;
      if (/^(else|try|finally)\s*$/.test(t) || /^(def|class|if|elif|for|while|except|with)\b.+$/.test(t)) {
        if (!t.includes("#") && !t.endsWith(":")) {
          diags.push({
            path,
            message: "Expected ':' at end of statement",
            severity: "error",
            startLine: i,
            startCharacter: Math.max(0, lines[i]!.length - 1),
            endLine: i,
            endCharacter: lines[i]!.length,
            source: "python",
          });
        }
      }
    }
  }

  return diags.slice(0, 50);
}

function cssDiagnostics(path: string, content: string): Diagnostic[] {
  const diags: Diagnostic[] = [];
  let depth = 0;
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const ch of line) {
      if (ch === "{") depth++;
      if (ch === "}") depth--;
      if (depth < 0) {
        diags.push({
          path,
          message: "Unexpected closing brace '}'",
          severity: "error",
          startLine: i,
          startCharacter: 0,
          endLine: i,
          endCharacter: line.length,
          source: "css",
        });
        depth = 0;
      }
    }
  }
  if (depth > 0) {
    diags.push({
      path,
      message: `Unclosed block — missing ${depth} closing brace(s)`,
      severity: "error",
      startLine: Math.max(0, lines.length - 1),
      startCharacter: 0,
      endLine: Math.max(0, lines.length - 1),
      endCharacter: 1,
      source: "css",
    });
  }
  return diags;
}

function htmlDiagnostics(path: string, content: string): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  const stack: { tag: string; line: number }[] = [];
  const tagRe = /<\/?([a-zA-Z][\w:-]*)\b[^>]*\/?>/g;
  const lines = content.split(/\r?\n/);
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    tagRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(line))) {
      const full = m[0];
      const tag = m[1]!.toLowerCase();
      if (full.startsWith("</")) {
        const last = stack.pop();
        if (!last) {
          diags.push({
            path,
            message: `Unexpected closing tag </${tag}>`,
            severity: "warning",
            startLine: i,
            startCharacter: m.index,
            endLine: i,
            endCharacter: m.index + full.length,
            source: "html",
          });
        } else if (last.tag !== tag) {
          diags.push({
            path,
            message: `Expected </${last.tag}> but found </${tag}>`,
            severity: "error",
            startLine: i,
            startCharacter: m.index,
            endLine: i,
            endCharacter: m.index + full.length,
            source: "html",
          });
        }
      } else if (!full.endsWith("/>") && !voidTags.has(tag)) {
        stack.push({ tag, line: i });
      }
    }
    offset += line.length + 1;
  }
  for (const open of stack.slice(-10)) {
    diags.push({
      path,
      message: `Unclosed tag <${open.tag}>`,
      severity: "warning",
      startLine: open.line,
      startCharacter: 0,
      endLine: open.line,
      endCharacter: 1,
      source: "html",
    });
  }
  return diags.slice(0, 40);
}

function shellDiagnostics(path: string, content: string): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (!t || t.startsWith("#")) continue;
    // unclosed quotes on a line (naive)
    const singles = (t.match(/'/g) || []).length;
    const doubles = (t.match(/"/g) || []).length;
    if (singles % 2 !== 0) {
      diags.push({
        path,
        message: "Unclosed single quote",
        severity: "error",
        startLine: i,
        startCharacter: 0,
        endLine: i,
        endCharacter: lines[i]!.length,
        source: "shell",
      });
    }
    if (doubles % 2 !== 0) {
      diags.push({
        path,
        message: "Unclosed double quote",
        severity: "error",
        startLine: i,
        startCharacter: 0,
        endLine: i,
        endCharacter: lines[i]!.length,
        source: "shell",
      });
    }
  }
  return diags;
}

function yamlDiagnostics(path: string, content: string): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("\t")) {
      diags.push({
        path,
        message: "YAML does not allow tabs for indentation",
        severity: "error",
        startLine: i,
        startCharacter: 0,
        endLine: i,
        endCharacter: 1,
        source: "yaml",
      });
    }
  }
  return diags;
}

// ─── TypeScript language service ───────────────────────────────────────

const SYMBOL_KIND: Record<string, string> = {
  [ts.ScriptElementKind.classElement]: "class",
  [ts.ScriptElementKind.interfaceElement]: "interface",
  [ts.ScriptElementKind.typeElement]: "type",
  [ts.ScriptElementKind.enumElement]: "enum",
  [ts.ScriptElementKind.enumMemberElement]: "enumMember",
  [ts.ScriptElementKind.moduleElement]: "module",
  [ts.ScriptElementKind.functionElement]: "function",
  [ts.ScriptElementKind.localFunctionElement]: "function",
  [ts.ScriptElementKind.memberFunctionElement]: "method",
  [ts.ScriptElementKind.memberGetAccessorElement]: "property",
  [ts.ScriptElementKind.memberSetAccessorElement]: "property",
  [ts.ScriptElementKind.memberVariableElement]: "property",
  [ts.ScriptElementKind.constructorImplementationElement]: "constructor",
  [ts.ScriptElementKind.constElement]: "constant",
  [ts.ScriptElementKind.letElement]: "variable",
  [ts.ScriptElementKind.variableElement]: "variable",
  [ts.ScriptElementKind.localVariableElement]: "variable",
};

export class LanguageServiceHub {
  private docs = new Map<string, OpenDoc>();
  private workspaceRoot: string | null = null;
  private service: ts.LanguageService | null = null;
  private compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
    checkJs: true,
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    strict: true,
    skipLibCheck: true,
    resolveJsonModule: true,
    noEmit: true,
    // Programmatic options take lib *file names* (tsconfig "es2022" → "lib.es2022.d.ts").
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  };
  private hostFiles = new Map<string, string>();
  /** Bumped for a file that is not open whenever it changes on disk (see filesChanged). */
  private diskVersions = new Map<string, number>();
  private tsPlugins: TsServerPluginSpec[] = [];
  private projectFiles: string[] = [];

  /** JSON schemas contributed by extensions (contributes.jsonValidation). */
  setJsonSchemas(associations: JsonSchemaAssociation[]) {
    setJsonSchemas(associations);
  }

  /** TypeScript server plug-ins contributed by extensions (contributes.typescriptServerPlugins). */
  setTsPlugins(specs: TsServerPluginSpec[]) {
    if (JSON.stringify(specs) === JSON.stringify(this.tsPlugins)) return;
    this.tsPlugins = specs;
    if (this.service) this.rebuildService();
  }

  /** Configuration of a plug-in, by its configKey. */
  setTsPluginConfig(key: string, config: unknown) {
    setTsPluginConfig(key, config);
  }

  setWorkspaceRoot(root: string | null) {
    this.workspaceRoot = root ? normalizePath(root) : null;
    this.projectFiles = [];
    this.rebuildService();
  }

  open(path: string, content: string, language: string) {
    path = normalizePath(path);
    if (isTypeScriptFamily(language)) {
      const existing = this.docs.get(path);
      this.docs.set(path, {
        path,
        content,
        language,
        version: (existing?.version ?? 0) + 1,
        scriptKind: toScriptKind(path, language),
      });
      this.hostFiles.set(path, content);
      this.ensureService();
    } else {
      // still track for non-ts diagnostics
      this.docs.set(path, {
        path,
        content,
        language,
        version: 1,
        scriptKind: ts.ScriptKind.TS,
      });
    }
  }

  change(path: string, content: string) {
    path = normalizePath(path);
    const doc = this.docs.get(path);
    if (!doc) return;
    doc.content = content;
    doc.version += 1;
    if (isTypeScriptFamily(doc.language)) {
      this.hostFiles.set(path, content);
    }
  }

  close(path: string) {
    path = normalizePath(path);
    this.docs.delete(path);
    this.hostFiles.delete(path);
  }

  /**
   * Files changed on disk (the workspace watcher): files that are not open are
   * read again, so renames and references are computed on what the files hold
   * now, not on the text read before a `git checkout` or a formatter run.
   */
  filesChanged(paths: string[]) {
    // Compiler options or installed packages changed: imports may resolve differently now,
    // which re-reading files does not redo (TypeScript reuses the program's resolutions).
    if (paths.some((path) => PROJECT_FILE.test(path))) {
      this.projectChanged();
      return;
    }
    for (const changed of paths) {
      const path = normalizePath(changed);
      if (this.docs.has(path)) continue;
      this.hostFiles.delete(path);
      this.diskVersions.set(path, (this.diskVersions.get(path) ?? 0) + 1);
    }
  }

  /** Start over with a new program (tsconfig changed, packages were installed): open documents are kept. */
  projectChanged() {
    if (this.service) this.rebuildService();
  }

  private ensureService() {
    if (!this.service) this.rebuildService();
  }

  private rebuildService() {
    const root = this.workspaceRoot;

    // Drop the texts the previous program read from disk (e.g. another
    // workspace's files); the new one reads what it needs on demand.
    this.hostFiles.clear();
    for (const [p, doc] of this.docs) {
      if (isTypeScriptFamily(doc.language)) {
        this.hostFiles.set(p, doc.content);
      }
    }

    if (root) {
      const configPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
      if (configPath) {
        const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
        if (!configFile.error) {
          const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, dirname(configPath));
          this.compilerOptions = {
            ...this.compilerOptions,
            ...parsed.options,
            noEmit: true,
            // Keep checkJs so JS files also surface issues
            allowJs: true,
          };
          if (parsed.fileNames?.length) {
            this.projectFiles = parsed.fileNames.map(normalizePath).slice(0, 800);
          }
        }
      }
      if (!this.projectFiles.length) {
        this.projectFiles = this.collectTsFiles(root, 300);
      }
    }

    const servicesHost: ts.LanguageServiceHost = {
      getCompilationSettings: () => this.compilerOptions,
      getScriptFileNames: () => {
        const names = new Set<string>(this.projectFiles);
        for (const [p, d] of this.docs) {
          if (isTypeScriptFamily(d.language)) names.add(p);
        }
        return [...names];
      },
      getScriptVersion: (fileName) => {
        fileName = normalizePath(fileName);
        const doc = this.docs.get(fileName);
        if (doc) return String(doc.version);
        // Another value than any open version: closing a document makes TypeScript read the file again.
        return `disk:${this.diskVersions.get(fileName) ?? 0}`;
      },
      getScriptSnapshot: (fileName) => {
        fileName = normalizePath(fileName);
        if (this.hostFiles.has(fileName)) {
          return ts.ScriptSnapshot.fromString(this.hostFiles.get(fileName)!);
        }
        // Default libs under TS_LIB_DIR
        const libPath = defaultLibFallback(fileName, root);
        if (libPath) {
          const text = readFileSync(libPath, "utf-8");
          this.hostFiles.set(fileName, text);
          return ts.ScriptSnapshot.fromString(text);
        }
        if (existsSync(fileName)) {
          const text = ts.sys.readFile(fileName);
          if (text !== undefined) {
            this.hostFiles.set(fileName, text);
            return ts.ScriptSnapshot.fromString(text);
          }
        }
        // try under TS lib dir by absolute getDefaultLibFileName path
        if (fileName.includes("typescript") && existsSync(fileName)) {
          const text = readFileSync(fileName, "utf-8");
          return ts.ScriptSnapshot.fromString(text);
        }
        return undefined;
      },
      getScriptKind: (fileName) => {
        fileName = normalizePath(fileName);
        const doc = this.docs.get(fileName);
        if (doc) return doc.scriptKind;
        return toScriptKind(fileName, "typescript");
      },
      getCurrentDirectory: () => root ?? process.cwd(),
      // IMPORTANT: return absolute path so libs resolve reliably
      getDefaultLibFileName: (options) => {
        const name = ts.getDefaultLibFileName(options);
        return join(TS_LIB_DIR, name);
      },
      fileExists: (fileName) => {
        if (this.hostFiles.has(normalizePath(fileName))) return true;
        return ts.sys.fileExists(fileName) || !!defaultLibFallback(fileName, root);
      },
      readFile: (fileName, encoding) => {
        fileName = normalizePath(fileName);
        if (this.hostFiles.has(fileName)) return this.hostFiles.get(fileName);
        const libPath = defaultLibFallback(fileName, root);
        if (libPath) return readFileSync(libPath, "utf-8");
        return ts.sys.readFile(fileName, encoding);
      },
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      realpath: ts.sys.realpath,
      getNewLine: () => "\n",
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    };

    if (this.service) this.service.dispose();
    const base = ts.createLanguageService(servicesHost, ts.createDocumentRegistry());
    this.service = this.tsPlugins.length
      ? applyTsServerPlugins(ts, base, servicesHost, this.tsPlugins, (message) => console.warn(`[lsp] ${message}`), root ?? process.cwd())
      : base;
  }

  private collectTsFiles(root: string, max: number): string[] {
    const out: string[] = [];
    const ignore = new Set(["node_modules", ".git", "dist", "build", "artifacts", "coverage", ".electrobun"]);
    const walk = (dir: string) => {
      if (out.length >= max) return;
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        if (out.length >= max) return;
        if (ignore.has(name)) continue;
        const full = join(dir, name);
        let isDir = false;
        try {
          isDir = statSync(full).isDirectory();
        } catch {
          continue;
        }
        if (isDir) walk(full);
        else if (/\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i.test(name)) {
          out.push(normalizePath(full));
        }
      }
    };
    walk(root);
    return out;
  }

  getCompletions(path: string, line: number, character: number): CompletionItem[] | Promise<CompletionItem[]> {
    path = normalizePath(path);
    const doc = this.docs.get(path);
    if (doc?.language === "json") return jsonCompletions(path, doc.content, line, character);
    if (!doc || !isTypeScriptFamily(doc.language) || !this.service) return [];

    const offset = offsetAt(doc.content, line, character);
    const info = this.service.getCompletionsAtPosition(path, offset, {
      includeCompletionsForModuleExports: true,
      includeCompletionsWithInsertText: true,
    });
    if (!info) return [];

    // Narrow to what has been typed before capping the list: entries come
    // alphabetically, so a plain slice drops e.g. "console" for "cons".
    const prefix = (/[\w$]*$/.exec(doc.content.slice(0, offset))?.[0] ?? "").toLowerCase();
    const rank = (name: string) => {
      const lower = name.toLowerCase();
      if (!prefix) return 0;
      if (lower.startsWith(prefix)) return 0;
      if (lower.includes(prefix)) return 1;
      return 2;
    };
    const entries = info.entries
      .filter((entry) => !prefix || rank(entry.name) < 2 || isSubsequence(prefix, entry.name.toLowerCase()))
      .sort((a, b) => rank(a.name) - rank(b.name) || a.sortText.localeCompare(b.sortText) || a.name.localeCompare(b.name))
      .slice(0, 80);

    // Details (signatures, docs) are costly: only for the entries likely to be seen.
    // Auto-import entries need format settings to describe their import edit.
    const formatSettings = ts.getDefaultFormatCodeSettings("\n");
    return entries.map((entry, index) => {
      let details: ts.CompletionEntryDetails | undefined;
      if (index < 25) {
        try {
          details = this.service!.getCompletionEntryDetails(path, offset, entry.name, formatSettings, entry.source, {}, entry.data);
        } catch {
          // One entry without details must not drop the whole completion list.
        }
      }
      return {
        label: entry.name,
        kind: COMPLETION_KIND[entry.kind] ?? "text",
        detail: displayPartsToString(details?.displayParts) || entry.kind,
        insertText: entry.insertText ?? entry.name,
        documentation: displayPartsToString(details?.documentation) || undefined,
      };
    });
  }

  getHover(path: string, line: number, character: number): HoverInfo | null | Promise<HoverInfo | null> {
    path = normalizePath(path);
    const doc = this.docs.get(path);
    if (doc?.language === "json") return jsonHover(path, doc.content, line, character);
    if (!doc || !isTypeScriptFamily(doc.language) || !this.service) return null;

    const offset = offsetAt(doc.content, line, character);
    const quick = this.service.getQuickInfoAtPosition(path, offset);
    if (!quick) return null;

    const display = displayPartsToString(quick.displayParts);
    const docs = displayPartsToString(quick.documentation);
    const start = positionAt(doc.content, quick.textSpan.start);
    const end = positionAt(doc.content, quick.textSpan.start + quick.textSpan.length);
    return {
      contents: docs ? `${display}\n\n${docs}` : display,
      range: {
        startLine: start.line,
        startCharacter: start.character,
        endLine: end.line,
        endCharacter: end.character,
      },
    };
  }

  getDefinition(path: string, line: number, character: number): DefinitionLocation | null {
    path = normalizePath(path);
    const doc = this.docs.get(path);
    if (!doc || !isTypeScriptFamily(doc.language) || !this.service) return null;

    const offset = offsetAt(doc.content, line, character);
    const defs = this.service.getDefinitionAtPosition(path, offset);
    if (!defs?.length) return null;

    const def = defs[0]!;
    let fileContent = this.hostFiles.get(normalizePath(def.fileName));
    if (fileContent === undefined && existsSync(def.fileName)) {
      fileContent = ts.sys.readFile(def.fileName) ?? "";
    }
    if (fileContent === undefined) return null;
    const pos = positionAt(fileContent, def.textSpan.start);
    return { path: def.fileName, line: pos.line, character: pos.character };
  }

  getDiagnostics(path: string): Diagnostic[] | Promise<Diagnostic[]> {
    path = normalizePath(path);
    const doc = this.docs.get(path);
    if (!doc) return [];

    // Non-TS languages
    if (!isTypeScriptFamily(doc.language)) {
      switch (doc.language) {
        case "json":
          return jsonDiagnostics(path, doc.content);
        // Pattern checks, not parsers: they can be wrong (a quote in a heredoc, `"""` in a
        // docstring), so they are hints, never errors in the Problems count.
        case "python":
          return asHints(pythonDiagnostics(path, doc.content));
        case "css":
          return asHints(cssDiagnostics(path, doc.content));
        case "html":
          return asHints(htmlDiagnostics(path, doc.content));
        case "shell":
          return asHints(shellDiagnostics(path, doc.content));
        case "yaml":
          return asHints(yamlDiagnostics(path, doc.content));
        default:
          return [];
      }
    }

    if (!this.service) this.ensureService();
    if (!this.service) return [];

    // Ensure latest content is in host
    this.hostFiles.set(path, doc.content);

    try {
      const syntactic = this.service.getSyntacticDiagnostics(path);
      const semantic = this.service.getSemanticDiagnostics(path);
      const suggestion = this.service.getSuggestionDiagnostics(path);
      const all = [...syntactic, ...semantic, ...suggestion];

      return all
        .filter((d) => d.start !== undefined)
        .map((d) => {
          // Prefer positions from the source file, fall back to doc content
          let startLine = 0;
          let startCharacter = 0;
          let endLine = 0;
          let endCharacter = 1;
          if (d.file && d.start !== undefined) {
            const start = d.file.getLineAndCharacterOfPosition(d.start);
            const end = d.file.getLineAndCharacterOfPosition(d.start + (d.length ?? 0));
            startLine = start.line;
            startCharacter = start.character;
            endLine = end.line;
            endCharacter = end.character;
          } else if (d.start !== undefined) {
            const start = positionAt(doc.content, d.start);
            const end = positionAt(doc.content, d.start + (d.length ?? 0));
            startLine = start.line;
            startCharacter = start.character;
            endLine = end.line;
            endCharacter = end.character;
          }

          const severity =
            d.category === ts.DiagnosticCategory.Error
              ? "error"
              : d.category === ts.DiagnosticCategory.Warning
                ? "warning"
                : d.category === ts.DiagnosticCategory.Suggestion
                  ? "hint"
                  : "info";

          return {
            path,
            message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
            severity: severity as Diagnostic["severity"],
            startLine,
            startCharacter,
            endLine,
            endCharacter,
            source: "typescript",
            code: d.code,
          };
        });
    } catch (e) {
      console.error("[lsp] getDiagnostics failed", e);
      return [
        {
          path,
          message: `Language service error: ${e instanceof Error ? e.message : String(e)}`,
          severity: "error",
          startLine: 0,
          startCharacter: 0,
          endLine: 0,
          endCharacter: 1,
          source: "typescript",
        },
      ];
    }
  }

  /** Source text + line starts for any file the program knows (open or on disk). */
  private sourceOf(fileName: string): ts.SourceFile | null {
    const program = this.service?.getProgram();
    return program?.getSourceFile(fileName) ?? program?.getSourceFile(normalizePath(fileName)) ?? null;
  }

  private rangeOf(fileName: string, start: number, length: number): TextRange | null {
    const source = this.sourceOf(fileName);
    if (!source) return null;
    const from = source.getLineAndCharacterOfPosition(start);
    const to = source.getLineAndCharacterOfPosition(start + length);
    return { startLine: from.line, startCharacter: from.character, endLine: to.line, endCharacter: to.character };
  }

  /** Resolve a position in an open TS/JS document to an offset, or null. */
  private offsetIn(path: string, line: number, character: number): { path: string; offset: number } | null {
    path = normalizePath(path);
    const doc = this.docs.get(path);
    if (!doc || !isTypeScriptFamily(doc.language) || !this.service) return null;
    this.hostFiles.set(path, doc.content);
    return { path, offset: offsetAt(doc.content, line, character) };
  }

  getReferences(path: string, line: number, character: number): ReferenceLocation[] {
    const target = this.offsetIn(path, line, character);
    if (!target) return [];
    const entries = this.service!.getReferencesAtPosition(target.path, target.offset) ?? [];
    const locations: ReferenceLocation[] = [];
    for (const entry of entries) {
      const range = this.rangeOf(entry.fileName, entry.textSpan.start, entry.textSpan.length);
      const source = this.sourceOf(entry.fileName);
      if (!range || !source) continue;
      const starts = source.getLineStarts();
      const lineEnd = range.startLine + 1 < starts.length ? starts[range.startLine + 1]! : source.text.length;
      const preview = source.text.slice(starts[range.startLine], lineEnd).replace(/\r?\n$/, "");
      locations.push({ ...range, path: normalizePath(entry.fileName), preview });
    }
    return locations;
  }

  getRenameEdits(path: string, line: number, character: number, newName: string): { edits: FileEdits[]; error?: string } {
    const target = this.offsetIn(path, line, character);
    if (!target) return { edits: [], error: "Rename is only available for TypeScript and JavaScript." };
    const service = this.service!;
    const info = service.getRenameInfo(target.path, target.offset, { allowRenameOfImportPath: false });
    if (!info.canRename) return { edits: [], error: info.localizedErrorMessage };

    const locations =
      service.findRenameLocations(target.path, target.offset, false, false, {
        providePrefixAndSuffixTextForRename: true,
      }) ?? [];
    const byFile = new Map<string, TextEdit[]>();
    for (const location of locations) {
      const range = this.rangeOf(location.fileName, location.textSpan.start, location.textSpan.length);
      if (!range) continue;
      const file = normalizePath(location.fileName);
      const edits = byFile.get(file) ?? [];
      edits.push({ ...range, newText: `${location.prefixText ?? ""}${newName}${location.suffixText ?? ""}` });
      byFile.set(file, edits);
    }
    return { edits: [...byFile].map(([file, edits]) => ({ path: file, edits })) };
  }

  getFormatEdits(path: string, tabSize: number, insertSpaces: boolean): TextEdit[] {
    const target = this.offsetIn(path, 0, 0);
    if (!target) return [];
    const settings: ts.FormatCodeSettings = {
      ...ts.getDefaultFormatCodeSettings("\n"),
      indentSize: tabSize,
      tabSize,
      convertTabsToSpaces: insertSpaces,
    };
    const edits = this.service!.getFormattingEditsForDocument(target.path, settings);
    const result: TextEdit[] = [];
    for (const edit of edits) {
      const range = this.rangeOf(target.path, edit.span.start, edit.span.length);
      if (range) result.push({ ...range, newText: edit.newText });
    }
    return result;
  }

  /** Outline for TS/JS documents; `null` when the language is not supported here. */
  getSymbols(path: string): DocumentSymbol[] | null {
    const target = this.offsetIn(path, 0, 0);
    if (!target) return null;
    const tree = this.service!.getNavigationTree(target.path);
    const convert = (item: ts.NavigationTree): DocumentSymbol | null => {
      if (item.kind === ts.ScriptElementKind.alias) return null;
      const span = item.spans[0];
      const range = span ? this.rangeOf(target.path, span.start, span.length) : null;
      if (!range) return null;
      const nameSpan = item.nameSpan ?? span!;
      const name = this.rangeOf(target.path, nameSpan.start, nameSpan.length) ?? range;
      const children = (item.childItems ?? []).map(convert).filter((c): c is DocumentSymbol => !!c);
      return {
        ...range,
        name: item.text,
        kind: SYMBOL_KIND[item.kind] ?? item.kind,
        line: name.startLine,
        character: name.startCharacter,
        children: children.length ? children : undefined,
      };
    };
    return (tree.childItems ?? []).map(convert).filter((c): c is DocumentSymbol => !!c);
  }

  /** Human-readable status for the status bar */
  getStatus(language: string): { label: string; active: boolean } {
    if (isTypeScriptFamily(language)) {
      return { label: "TypeScript", active: true };
    }
    if (["json", "python", "css", "html", "shell", "yaml"].includes(language)) {
      return { label: language, active: true };
    }
    return { label: "LSP idle", active: false };
  }
}

export const lsp = new LanguageServiceHub();
