import { resolve } from "path";
import { pathToFileURL } from "url";
import type { ExtensionDescription, LanguageContribution } from "../shared/extensions.ts";
import { matchGlob } from "../shared/glob.ts";

const EXT_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  html: "html",
  htm: "html",
  css: "css",
  scss: "css",
  less: "css",
  md: "markdown",
  mdx: "markdown",
  py: "python",
  pyw: "python",
  pyi: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  rb: "ruby",
  toml: "toml",
  yaml: "yaml",
  yml: "yaml",
  xml: "xml",
  svg: "xml",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  ps1: "shell",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  vue: "vue",
  svelte: "svelte",
  txt: "plaintext",
  log: "plaintext",
  env: "dotenv",
  gitignore: "gitignore",
  dockerfile: "dockerfile",
};

/** File associations contributed by extensions (contributes.languages), checked first. */
const contributedNames = new Map<string, string>();
/** Longest extension first, so `.d.ts`-style suffixes beat `.ts`. */
let contributedExtensions: [string, string][] = [];
/** Longest pattern first, like VS Code. */
let contributedPatterns: [string, string][] = [];
let contributedFirstLines: [RegExp, string][] = [];

export function setContributedLanguages(languages: LanguageContribution[]): void {
  contributedNames.clear();
  const extensions = new Map<string, string>();
  const patterns = new Map<string, string>();
  contributedFirstLines = [];
  for (const language of languages) {
    for (const name of language.filenames ?? []) contributedNames.set(name.toLowerCase(), language.id);
    for (const ext of language.extensions ?? []) extensions.set(ext.toLowerCase(), language.id);
    for (const pattern of language.filenamePatterns ?? []) patterns.set(pattern.toLowerCase(), language.id);
    if (language.firstLine) {
      try {
        contributedFirstLines.push([new RegExp(language.firstLine), language.id]);
      } catch {
        /* an invalid expression associates nothing */
      }
    }
  }
  contributedExtensions = [...extensions].sort((a, b) => b[0].length - a[0].length);
  contributedPatterns = [...patterns].sort((a, b) => b[0].length - a[0].length);
}

/**
 * The language of a file: contributed file names, file name patterns and
 * extensions, then Lumen's own associations; a file nothing claims (plain
 * text) is matched by its first line against contributed `firstLine`s.
 */
export function detectLanguage(filePath: string, firstLine?: string): string {
  const language = detectByName(filePath);
  if (language !== "plaintext" || firstLine === undefined) return language;
  for (const [expression, id] of contributedFirstLines) if (expression.test(firstLine)) return id;
  return language;
}

function detectByName(filePath: string): string {
  const base = filePath.split(/[/\\]/).pop()?.toLowerCase() ?? "";
  const named = contributedNames.get(base);
  if (named) return named;
  const lowerPath = filePath.toLowerCase();
  for (const [pattern, id] of contributedPatterns) if (matchGlob(pattern, pattern.includes("/") ? lowerPath : base)) return id;
  for (const [ext, id] of contributedExtensions) if (base.endsWith(ext)) return id;
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";
  if (base === ".gitignore" || base.endsWith(".gitignore")) return "gitignore";
  if (base.startsWith(".env")) return "dotenv";
  if (base === "makefile" || base === "gnumakefile") return "makefile";

  const ext = base.includes(".") ? base.split(".").pop()! : "";
  return EXT_MAP[ext] ?? "plaintext";
}

/** The first line of a file's text (for `firstLine` associations). */
export function firstLineOf(content: string): string {
  const end = content.search(/\r?\n/);
  return end === -1 ? content : content.slice(0, end);
}

/**
 * An extension's contributes.jsonValidation as schema associations, the way
 * VS Code reads them: `./` URLs are files of the extension, and file patterns
 * without a scheme or leading `/` (or `!`) match below any folder.
 */
export function jsonSchemaAssociations(extension: ExtensionDescription): { fileMatch: string[]; url: string }[] {
  const entries = extension.manifest.contributes?.jsonValidation;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry: { fileMatch?: unknown; url?: unknown }) => {
    const fileMatch = (Array.isArray(entry?.fileMatch) ? entry.fileMatch : [entry?.fileMatch]).filter((pattern): pattern is string => typeof pattern === "string" && !!pattern);
    if (!fileMatch.length || typeof entry.url !== "string" || !entry.url) return [];
    const url = /^[a-z][\w+.-]+:/i.test(entry.url) ? entry.url : pathToFileURL(resolve(extension.location, entry.url)).toString();
    return [{ fileMatch: fileMatch.map((pattern) => (/^(\w+:\/\/|\/|!)/.test(pattern) ? pattern : `/${pattern}`)), url }];
  });
}

/** Every language id Lumen knows (languages.getLanguages for extensions). */
export function languageIds(): string[] {
  return [...new Set([...Object.values(EXT_MAP), "makefile"])].sort();
}

export function isTypeScriptFamily(language: string): boolean {
  return language === "typescript" || language === "javascript";
}

/** Languages that get editor intelligence (diagnostics / completions where available). */
export function hasLanguageService(language: string): boolean {
  return (
    isTypeScriptFamily(language) ||
    language === "json" ||
    language === "python" ||
    language === "css" ||
    language === "html" ||
    language === "markdown" ||
    language === "yaml" ||
    language === "shell" ||
    language === "rust" ||
    language === "go" ||
    language === "sql" ||
    language === "xml"
  );
}

export function languageLabel(language: string): string {
  const labels: Record<string, string> = {
    typescript: "TypeScript",
    javascript: "JavaScript",
    json: "JSON",
    html: "HTML",
    css: "CSS",
    markdown: "Markdown",
    python: "Python",
    rust: "Rust",
    go: "Go",
    java: "Java",
    c: "C",
    cpp: "C++",
    csharp: "C#",
    php: "PHP",
    ruby: "Ruby",
    shell: "Shell",
    sql: "SQL",
    yaml: "YAML",
    toml: "TOML",
    xml: "XML",
    vue: "Vue",
    svelte: "Svelte",
    dockerfile: "Dockerfile",
    plaintext: "Plain Text",
  };
  return labels[language] ?? language;
}
