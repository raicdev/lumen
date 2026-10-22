/**
 * Shell integration: the escape sequences a prompt script emits (VS Code's
 * OSC 633 and the FinalTerm OSC 133 subset) and a streaming parser for them.
 *
 *   OSC 633 ; A          prompt start            (133 ; A)
 *   OSC 633 ; B          prompt end / input      (133 ; B)
 *   OSC 633 ; C          command is executing    (133 ; C)
 *   OSC 633 ; D [; code] command finished        (133 ; D [; code])
 *   OSC 633 ; E ; line [; nonce]   the command line (escaped: `\` and `\xHH`)
 *   OSC 633 ; P ; K=V [; nonce]    property (Cwd)
 *
 * Used by the window (xterm data) and by tests; no DOM or Node APIs.
 */

export type ShellIntegrationEvent =
  | { type: "prompt-start" }
  | { type: "command-start" }
  /** `nonceVerified`: the line came with the nonce this terminal was started with (nothing else can produce it). */
  | { type: "command-line"; commandLine: string; nonceVerified: boolean }
  | { type: "executing" }
  | { type: "finished"; exitCode: number | undefined }
  | { type: "property"; key: string; value: string }
  /** Raw terminal output between `executing` and `finished` (our sequences removed). */
  | { type: "output"; data: string };

/** Undo the escaping of `OSC 633 ; E` and `P` values. */
export function unescapeIntegrationValue(value: string): string {
  return value.replace(/\\(\\|x([0-9a-fA-F]{2}))/g, (_match, whole: string, hex?: string) => (hex ? String.fromCharCode(parseInt(hex, 16)) : whole));
}

/** The inverse (what the shell scripts do). */
export function escapeIntegrationValue(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === "\\") out += "\\\\";
    else if (char === ";" || code < 0x20) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += char;
  }
  return out;
}

const MAX_SEQUENCE = 8192;

/** Could `body` (the text after `ESC ]` so far) still turn into one of our sequences? */
function mayBeOurs(body: string): boolean {
  const head = body.slice(0, 4);
  return "633;".startsWith(head) || "133;".startsWith(head) || /^[61]33;/.test(head);
}

export class ShellIntegrationParser {
  #pending = "";
  #executing = false;
  /** True once any integration sequence was seen. */
  detected = false;

  /**
   * `nonce`: when set, `E` and `P` sequences must end with it (`;<nonce>`), so
   * output of a program or file cannot forge the command line or cwd.
   */
  readonly #nonce: string | undefined;

  constructor(nonce?: string) {
    this.#nonce = nonce;
  }

  get executing(): boolean {
    return this.#executing;
  }

  feed(chunk: string): ShellIntegrationEvent[] {
    const data = this.#pending + chunk;
    this.#pending = "";
    const events: ShellIntegrationEvent[] = [];
    let textStart = 0;
    let index = 0;
    const flushText = (end: number) => {
      if (this.#executing && end > textStart) events.push({ type: "output", data: data.slice(textStart, end) });
    };

    while (index < data.length) {
      const start = data.indexOf("\x1b]", index);
      if (start < 0) {
        if (data.endsWith("\x1b")) {
          flushText(data.length - 1);
          this.#pending = "\x1b";
          textStart = data.length;
        }
        break;
      }
      const bodyStart = start + 2;
      let end = -1;
      let terminatorLength = 0;
      for (let at = bodyStart; at < data.length; at++) {
        const char = data[at];
        if (char === "\x07") {
          end = at;
          terminatorLength = 1;
          break;
        }
        if (char === "\x1b" && data[at + 1] === "\\") {
          end = at;
          terminatorLength = 2;
          break;
        }
      }
      if (end < 0) {
        const body = data.slice(bodyStart);
        if (body.length <= MAX_SEQUENCE && mayBeOurs(body)) {
          flushText(start);
          this.#pending = data.slice(start);
          textStart = data.length;
          break;
        }
        index = bodyStart;
        continue;
      }
      const body = data.slice(bodyStart, end);
      const match = /^(633|133);([A-Z])(.*)$/s.exec(body);
      if (!match) {
        index = end + terminatorLength;
        continue;
      }
      flushText(start);
      this.detected = true;
      this.#handle(match[1] as "633" | "133", match[2]!, match[3]!, events);
      index = textStart = end + terminatorLength;
    }
    if (textStart < data.length && !this.#pending) flushText(data.length);
    return events;
  }

  #handle(scheme: "633" | "133", code: string, rest: string, events: ShellIntegrationEvent[]) {
    switch (code) {
      case "A":
        // A new prompt while a command was "running": the end marker got lost.
        if (this.#executing) {
          this.#executing = false;
          events.push({ type: "finished", exitCode: undefined });
        }
        events.push({ type: "prompt-start" });
        break;
      case "B":
        events.push({ type: "command-start" });
        break;
      case "C":
        if (this.#executing) events.push({ type: "finished", exitCode: undefined });
        events.push({ type: "executing" });
        this.#executing = true;
        break;
      case "D": {
        const parsed = rest.startsWith(";") ? Number.parseInt(rest.slice(1), 10) : Number.NaN;
        if (this.#executing) {
          this.#executing = false;
          events.push({ type: "finished", exitCode: Number.isNaN(parsed) ? undefined : parsed });
        }
        break;
      }
      case "E":
        if (scheme === "633" && rest.startsWith(";")) {
          // `;<escaped line>[;<nonce>]`: the line has no raw `;` (it is escaped).
          const [line = "", sent] = rest.slice(1).split(";");
          if (this.#nonce !== undefined && sent !== this.#nonce) break;
          events.push({ type: "command-line", commandLine: unescapeIntegrationValue(line), nonceVerified: this.#nonce !== undefined });
        }
        break;
      case "P":
        if (scheme === "633" && rest.startsWith(";")) {
          const [pair = "", sent] = rest.slice(1).split(";");
          if (this.#nonce !== undefined && sent !== this.#nonce) break;
          const equals = pair.indexOf("=");
          if (equals > 0) events.push({ type: "property", key: pair.slice(0, equals), value: unescapeIntegrationValue(pair.slice(equals + 1)) });
        }
        break;
    }
  }
}
