import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { extname, join, resolve } from "path";
import { API_SUPPORT, API_TYPES, CONTRIBUTION_SUPPORT, API_TYPES_COMPAT, API_TYPES_MISSING, supportOf } from "../../shared/extension-api.ts";
import type { CompatReport, ExtensionManifest, SupportLevel } from "../../shared/extensions.ts";
import { extractZip } from "./vsix.ts";

/**
 * VS Code → Lumen transpiler.
 *
 * Lumen's extension API mirrors VS Code's, so converting an extension is
 * mostly mechanical:
 *   - every `require("vscode")` / `import … from "vscode"` (including those in
 *     bundled dependencies such as vscode-languageclient) becomes "lumen";
 *   - the manifest gets a Lumen engine and a record of where it came from;
 *   - the code is scanned for the API members it uses, and each one is
 *     checked against Lumen's API table, giving a compatibility report
 *     (written next to the manifest as lumen-compat.json).
 */

export const TRANSPILER_VERSION = 1;
export const LUMEN_ENGINE = "^0.1.0";

const NAMESPACES = new Set([
  "commands",
  "window",
  "workspace",
  "languages",
  "env",
  "extensions",
  "l10n",
  "debug",
  "tasks",
  "scm",
  "tests",
  "notebooks",
  "authentication",
  "comments",
  "chat",
  "lm",
]);
const TYPES = new Set(API_TYPES);
const COMPAT_TYPES = new Set(API_TYPES_COMPAT);
const MISSING_TYPES = new Set(API_TYPES_MISSING);
const TOP_LEVEL = new Set(["version"]);

/** Activation events that Lumen never raises. */
const SILENT_EVENTS =
  /^(onTaskType|onUri|onNotebook|onAuthenticationRequest|onTerminalProfile|onSearch|onWalkthrough|onOpenExternalUri|onIssueReporterOpened|onChatParticipant|onLanguageModelTool)\b/;

/** Features whose absence makes an extension mostly useless. */
// Every namespace is implemented now (some partially); only unknown members still count as unsupported.
const CORE_UNSUPPORTED = /^(?!)/;
const CORE_CONTRIBUTIONS = new Set(["views"]);

/* ── source rewriting ─────────────────────────────────────────────────────── */

