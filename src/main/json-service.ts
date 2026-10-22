import { readFile } from "fs/promises";
import { pathToFileURL, fileURLToPath } from "url";
import * as jsonLanguageServiceModule from "vscode-json-languageservice";
import type { JSONDocument, LanguageSettings, TextDocument as JsonTextDocument } from "vscode-json-languageservice";
import type { CompletionItem, Diagnostic, HoverInfo } from "../shared/types.ts";

// Under plain Node the package resolves to its UMD (CommonJS) build, whose
// exports only show up on `default`; the packaged bundle uses its ESM build.
const jsonLanguageService =
  (jsonLanguageServiceModule as { default?: typeof jsonLanguageServiceModule }).default ?? jsonLanguageServiceModule;
const { getLanguageService, TextDocument } = jsonLanguageService;

/**
 * JSON documents: syntax errors and JSON schema validation, completions and
 * hovers (vscode-json-languageservice, the library behind VS Code's own JSON
 * support). Schemas come from extensions (contributes.jsonValidation) and from
 * a document's own `$schema`.
 */

/** A contributes.jsonValidation entry: VS Code fileMatch patterns and the schema's URL. */
export type JsonSchemaAssociation = { fileMatch: string[]; url: string };

/** JSON with comments and trailing commas (VS Code's "jsonc" files). */
const JSONC_NAMES = new Set([
  "tsconfig.json",
  "jsconfig.json",
  "settings.json",
  "launch.json",
  "tasks.json",
  "keybindings.json",
  "extensions.json",
  "devcontainer.json",
  ".devcontainer.json",
  "language-configuration.json",
  ".eslintrc.json",
  ".babelrc",
  ".babelrc.json",
  ".swcrc",
  "typedoc.json",
  "api-extractor.json",
]);

export function isJsonc(path: string): boolean {
  const base = path.split(/[/\\]/).pop()?.toLowerCase() ?? "";
  return base.endsWith(".jsonc") || base.endsWith(".code-workspace") || JSONC_NAMES.has(base) || /^tsconfig\..*\.json$|^jsconfig\..*\.json$/.test(base);
}

const schemaCache = new Map<string, Promise<string>>();

/** Schema content by URI: files, or http(s) downloads (cached for the session). */
function requestSchema(uri: string): Promise<string> {
  let pending = schemaCache.get(uri);
  if (!pending) {
    pending = (async () => {
      if (uri.startsWith("file:")) return await readFile(fileURLToPath(uri), "utf8");
      if (/^https?:/.test(uri)) {
        const response = await fetch(uri, { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        return await response.text();
      }
      throw new Error(`Unsupported schema location: ${uri}`);
    })();
    // A failed download is retried the next time.
    pending.catch(() => schemaCache.delete(uri));
    schemaCache.set(uri, pending);
  }
  return pending;
}

const service = getLanguageService({
  schemaRequestService: requestSchema,
  // Hovers and completion docs render Markdown (schema markdownDescription).
  clientCapabilities: {
    textDocument: { completion: { completionItem: { documentationFormat: ["markdown", "plaintext"] } }, hover: { contentFormat: ["markdown", "plaintext"] } },
  },
  workspaceContext: { resolveRelativePath: (relative, resource) => new URL(relative, resource).toString() },
});

let associations: JsonSchemaAssociation[] = [];
const configure = () => {
  const settings: LanguageSettings = {
    validate: true,
    allowComments: false,
    schemas: associations.map((association) => ({ uri: association.url, fileMatch: association.fileMatch })),
  };
  service.configure(settings);
};
configure();

/** Schemas contributed by the enabled extensions (replaces the previous set). */
export function setJsonSchemas(next: JsonSchemaAssociation[]): void {
  associations = next;
  service.resetSchema("");
  schemaCache.clear();
  configure();
}

function parse(path: string, content: string): { document: JsonTextDocument; json: JSONDocument } {
  const uri = /^\w[\w+.-]+:/.test(path) && !/^[a-zA-Z]:[\\/]/.test(path) ? path : pathToFileURL(path).toString();
  const document = TextDocument.create(uri, isJsonc(path) ? "jsonc" : "json", 1, content);
  return { document, json: service.parseJSONDocument(document) };
}

const SEVERITIES: Diagnostic["severity"][] = ["error", "error", "warning", "info", "hint"];

export async function jsonDiagnostics(path: string, content: string): Promise<Diagnostic[]> {
  const { document, json } = parse(path, content);
  const jsonc = isJsonc(path);
  const diagnostics = await service.doValidation(document, json, { comments: jsonc ? "ignore" : "error", trailingCommas: jsonc ? "ignore" : "error" });
  return diagnostics.map((diagnostic) => ({
    path,
    message: typeof diagnostic.message === "string" ? diagnostic.message : diagnostic.message.value,
    severity: SEVERITIES[diagnostic.severity ?? 1] ?? "error",
    startLine: diagnostic.range.start.line,
    startCharacter: diagnostic.range.start.character,
    endLine: diagnostic.range.end.line,
    endCharacter: diagnostic.range.end.character,
    source: diagnostic.source ?? "json",
    code: typeof diagnostic.code === "number" || typeof diagnostic.code === "string" ? diagnostic.code : undefined,
  }));
}

/** LSP CompletionItemKind → the editor's completion types. */
const COMPLETION_KINDS: Record<number, string> = { 5: "property", 6: "variable", 7: "class", 9: "namespace", 10: "property", 12: "constant", 13: "enum", 14: "keyword", 15: "text", 17: "text", 20: "enumMember" };

const markdownOf = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(markdownOf).filter(Boolean).join("\n\n");
  if (value && typeof value === "object") {
    const v = value as { value?: string; language?: string };
    if (v.language && typeof v.value === "string") return `\`\`\`${v.language}\n${v.value}\n\`\`\``;
    return v.value ?? "";
  }
  return "";
};

export async function jsonCompletions(path: string, content: string, line: number, character: number): Promise<CompletionItem[]> {
  const { document, json } = parse(path, content);
  const list = await service.doComplete(document, { line, character }, json);
  return (list?.items ?? []).map((item) => {
    const edit = item.textEdit && "range" in item.textEdit ? item.textEdit : undefined;
    return {
      label: item.label,
      kind: COMPLETION_KINDS[item.kind ?? 0] ?? "text",
      detail: item.detail,
      documentation: markdownOf(item.documentation) || undefined,
      insertText: edit?.newText ?? item.insertText ?? item.label,
      snippet: item.insertTextFormat === 2,
      filterText: item.filterText,
      range: edit
        ? { startLine: edit.range.start.line, startCharacter: edit.range.start.character, endLine: edit.range.end.line, endCharacter: edit.range.end.character }
        : undefined,
    };
  });
}

export async function jsonHover(path: string, content: string, line: number, character: number): Promise<HoverInfo | null> {
  const { document, json } = parse(path, content);
  const hover = await service.doHover(document, { line, character }, json);
  const contents = hover ? markdownOf(hover.contents) : "";
  if (!hover || !contents) return null;
  const range = hover.range;
  return {
    contents,
    range: range ? { startLine: range.start.line, startCharacter: range.start.character, endLine: range.end.line, endCharacter: range.end.character } : undefined,
  };
}
