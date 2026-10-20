import { isAbsolute, join } from "node:path";

/**
 * Problem matchers: turn task output into diagnostics. Implements the shapes of
 * tasks.json `problemMatcher` and the `problemMatchers` / `problemPatterns`
 * contribution points: single and multi-line patterns (with `loop`), `base`,
 * `fileLocation`, `severity` and background (watching) begin / end patterns.
 */

export type MatcherPattern = {
  regexp: string;
  kind?: "file" | "location";
  file?: number;
  location?: number;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  severity?: number;
  code?: number;
  message?: number;
  loop?: boolean;
};

export type BackgroundPattern = string | { regexp: string; file?: number };

type BackgroundDef = { activeOnStart?: boolean; beginsPattern?: BackgroundPattern; endsPattern?: BackgroundPattern };

export type ProblemMatcherDef = {
  name?: string;
  base?: string;
  owner?: string;
  source?: string;
  severity?: string;
  applyTo?: "allDocuments" | "openDocuments" | "closedDocuments";
  fileLocation?: string | string[];
  pattern?: string | MatcherPattern | MatcherPattern[];
  background?: BackgroundDef;
  /** Deprecated spelling of `background`. */
  watching?: BackgroundDef;
};

export type FileLocationKind = "absolute" | "relative" | "autoDetect" | "search";

export type ResolvedMatcher = {
  owner: string;
  source?: string;
  severity?: "error" | "warning" | "info" | "hint";
  applyTo: "allDocuments" | "openDocuments" | "closedDocuments";
  fileLocation: { kind: FileLocationKind; base?: string };
  patterns: (MatcherPattern & { re: RegExp })[];
  background?: { activeOnStart: boolean; begins: RegExp; ends: RegExp };
};

export type ProblemMatch = {
  file: string;
  /** 1-based; 0 when the pattern has no location. */
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  severity: "error" | "warning" | "info" | "hint";
  code?: string;
  message: string;
};

const TS_FILE = "^([^\\s].*)[\\(:](\\d+)[,:](\\d+)(?:\\):\\s+|\\s+-\\s+)(error|warning|info)\\s+TS(\\d+)\\s*:\\s*(.*)$";
const TS_CLOCK = "(?:\\[?\\d{1,2}:\\d{1,2}:\\d{1,2}(?:\\s+(?:AM|PM))?\\]?)";
const STYLISH: MatcherPattern[] = [
  { regexp: "^([^\\s].*)$", kind: "file", file: 1 },
  { regexp: "^\\s+(\\d+):(\\d+)\\s+(error|warning|info)\\s+(.+?)(?:\\s\\s+(.*))?$", line: 1, column: 2, severity: 3, message: 4, code: 5, loop: true },
];

export const BUILTIN_PATTERNS: Record<string, MatcherPattern | MatcherPattern[]> = {
  "eslint-stylish": STYLISH,
  "eslint-compact": { regexp: "^(.+):\\sline\\s(\\d+),\\scol\\s(\\d+),\\s(Error|Warning|Info)\\s-\\s(.+)\\s\\((.+)\\)$", file: 1, line: 2, column: 3, severity: 4, message: 5, code: 6 },
};

export const BUILTIN_MATCHERS: Record<string, ProblemMatcherDef> = {
  tsc: { owner: "typescript", source: "ts", applyTo: "allDocuments", fileLocation: ["relative", "${cwd}"], pattern: { regexp: TS_FILE, file: 1, line: 2, column: 3, severity: 4, code: 5, message: 6 } },
  "tsc-watch": {
    base: "$tsc",
    background: {
      activeOnStart: true,
      beginsPattern: `^\\s*(?:message TS6032:|${TS_CLOCK}?\\s*(?:-\\s*)?(?:File change detected\\. Starting incremental compilation|Starting compilation in watch mode))`,
      endsPattern: `^\\s*(?:message TS6042:|${TS_CLOCK}?\\s*(?:-\\s*)?Found \\d+ errors?\\. Watching for file changes)`,
    },
  },
  "eslint-compact": { owner: "eslint", applyTo: "allDocuments", fileLocation: "absolute", pattern: "$eslint-compact" },
  "eslint-stylish": { owner: "eslint", applyTo: "allDocuments", fileLocation: "absolute", pattern: "$eslint-stylish" },
  gcc: { owner: "cpp", source: "gcc", fileLocation: ["relative", "${workspaceFolder}"], pattern: { regexp: "^(.*):(\\d+):(\\d+):\\s+(warning|error):\\s+(.*)$", file: 1, line: 2, column: 3, severity: 4, message: 5 } },
  go: { owner: "go", source: "go", fileLocation: ["relative", "${workspaceFolder}"], pattern: { regexp: "^\\s*(.*\\.go):(\\d+)(?::(\\d+))?:\\s+(.*)$", file: 1, line: 2, column: 3, message: 4 } },
  msCompile: { owner: "msCompile", source: "cpp", fileLocation: "absolute", pattern: { regexp: "^\\s*(?:\\s*\\d+>)?(\\S.*)\\((\\d+|\\d+,\\d+|\\d+,\\d+,\\d+,\\d+)\\)\\s*:\\s+(error|warning|info)\\s+(\\w{1,2}\\d+)\\s*:\\s*(.*)$", file: 1, location: 2, severity: 3, code: 4, message: 5 } },
  lessCompile: { owner: "lessCompile", source: "less", fileLocation: "absolute", severity: "error", pattern: { regexp: "^\\s*(.*) in file (.*) line no. (\\d+)$", message: 1, file: 2, line: 3 } },
  jshint: { owner: "jshint", source: "jshint", fileLocation: "absolute", pattern: { regexp: "^(.*):\\s+line\\s+(\\d+),\\s+col\\s+(\\d+),\\s(.+?)(?:\\s+\\((\\w)(\\d+)\\))?$", file: 1, line: 2, column: 3, message: 4, severity: 5, code: 6 } },
};

