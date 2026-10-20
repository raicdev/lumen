import type { Diagnostic as WireDiagnostic, TextEdit as WireEdit, TextRange } from "../../shared/types.ts";
import * as T from "./types.ts";

/** Conversions from API values to the plain data posted to the view. */

const SEVERITIES: WireDiagnostic["severity"][] = ["error", "warning", "info", "hint"];

/** `2026-10-18 19:55:04.876` in local time (log lines). */
export function logTimestamp(date = new Date()): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/** Make values safe to post (Uri → components, class instances → plain data, no functions). */
export function toWire(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || typeof value !== "object") return typeof value === "function" ? undefined : value;
  if (depth > 12) return undefined;
  if (T.Uri.isUri(value)) return value.toJSON();
  if (Array.isArray(value)) return value.map((item) => toWire(item, depth + 1));
  if (value instanceof Uint8Array) return Array.from(value);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "function") out[key] = toWire(item, depth + 1);
  }
  if (value instanceof T.Range) Object.assign(out, value.toJSON());
  return out;
}

export function wireRange(range: { start: { line: number; character: number }; end: { line: number; character: number } }): TextRange {
  return { startLine: range.start.line, startCharacter: range.start.character, endLine: range.end.line, endCharacter: range.end.character };
}

export function wireEdit(edit: T.TextEdit): WireEdit {
  return { ...wireRange(edit.range), newText: edit.newText };
}

export function wireDiagnostic(diagnostic: T.Diagnostic): WireDiagnostic & { path: string } {
  const code = typeof diagnostic.code === "object" && diagnostic.code ? diagnostic.code.value : diagnostic.code;
  return {
    path: "",
    message: diagnostic.message,
    severity: SEVERITIES[diagnostic.severity ?? 0] ?? "error",
    ...wireRange(diagnostic.range),
    source: diagnostic.source,
    code,
  };
}

export function markdownOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const v = value as { value?: unknown; language?: string };
  if (typeof v.language === "string" && typeof v.value === "string") return `\`\`\`${v.language}\n${v.value}\n\`\`\``;
  return typeof v.value === "string" ? v.value : "";
}