const MODULE_PATTERNS: RegExp[] = [
  /(\brequire\s*\(\s*)(["'`])vscode\2(\s*\))/g,
  /(\bimport\s*\(\s*)(["'`])vscode\2(\s*\))/g,
  /(\bfrom\s*)(["'])vscode\2()/g,
  /(\bimport\s+)(["'])vscode\2()/g,
];

/** Rewrite the module specifier "vscode" to "lumen". */
export function transpileSource(code: string): { code: string; rewrites: number } {
  let rewrites = 0;
  let next = code;
  for (const pattern of MODULE_PATTERNS) {
    next = next.replace(pattern, (_match, before: string, quote: string, after: string) => {
      rewrites++;
      return `${before}${quote}lumen${quote}${after}`;
    });
  }
  return { code: next, rewrites };
}

/* ── API usage ────────────────────────────────────────────────────────────── */

const MODULE = `["'\`](?:vscode|lumen)["'\`]`;
const ALIAS_PATTERNS = [
  // const vscode = require("vscode"), var o=require("vscode")
  // (not `module.exports = require("vscode")`: webpack re-exports are handled by the fallback below)
  new RegExp(`(?<![\\w$.])([A-Za-z_$][\\w$]*)\\s*=\\s*require\\(\\s*${MODULE}\\s*\\)`, "g"),
  // esbuild / tsc interop wrappers: __toESM(require("vscode")), __importStar(require("vscode"))
  new RegExp(`(?<![\\w$.])([A-Za-z_$][\\w$]*)\\s*=\\s*[A-Za-z_$][\\w$]*\\(\\s*require\\(\\s*${MODULE}\\s*\\)`, "g"),
  new RegExp(`\\bimport\\s+\\*\\s+as\\s+([A-Za-z_$][\\w$]*)\\s+from\\s*${MODULE}`, "g"),
  new RegExp(`\\bimport\\s+([A-Za-z_$][\\w$]*)\\s*(?:,\\s*\\{[^}]*\\})?\\s*from\\s*${MODULE}`, "g"),
];
const DESTRUCTURE_PATTERNS = [
  new RegExp(`\\{([^{}]*)\\}\\s*=\\s*require\\(\\s*${MODULE}\\s*\\)`, "g"),
  new RegExp(`\\bimport\\s*(?:[A-Za-z_$][\\w$]*\\s*,\\s*)?\\{([^}]*)\\}\\s*from\\s*${MODULE}`, "g"),
];
const KNOWN_MEMBERS = new Set(Object.keys(API_SUPPORT).filter((key) => !key.endsWith(".*")));

type Usage = Map<string, number>;

function bump(usage: Usage, name: string) {
  usage.set(name, (usage.get(name) ?? 0) + 1);
}

/** `window.showQuickPick`-style members: known ones always, unknown ones only through trusted aliases. */
function countMember(usage: Usage, namespace: string, member: string, trusted: boolean) {
  const name = `${namespace}.${member}`;
  if (KNOWN_MEMBERS.has(name) || (trusted && /^[a-z][A-Za-z0-9]{2,}$/.test(member))) bump(usage, name);
}

/** Record which API members a file uses. */
export function scanApiUsage(code: string, usage: Usage): void {
  if (!/["'`](?:vscode|lumen)["'`]/.test(code)) return;
  const aliases = new Set<string>();
  const namespaces = new Map<string, string>(); // local name → namespace
  for (const pattern of ALIAS_PATTERNS) for (const match of code.matchAll(pattern)) aliases.add(match[1]!);
  for (const pattern of DESTRUCTURE_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      for (const part of match[1]!.split(",")) {
        const [imported, local] = part
          .trim()
          .split(/\s*(?::|\bas\b)\s*/)
          .map((s) => s.trim());
        if (!imported) continue;
        if (NAMESPACES.has(imported)) namespaces.set(local || imported, imported);
        else if (TYPES.has(imported) || TOP_LEVEL.has(imported) || COMPAT_TYPES.has(imported) || MISSING_TYPES.has(imported)) bump(usage, imported);
      }
    }
  }

  for (const alias of aliases) {
    // Minifiers reuse short names for other values: only trust known API names for those.
    const trusted = alias.length >= 3;
    const access = new RegExp(`(?<![\\w$.])${alias.replace(/\$/g, "\\$")}\\s*\\.\\s*([A-Za-z_$][\\w$]*)(?:\\s*\\.\\s*([A-Za-z_$][\\w$]*))?`, "g");
    for (const match of code.matchAll(access)) {
      const [, first, second] = match;
      if (NAMESPACES.has(first!)) {
        if (second) countMember(usage, first!, second, trusted);
      } else if (TYPES.has(first!) || TOP_LEVEL.has(first!) || COMPAT_TYPES.has(first!) || MISSING_TYPES.has(first!)) bump(usage, first!);
    }
  }
  for (const [local, namespace] of namespaces) {
    const access = new RegExp(`(?<![\\w$.])${local.replace(/\$/g, "\\$")}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, "g");
    for (const match of code.matchAll(access)) countMember(usage, namespace, match[1]!, local.length >= 3);
  }

  // Bundles that load the module through their own loader (webpack): look for
  // `.window.createWebviewPanel(`-style accesses of known API members.
  if (!aliases.size && !namespaces.size) {
    for (const match of code.matchAll(/\.\s*([a-z]+)\s*\.\s*([A-Za-z_$][\w$]*)/g)) {
      const name = `${match[1]}.${match[2]}`;
      if (NAMESPACES.has(match[1]!) && KNOWN_MEMBERS.has(name)) bump(usage, name);
    }
  }
}

function statusOfMember(name: string): { status: SupportLevel; note?: string } {
  if (TYPES.has(name) || TOP_LEVEL.has(name)) return { status: "supported" };
  if (COMPAT_TYPES.has(name)) return { status: "partial", note: "data-only class; its feature is not available in Lumen" };
  if (MISSING_TYPES.has(name)) return { status: "unsupported", note: "not exported by Lumen" };
  return supportOf(name) ?? { status: "unsupported", note: "not part of Lumen's API" };
}

/* ── manifest ─────────────────────────────────────────────────────────────── */

/** Turn a VS Code manifest into a Lumen manifest (pure). */
export function transpileManifest(source: ExtensionManifest): {
  manifest: ExtensionManifest;
  contributions: CompatReport["contributions"];
  warnings: string[];
} {
  const warnings: string[] = [];
  const manifest: ExtensionManifest = structuredClone(source);
  const vscodeEngine = source.engines?.vscode;
  manifest.engines = { ...source.engines, lumen: LUMEN_ENGINE };
  manifest.lumen = {
    transpiledFrom: "vscode",
    vscodeEngine,
    transpilerVersion: TRANSPILER_VERSION,
    transpiledAt: new Date().toISOString(),
  };

  if (!source.main && source.browser) {
    warnings.push("This is a web extension (browser entry only); Lumen runs Node.js extensions, so its code will not load.");
  }
  for (const event of source.activationEvents ?? []) {
    if (SILENT_EVENTS.test(event)) warnings.push(`Activation event “${event}” is never raised by Lumen.`);
  }
  for (const dependency of source.extensionDependencies ?? []) {
    if (dependency !== "vscode.git" && !dependency.startsWith("vscode.")) {
      warnings.push(`Depends on the extension “${dependency}”: install it as well.`);
    } else warnings.push(`Depends on VS Code's built-in “${dependency}”, which Lumen does not have.`);
  }

  const contributions: CompatReport["contributions"] = [];
  for (const point of Object.keys(source.contributes ?? {})) {
    const entry = CONTRIBUTION_SUPPORT[point];
    const [status, note] = !entry ? (["unsupported", undefined] as const) : typeof entry === "string" ? [entry, undefined] : entry;
    contributions.push({ name: point, status, note });
  }
  return { manifest, contributions, warnings };
}

/** Whether a manifest targets VS Code (and has not been transpiled yet). */
export function isVscodeManifest(manifest: ExtensionManifest): boolean {
  return !!manifest.engines?.vscode && !manifest.engines?.lumen;
}

/* ── whole extensions ─────────────────────────────────────────────────────── */

const SCRIPT_EXTENSIONS = new Set([".js", ".cjs", ".mjs"]);
const MAX_SCRIPT_SIZE = 24 * 1024 * 1024;

function walkScripts(dir: string, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const full = join(dir, name);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) walkScripts(full, out);
    else if (SCRIPT_EXTENSIONS.has(extname(name)) && stats.size <= MAX_SCRIPT_SIZE) out.push(full);
  }
  return out;
}

type Rating = Pick<CompatReport, "level" | "coverage" | "partialGrade">;

/** Coverage at or above which a partial extension mostly works / about half of it works. */
const PARTIAL_HIGH = 75;
const PARTIAL_MEDIUM = 40;

/** Share (0–100) of what an extension uses that works: distinct APIs and contribution points, partial ones counting half. */
function coverageOf(report: Pick<CompatReport, "apis" | "contributions">): number {
  const used = [...report.apis, ...report.contributions];
  if (!used.length) return 100;
  const score = used.reduce((sum, entry) => sum + (entry.status === "supported" ? 1 : entry.status === "partial" ? 0.5 : 0), 0);
  return Math.round((score / used.length) * 100);
}

function summarize(report: Omit<CompatReport, keyof Rating>): Rating {
  const level = levelOf(report);
  const coverage = coverageOf(report);
  // partialGrade is always set (undefined too), so it replaces the grade of a stored report.
  if (level !== "partial") return { level, coverage, partialGrade: undefined };
  const partialGrade = coverage >= PARTIAL_HIGH ? "high" : coverage >= PARTIAL_MEDIUM ? "medium" : "low";
  return { level, coverage, partialGrade };
}

function levelOf(report: Omit<CompatReport, keyof Rating>): CompatReport["level"] {
  const usedUnsupported = report.apis.filter((api) => api.status === "unsupported");
  const coreMissing =
    usedUnsupported.some((api) => CORE_UNSUPPORTED.test(api.name)) ||
    report.contributions.some((c) => c.status === "unsupported" && CORE_CONTRIBUTIONS.has(c.name)) ||
    report.warnings.some((w) => w.startsWith("This is a web extension"));
  if (coreMissing) return "limited";
  // Nothing it uses works: the code only calls missing APIs (or, without code, only missing contribution points).
  const used = report.apis.length ? report.apis : report.contributions;
  if (used.length && used.every((entry) => entry.status === "unsupported")) return "limited";
  const anyGap =
    usedUnsupported.length > 0 || report.apis.some((api) => api.status === "partial") || report.contributions.some((c) => c.status !== "supported");
  return anyGap ? "partial" : "full";
}

export type TranspileResult = { manifest: ExtensionManifest; report: CompatReport };

/**
 * Transpile an unpacked VS Code extension. With `target` the extension is
 * copied there first; otherwise it is converted in place. `write: false` only
 * analyzes (extensions loaded from a development folder run through the
 * compatibility layer instead, so their sources stay untouched).
 */
export function transpileExtension(sourceDir: string, target?: string, options: { write?: boolean } = {}): TranspileResult {
  const write = options.write !== false;
  const dir = resolve(target ?? sourceDir);
  if (write && target && resolve(target) !== resolve(sourceDir)) cpSync(sourceDir, dir, { recursive: true });
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) throw new Error("package.json not found — is this a VS Code extension?");
  const original = JSON.parse(readFileSync(manifestPath, "utf8")) as ExtensionManifest;
  if (!original.name || !original.version) throw new Error("package.json needs a name and a version");

  const { manifest, contributions, warnings } = transpileManifest(original);
  const usage: Usage = new Map();
  let rewrittenImports = 0;
  let filesRewritten = 0;
  const scripts = walkScripts(dir);
  for (const file of scripts) {
    let code: string;
    try {
      code = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    scanApiUsage(code, usage);
    const { code: next, rewrites } = transpileSource(code);
    if (!rewrites) continue;
    if (write) writeFileSync(file, next, "utf8");
    rewrittenImports += rewrites;
    filesRewritten++;
  }
  if (manifest.main && !rewrittenImports && scripts.length) {
    warnings.push("No reference to the “vscode” module was found; the extension may load it in a way Lumen cannot see.");
  }
  if (manifest.main && !existsSync(join(dir, manifest.main)) && !existsSync(join(dir, `${manifest.main}.js`))) {
    warnings.push(`The entry point ${manifest.main} is missing from the package.`);
  }

  const apis = [...usage].map(([name, count]) => ({ name, count, ...statusOfMember(name) })).sort((a, b) => a.name.localeCompare(b.name));
  const partialReport = {
    transpilerVersion: TRANSPILER_VERSION,
    rewrittenImports,
    filesScanned: scripts.length,
    filesRewritten,
    apis,
    contributions,
    warnings,
  };
  const report: CompatReport = { ...partialReport, ...summarize(partialReport) };
  if (write) {
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    writeFileSync(join(dir, "lumen-compat.json"), JSON.stringify(report, null, 2), "utf8");
  }
  return { manifest, report };
}

/**
 * A stored report, re-rated against the current API table: lumen-compat.json
 * is written at install time, and APIs supported since then must not stay
 * "unsupported".
 */
/** Warnings derived from the manifest (recomputed on refresh); the others come from scanning the code. */
const MANIFEST_WARNING = /^(Activation event “|Depends on |This is a web extension)/;

export function refreshReport(report: CompatReport, manifest: ExtensionManifest): CompatReport {
  const apis = report.apis.map(({ name, count }) => ({ name, count, ...statusOfMember(name) }));
  const { contributions, warnings: manifestWarnings } = transpileManifest(manifest);
  // e.g. "onDebug… is never raised" goes away once Lumen raises the event.
  const warnings = [...manifestWarnings, ...report.warnings.filter((warning) => !MANIFEST_WARNING.test(warning))];
  const partialReport = { ...report, apis, contributions, warnings };
  return { ...partialReport, ...summarize(partialReport) };
}

/** Unpack a .vsix into `target` and transpile it there. */
export function transpileVsix(vsix: Buffer, target: string): TranspileResult {
  const files = extractZip(vsix, target, "extension/");
  if (!files) throw new Error("the package has no extension/ folder — is this a .vsix file?");
  return transpileExtension(target);
}

/** Human readable summary of a report (CLI and logs). */
export function formatReport(manifest: ExtensionManifest, report: CompatReport, location?: string): string {
  const lines: string[] = [];
  const id = `${manifest.publisher ?? "unknown"}.${manifest.name}`;
  lines.push(`${manifest.displayName ?? manifest.name} (${id}@${manifest.version})`);
  if (location) lines.push(`  → ${location}`);
  const grade = report.partialGrade ? ` (${report.partialGrade})` : "";
  lines.push(`  compatibility: ${report.level}${grade}${report.coverage !== undefined ? `, ${report.coverage}% of what it uses works` : ""}`);
  lines.push(`  ${report.rewrittenImports} import(s) rewritten in ${report.filesRewritten} of ${report.filesScanned} script(s)`);
  const by = (status: SupportLevel) => report.apis.filter((api) => api.status === status);
  for (const status of ["unsupported", "partial"] as const) {
    const list = by(status);
    if (!list.length) continue;
    lines.push(`  ${status} APIs:`);
    for (const api of list) lines.push(`    - ${api.name} ×${api.count}${api.note ? ` (${api.note})` : ""}`);
  }
  lines.push(`  supported APIs: ${by("supported").length}`);
  const gaps = report.contributions.filter((c) => c.status !== "supported");
  if (gaps.length) {
    lines.push("  contributions:");
    for (const c of gaps) lines.push(`    - ${c.name}: ${c.status}${c.note ? ` (${c.note})` : ""}`);
  }
  for (const warning of report.warnings) lines.push(`  ! ${warning}`);
  return lines.join("\n");
}