export type MatcherRegistry = {
  matchers: Map<string, ProblemMatcherDef>;
  patterns: Map<string, MatcherPattern | MatcherPattern[]>;
};

/** Built-ins plus what extensions contribute (`contributes.problemMatchers` / `problemPatterns`). */
export function createMatcherRegistry(contributes: { problemMatchers?: unknown; problemPatterns?: unknown }[] = []): MatcherRegistry {
  const registry: MatcherRegistry = {
    matchers: new Map(Object.entries(BUILTIN_MATCHERS)),
    patterns: new Map(Object.entries(BUILTIN_PATTERNS)),
  };
  for (const item of contributes) {
    for (const pattern of [item.problemPatterns ?? []].flat() as { name?: string; regexp?: string; patterns?: MatcherPattern[] }[]) {
      if (!pattern || typeof pattern.name !== "string") continue;
      const value = Array.isArray(pattern.patterns) ? pattern.patterns : typeof pattern.regexp === "string" ? (pattern as MatcherPattern) : undefined;
      if (value) registry.patterns.set(pattern.name.replace(/^\$/, ""), value);
    }
    for (const matcher of [item.problemMatchers ?? []].flat() as ProblemMatcherDef[]) {
      if (matcher && typeof matcher.name === "string") registry.matchers.set(matcher.name.replace(/^\$/, ""), matcher);
    }
  }
  return registry;
}

function compile(pattern: string | undefined): RegExp | undefined {
  if (!pattern) return undefined;
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}

function backgroundRegexp(pattern: BackgroundPattern | undefined): RegExp | undefined {
  return compile(typeof pattern === "string" ? pattern : pattern?.regexp);
}

