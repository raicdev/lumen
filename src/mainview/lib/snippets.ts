/**
 * VS Code snippet syntax (`$1`, `${2:name}`, `${3|a,b|}`, `$TM_FILENAME`, `$0`)
 * → CodeMirror snippet templates (`${1}`, `${2:name}`, `${0}`). CodeMirror has
 * no nested placeholders or choices: nested fields become plain text and a
 * choice offers its first option.
 */

export type SnippetVariables = Record<string, string | undefined>;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The time-based and random variables (the editor adds TM_* and workspace ones). */
export function standardVariables(now = new Date()): SnippetVariables {
  const pad = (n: number) => String(n).padStart(2, "0");
  const offset = -now.getTimezoneOffset();
  const hex = (length: number) => Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return {
    CURRENT_YEAR: String(now.getFullYear()),
    CURRENT_YEAR_SHORT: String(now.getFullYear()).slice(-2),
    CURRENT_MONTH: pad(now.getMonth() + 1),
    CURRENT_MONTH_NAME: MONTHS[now.getMonth()],
    CURRENT_MONTH_NAME_SHORT: MONTHS[now.getMonth()]!.slice(0, 3),
    CURRENT_DATE: pad(now.getDate()),
    CURRENT_DAY_NAME: DAYS[now.getDay()],
    CURRENT_DAY_NAME_SHORT: DAYS[now.getDay()]!.slice(0, 3),
    CURRENT_HOUR: pad(now.getHours()),
    CURRENT_MINUTE: pad(now.getMinutes()),
    CURRENT_SECOND: pad(now.getSeconds()),
    CURRENT_SECONDS_UNIX: String(Math.floor(now.getTime() / 1000)),
    CURRENT_TIMEZONE_OFFSET: `${offset >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`,
    RANDOM: String(Math.random()).slice(2, 8),
    RANDOM_HEX: hex(6),
    UUID: crypto.randomUUID(),
  };
}

type Part = { kind: "text"; text: string } | { kind: "field"; index: number; text: string };

/** Parse into text and fields; returns the parts and how far it read. */
function parse(source: string, start: number, variables: SnippetVariables, stop: string | null): { parts: Part[]; end: number } {
  const parts: Part[] = [];
  let text = "";
  const flush = () => {
    if (text) parts.push({ kind: "text", text });
    text = "";
  };
  let i = start;
  while (i < source.length) {
    const ch = source[i]!;
    if (stop && ch === stop) break;
    if (ch === "\\" && i + 1 < source.length && "$}\\,|".includes(source[i + 1]!)) {
      text += source[i + 1];
      i += 2;
      continue;
    }
    if (ch !== "$") {
      text += ch;
      i++;
      continue;
    }
    // $1, $name
    const simple = /^\$(\d+|[A-Za-z_][A-Za-z0-9_]*)/.exec(source.slice(i));
    if (simple) {
      flush();
      const name = simple[1]!;
      if (/^\d+$/.test(name)) parts.push({ kind: "field", index: Number(name), text: "" });
      else parts.push(variable(name, undefined, variables));
      i += simple[0].length;
      continue;
    }
    // ${…}
    const braced = /^\$\{(\d+|[A-Za-z_][A-Za-z0-9_]*)/.exec(source.slice(i));
    if (!braced) {
      text += ch;
      i++;
      continue;
    }
    flush();
    const name = braced[1]!;
    i += braced[0].length;
    const next = source[i];
    if (next === "}") {
      parts.push(/^\d+$/.test(name) ? { kind: "field", index: Number(name), text: "" } : variable(name, undefined, variables));
      i++;
    } else if (next === ":") {
      const inner = parse(source, i + 1, variables, "}");
      const innerText = inner.parts.map((part) => part.text).join("");
      parts.push(/^\d+$/.test(name) ? { kind: "field", index: Number(name), text: innerText } : variable(name, innerText, variables));
      i = inner.end + 1;
    } else if (next === "|") {
      const end = source.indexOf("|}", i + 1);
      const options = source.slice(i + 1, end < 0 ? source.length : end).split(/(?<!\\),/).map((option) => option.replace(/\\(.)/g, "$1"));
      parts.push({ kind: "field", index: Number(name), text: options[0] ?? "" });
      i = end < 0 ? source.length : end + 2;
    } else if (next === "/") {
      // ${VAR/regex/format/options}: apply the transform roughly.
      const match = /^\/((?:\\.|[^/])*)\/((?:\\.|[^/])*)\/([a-z]*)\}/.exec(source.slice(i));
      const value = variables[name] ?? "";
      if (match) {
        let transformed = value;
        try {
          transformed = value.replace(new RegExp(match[1]!, match[3]), match[2]!.replace(/\$\{?(\d+)\}?/g, "$$$1"));
        } catch {
          /* keep the value */
        }
        parts.push({ kind: "text", text: transformed });
        i += match[0].length;
      } else {
        parts.push({ kind: "text", text: value });
        i = source.indexOf("}", i) + 1 || source.length;
      }
    } else {
      text += "${" + name;
    }
  }
  flush();
  return { parts, end: i };
}

function variable(name: string, fallback: string | undefined, variables: SnippetVariables): Part {
  const value = variables[name];
  if (value !== undefined && value !== "") return { kind: "text", text: value };
  if (fallback !== undefined) return { kind: "text", text: fallback };
  // Unknown variables become placeholders named after them, like VS Code.
  return name in variables ? { kind: "text", text: "" } : { kind: "field", index: -1, text: name };
}

const escapeText = (text: string) => text.replace(/[{}]/g, "\\$&");

/** A CodeMirror snippet template for a VS Code snippet. */
export function snippetToTemplate(body: string, variables: SnippetVariables = {}): string {
  const { parts } = parse(body, 0, { ...standardVariables(), ...variables }, null);
  let highest = 0;
  for (const part of parts) if (part.kind === "field") highest = Math.max(highest, part.index);
  return parts
    .map((part) => {
      if (part.kind === "text") return escapeText(part.text);
      const index = part.index < 0 ? ++highest : part.index;
      const text = part.text.replace(/[{}]/g, "");
      return text ? `\${${index}:${text}}` : `\${${index}}`;
    })
    .join("");
}

/** The snippet as plain text (placeholders filled in with their defaults). */
export function snippetToText(body: string, variables: SnippetVariables = {}): string {
  return parse(body, 0, { ...standardVariables(), ...variables }, null)
    .parts.map((part) => part.text)
    .join("");
}
