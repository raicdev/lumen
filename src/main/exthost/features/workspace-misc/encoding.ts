/** Text encodings of workspace.decode / workspace.encode (VS Code encoding ids: `utf8`, `utf8bom`, `utf16le`, `utf16be`, `windows1252`, `iso88591`, ...). */

/** `UTF-8`, `utf_8`, `Windows-1252` → `utf8`, `windows1252`. */
export function normalizeEncoding(id: string | undefined | null): string | undefined {
  if (!id || typeof id !== "string") return undefined;
  const key = id.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (key === "latin1") return "iso88591";
  if (key === "usascii") return "ascii";
  if (key === "utf16") return "utf16le";
  return key || undefined;
}

/** The encoding a byte order mark announces. */
export function detectBom(bytes: Uint8Array): "utf8bom" | "utf16le" | "utf16be" | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf8bom";
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return "utf16le";
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return "utf16be";
  return undefined;
}

/** TextDecoder label for an encoding id (`shiftjis` → `shift_jis`, `windows1250` → `windows-1250`). */
function decoderLabel(key: string): string {
  const table: Record<string, string> = { shiftjis: "shift_jis", eucjp: "euc-jp", euckr: "euc-kr", gbk: "gbk", gb18030: "gb18030", gb2312: "gbk", big5: "big5", koi8r: "koi8-r", koi8u: "koi8-u", macintosh: "macintosh" };
  if (table[key]) return table[key]!;
  const windows = /^windows(\d{4})$/.exec(key);
  if (windows) return `windows-${windows[1]}`;
  const iso = /^iso8859(\d{1,2})$/.exec(key);
  if (iso) return `iso-8859-${iso[1]}`;
  return key;
}

function swapBytes(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length - (bytes.length % 2));
  for (let i = 0; i < out.length; i += 2) {
    out[i] = bytes[i + 1]!;
    out[i + 1] = bytes[i]!;
  }
  return out;
}

/** Bytes → text. Without an encoding the BOM decides, UTF-8 otherwise; a BOM is never part of the text. */
export function decodeBytes(bytes: Uint8Array, encoding?: string): string {
  const key = normalizeEncoding(encoding) ?? detectBom(bytes) ?? "utf8";
  switch (key) {
    case "utf8":
    case "utf8bom":
      return new TextDecoder("utf-8").decode(bytes);
    case "utf16le":
      return new TextDecoder("utf-16le").decode(bytes);
    case "utf16be": {
      const start = bytes[0] === 0xfe && bytes[1] === 0xff ? 2 : 0;
      return new TextDecoder("utf-16le").decode(swapBytes(bytes.subarray(start)));
    }
    case "iso88591":
    case "ascii": {
      let out = "";
      for (const byte of bytes) out += String.fromCharCode(key === "ascii" ? byte & 0x7f : byte);
      return out;
    }
    default:
      try {
        return new TextDecoder(decoderLabel(key)).decode(bytes);
      } catch {
        throw new Error(`Unsupported encoding: ${encoding}`);
      }
  }
}

let windows1252: Map<string, number> | undefined;
function windows1252Byte(char: string): number | undefined {
  const code = char.charCodeAt(0);
  if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) return code;
  if (!windows1252) {
    windows1252 = new Map();
    const decoder = new TextDecoder("windows-1252");
    for (let byte = 0x80; byte < 0xa0; byte++) windows1252.set(decoder.decode(new Uint8Array([byte])), byte);
  }
  return windows1252.get(char);
}

/** Text → bytes. UTF-16 and `utf8bom` get a BOM like VS Code writes them. Single-byte encodings replace what they cannot hold with `?`. */
export function encodeText(text: string, encoding?: string): Uint8Array {
  const key = normalizeEncoding(encoding) ?? "utf8";
  switch (key) {
    case "utf8":
      return new TextEncoder().encode(text);
    case "utf8bom": {
      const body = new TextEncoder().encode(text);
      const out = new Uint8Array(body.length + 3);
      out.set([0xef, 0xbb, 0xbf]);
      out.set(body, 3);
      return out;
    }
    case "utf16le":
    case "utf16be": {
      const out = new Uint8Array(2 + text.length * 2);
      const little = key === "utf16le";
      out.set(little ? [0xff, 0xfe] : [0xfe, 0xff]);
      for (let i = 0; i < text.length; i++) {
        const unit = text.charCodeAt(i);
        out[2 + i * 2] = little ? unit & 0xff : unit >> 8;
        out[3 + i * 2] = little ? unit >> 8 : unit & 0xff;
      }
      return out;
    }
    case "ascii":
    case "iso88591":
    case "windows1252": {
      const out = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i++) {
        const char = text[i]!;
        const code = char.charCodeAt(0);
        const byte = key === "windows1252" ? windows1252Byte(char) : code < (key === "ascii" ? 0x80 : 0x100) ? code : undefined;
        out[i] = byte ?? 0x3f;
      }
      return out;
    }
    default:
      throw new Error(`Unsupported encoding: ${encoding}`);
  }
}