function severityOf(value: string | undefined): ProblemMatch["severity"] | undefined {
  const text = value?.trim().toLowerCase();
  if (!text) return undefined;
  if (text.startsWith("e") || text.startsWith("f")) return "error";
  if (text.startsWith("w")) return "warning";
  if (text.startsWith("i") || text.startsWith("n")) return "info";
  if (text.startsWith("h")) return "hint";
  return undefined;
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

/** A definition with its `base` chain merged in. */
function flatten(definition: ProblemMatcherDef, registry: MatcherRegistry, depth = 0): ProblemMatcherDef {
  if (!definition.base || depth > 5) return definition;
  const base = registry.matchers.get(definition.base.replace(/^\$/, ""));
  return base ? { ...flatten(base, registry, depth + 1), ...stripUndefined(definition) } : definition;
}

function parseFileLocation(value: string | string[] | undefined): ResolvedMatcher["fileLocation"] {
  const kind = Array.isArray(value) ? value[0] : value;
  const base = Array.isArray(value) ? value[1] : undefined;
  if (kind === "relative" || kind === "autoDetect" || kind === "absolute" || kind === "search") return { kind, base };
  return { kind: "relative", base: "${workspaceFolder}" };
}

/** A `problemMatcher` reference (`"$tsc"`) or inline definition, resolved; undefined when it cannot match anything. */
export function resolveProblemMatcher(reference: string | ProblemMatcherDef, registry: MatcherRegistry): ResolvedMatcher | undefined {
  let definition: ProblemMatcherDef | undefined;
  if (typeof reference === "string") definition = registry.matchers.get(reference.replace(/^\$/, ""));
  else if (reference && typeof reference === "object") definition = reference;
  if (!definition) return undefined;
  const merged = flatten(definition, registry);

  const raw = merged.pattern;
  let list: MatcherPattern[] = [];
  if (typeof raw === "string") {
    const named = registry.patterns.get(raw.replace(/^\$/, ""));
    list = named === undefined ? [] : [named].flat();
  } else if (raw) {
    list = [raw].flat();
  }
  const patterns = list.flatMap((pattern) => {
    const re = compile(pattern.regexp);
    return re ? [{ ...pattern, re }] : [];
  });
  const background = merged.background ?? merged.watching;
  const begins = backgroundRegexp(background?.beginsPattern);
  const ends = backgroundRegexp(background?.endsPattern);
  // A background-only matcher is fine: it still tells when the task is active.
  if ((!patterns.length || patterns.length !== list.length) && !(begins && ends)) return undefined;
  return {
    owner: merged.owner ?? "external",
    source: merged.source,
    severity: severityOf(merged.severity),
    applyTo: merged.applyTo ?? "allDocuments",
    fileLocation: parseFileLocation(merged.fileLocation),
    patterns,
    background: begins && ends ? { activeOnStart: background?.activeOnStart ?? false, begins, ends } : undefined,
  };
}

/** Where a matched file name lives; `expand` substitutes `${workspaceFolder}`-style variables of the matcher's base. */
export function resolveMatchedFile(
  matcher: ResolvedMatcher,
  file: string,
  context: { cwd: string; expand: (text: string) => string; exists?: (path: string) => boolean },
): string {
  const text = file.trim().replace(/^file:\/\//, "");
  if (isAbsolute(text)) return text;
  const base = matcher.fileLocation.base ? context.expand(matcher.fileLocation.base) : context.cwd;
  switch (matcher.fileLocation.kind) {
    case "absolute":
      return text;
    case "autoDetect": {
      const relative = join(base, text);
      return context.exists?.(relative) === false ? text : relative;
    }
    default:
      return join(base, text);
  }
}

const FIELDS = ["location", "line", "column", "endLine", "endColumn", "severity", "code", "message"] as const;

/** Matches one task's output line by line. */
export class MatcherRunner {
  readonly matcher: ResolvedMatcher;
  #index = 0;
  #data: Record<string, string | undefined> = {};
  /** Background: whether the task is between a begin and an end marker. */
  active: boolean;

  constructor(matcher: ResolvedMatcher) {
    this.matcher = matcher;
    this.active = matcher.background?.activeOnStart ?? false;
  }

  /** `"begin"` / `"end"` when the line is a background marker. */
  backgroundSignal(line: string): "begin" | "end" | undefined {
    const background = this.matcher.background;
    if (!background) return undefined;
    // `end` wins when both match (a one-line compile).
    if (background.ends.test(line)) {
      this.active = false;
      return "end";
    }
    if (background.begins.test(line)) {
      this.active = true;
      this.#reset();
      return "begin";
    }
    return undefined;
  }

  #reset(): void {
    this.#index = 0;
    this.#data = {};
  }

  /** The problem the line completes, if any. */
  processLine(line: string): ProblemMatch | undefined {
    const patterns = this.matcher.patterns;
    if (!patterns.length) return undefined;
    const outcome = this.#attempt(line, this.#index);
    if (outcome !== false) return outcome;
    if (this.#index === 0) return undefined;
    // The sequence broke: start over from the first pattern with this line.
    this.#reset();
    const retry = this.#attempt(line, 0);
    return retry === false ? undefined : retry;
  }

  #attempt(line: string, index: number): ProblemMatch | undefined | false {
    const patterns = this.matcher.patterns;
    const pattern = patterns[index]!;
    const match = pattern.re.exec(line);
    if (!match) return false;
    if (pattern.file !== undefined && match[pattern.file] !== undefined) this.#data.file = match[pattern.file];
    for (const key of FIELDS) {
      const group = pattern[key];
      const value = group === undefined ? undefined : match[group];
      if (value !== undefined) this.#data[key] = value;
    }
    const last = patterns.length - 1;
    if (index < last) {
      this.#index = index + 1;
      return undefined;
    }
    const result = this.#build();
    if (pattern.loop && last > 0) {
      // Keep the file of the earlier patterns; drop what the last one reported.
      for (const key of FIELDS) delete this.#data[key];
      this.#index = last;
    } else this.#reset();
    return result;
  }

  #build(): ProblemMatch | undefined {
    const data = this.#data;
    if (!data.file) return undefined;
    let line = parseInt(data.line ?? "", 10);
    let column = parseInt(data.column ?? "", 10);
    let endLine = parseInt(data.endLine ?? "", 10);
    let endColumn = parseInt(data.endColumn ?? "", 10);
    if (data.location) {
      const parts = data.location.replace(/[()\s]/g, "").split(/[,.]/).map((part) => parseInt(part, 10));
      if (parts.length === 1) line = parts[0]!;
      else if (parts.length === 2) [line, column] = parts as [number, number];
      else if (parts.length === 3) [line, column, endColumn] = parts as [number, number, number];
      else [line, column, endLine, endColumn] = parts as [number, number, number, number];
    }
    const message = (data.message ?? "").trim();
    if (!message) return undefined;
    return {
      file: data.file,
      line: Number.isFinite(line) ? line : 0,
      column: Number.isFinite(column) ? column : 0,
      endLine: Number.isFinite(endLine) ? endLine : undefined,
      endColumn: Number.isFinite(endColumn) ? endColumn : undefined,
      severity: severityOf(data.severity) ?? this.matcher.severity ?? "error",
      code: data.code,
      message,
    };
  }
}
