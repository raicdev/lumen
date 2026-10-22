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
  const table: Record<string, string> = {
    shiftjis: "shift_jis",
    eucjp: "euc-jp",
    iso2022jp: "iso-2022-jp",
    euckr: "euc-kr",
    gbk: "gbk",
    gb18030: "gb18030",
    gb2312: "gbk",
    big5: "big5",
    // The WHATWG Big5 decoder is Big5-HKSCS; cp950 is Big5 with a few extensions.
    big5hkscs: "big5",
    cp950: "big5",
    koi8r: "koi8-r",
    koi8u: "koi8-u",
    // The WHATWG KOI8-U table is KOI8-RU.
    koi8ru: "koi8-u",
    macintosh: "macintosh",
    macroman: "macintosh",
    cp866: "ibm866",
    windows874: "windows-874",
    iso885911: "windows-874",
  };
  if (table[key]) return table[key]!;
  const windows = /^windows(\d{4})$/.exec(key);
  if (windows) return `windows-${windows[1]}`;
  const iso = /^iso8859(\d{1,2})$/.exec(key);
  if (iso) return `iso-8859-${iso[1]}`;
  return key;
}

/**
 * Bytes 0x80–0xFF of the DOS code pages VS Code offers that TextDecoder does not know
 * (taken from Windows' own code page tables); 0x00–0x7F are ASCII.
 */
const DOS_PAGES: Record<string, string> = {
  cp437: "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ",
  cp850: "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ ",
  cp852: "ÇüéâäůćçłëŐőîŹÄĆÉĹĺôöĽľŚśÖÜŤťŁ×čáíóúĄąŽžĘę¬źČş«»░▒▓│┤ÁÂĚŞ╣║╗╝Żż┐└┴┬├─┼Ăă╚╔╩╦╠═╬¤đĐĎËďŇÍÎě┘┌█▄ŢŮ▀ÓßÔŃńňŠšŔÚŕŰýÝţ´­˝˛ˇ˘§÷¸°¨˙űŘř■ ",
  cp865: "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø₧ƒáíóúñÑªº¿⌐¬½¼¡«¤░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ",
};

/** Encodings with more than one byte per character (TextDecoder labels). */
const MULTI_BYTE = new Set(["shift_jis", "euc-jp", "iso-2022-jp", "euc-kr", "gbk", "gb18030", "big5"]);

const singleByteTables = new Map<string, string[]>();

/** The 256 characters of a single-byte encoding (`""` for a byte it does not map). Throws for an unknown encoding. */
function singleByteTable(key: string): string[] {
  let table = singleByteTables.get(key);
  if (table) return table;
  const dos = DOS_PAGES[key];
  if (dos) table = [...Array.from({ length: 128 }, (_, byte) => String.fromCharCode(byte)), ...dos];
  else {
    const decoder = new TextDecoder(decoderLabel(key));
    table = Array.from({ length: 256 }, (_, byte) => {
      const char = decoder.decode(new Uint8Array([byte]));
      return char === "�" ? "" : char;
    });
  }
  singleByteTables.set(key, table);
  return table;
}

const reverseTables = new Map<string, Map<number, number[]>>();

/**
 * Code point → bytes of a multi-byte encoding, built once by decoding every byte sequence
 * the encoding has (like the WHATWG encoders, the first sequence for a character wins).
 */
function multiByteTable(label: string): Map<number, number[]> {
  const cached = reverseTables.get(label);
  if (cached) return cached;
  const map = new Map<number, number[]>();
  const decoder = new TextDecoder(label === "iso-2022-jp" ? "euc-jp" : label);
  const add = (bytes: number[]) => {
    const char = decoder.decode(new Uint8Array(bytes));
    const code = char.codePointAt(0);
    if (code === undefined || code === 0xfffd || char.length !== (code > 0xffff ? 2 : 1) || map.has(code)) return;
    map.set(code, bytes);
  };
  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const pairs = (leads: number[], trails: number[]) => {
    for (const lead of leads) for (const trail of trails) add([lead, trail]);
  };
  for (let byte = 0; byte < 0x80; byte++) add([byte]);
  switch (label) {
    case "shift_jis":
      for (const byte of range(0xa1, 0xdf)) add([byte]);
      // NEC-selected IBM extensions (0xED, 0xEE) only where the IBM rows (0xFA–0xFC) have no code.
      pairs([...range(0x81, 0x9f), ...range(0xe0, 0xec), ...range(0xef, 0xfc), 0xed, 0xee], [...range(0x40, 0x7e), ...range(0x80, 0xfc)]);
      break;
    case "euc-jp":
    case "iso-2022-jp":
      pairs([0x8e], range(0xa1, 0xdf));
      pairs(range(0xa1, 0xfe), range(0xa1, 0xfe));
      break;
    case "euc-kr":
      pairs(range(0x81, 0xfe), range(0x41, 0xfe));
      break;
    case "big5":
      // Plain Big5 rows first, then the HKSCS ones.
      pairs([...range(0xa1, 0xfe), ...range(0x81, 0xa0)], [...range(0x40, 0x7e), ...range(0xa1, 0xfe)]);
      break;
    case "gbk":
    case "gb18030":
      add([0x80]);
      pairs(range(0x81, 0xfe), [...range(0x40, 0x7e), ...range(0x80, 0xfe)]);
      if (label === "gb18030") {
        // Four-byte sequences of the rest of the BMP (supplementary planes are computed in gb18030Bytes).
        for (const b1 of range(0x81, 0x84))
          for (const b2 of range(0x30, 0x39)) for (const b3 of range(0x81, 0xfe)) for (const b4 of range(0x30, 0x39)) add([b1, b2, b3, b4]);
      }
      break;
  }
  reverseTables.set(label, map);
  return map;
}

/** GB18030 four-byte sequence of a supplementary-plane code point. */
function gb18030Bytes(code: number): number[] {
  let pointer = code - 0x10000 + 189000;
  const b4 = pointer % 10;
  pointer = Math.floor(pointer / 10);
  const b3 = pointer % 126;
  pointer = Math.floor(pointer / 126);
  const b2 = pointer % 10;
  const b1 = Math.floor(pointer / 10);
  return [b1 + 0x81, b2 + 0x30, b3 + 0x81, b4 + 0x30];
}

/** Text → bytes of a multi-byte encoding; characters it cannot hold become `?`. */
function encodeMultiByte(text: string, label: string): Uint8Array {
  const map = multiByteTable(label);
  const out: number[] = [];
  // ISO-2022-JP switches between ASCII (ESC ( B), JIS X 0208 (ESC $ B) and half-width katakana (ESC ( I).
  let mode: "ascii" | "jis" | "kana" = "ascii";
  const switchTo = (next: typeof mode) => {
    if (mode === next) return;
    mode = next;
    out.push(0x1b, ...(next === "ascii" ? [0x28, 0x42] : next === "jis" ? [0x24, 0x42] : [0x28, 0x49]));
  };
  for (const char of text) {
    const code = char.codePointAt(0)!;
    let bytes = map.get(code);
    if (!bytes && label === "gb18030" && code > 0xffff) bytes = gb18030Bytes(code);
    if (label !== "iso-2022-jp") {
      out.push(...(bytes ?? [0x3f]));
      continue;
    }
    if (!bytes || bytes.length === 1) {
      switchTo("ascii");
      out.push(bytes?.[0] ?? 0x3f);
    } else if (bytes[0] === 0x8e) {
      switchTo("kana");
      out.push(bytes[1]! & 0x7f);
    } else {
      switchTo("jis");
      out.push(bytes[0]! & 0x7f, bytes[1]! & 0x7f);
    }
  }
  if (label === "iso-2022-jp") switchTo("ascii");
  return new Uint8Array(out);
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
    default: {
      if (DOS_PAGES[key]) {
        const table = singleByteTable(key);
        let out = "";
        for (const byte of bytes) out += table[byte];
        return out;
      }
      try {
        return new TextDecoder(decoderLabel(key)).decode(bytes);
      } catch {
        throw new Error(`Unsupported encoding: ${encoding}`);
      }
    }
  }
}

const singleByteReverse = new Map<string, Map<string, number>>();

/** Character → byte of a single-byte encoding (the lowest byte for a character mapped twice). */
function singleByteLookup(key: string): Map<string, number> {
  let map = singleByteReverse.get(key);
  if (!map) {
    map = new Map();
    const table = singleByteTable(key);
    for (let byte = 0; byte < 256; byte++) if (table[byte] && !map.has(table[byte]!)) map.set(table[byte]!, byte);
    singleByteReverse.set(key, map);
  }
  return map;
}

/** Text → bytes. UTF-16 and `utf8bom` get a BOM like VS Code writes them. Other encodings replace what they cannot hold with `?`. */
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
    case "iso88591": {
      const out = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        out[i] = code < (key === "ascii" ? 0x80 : 0x100) ? code : 0x3f;
      }
      return out;
    }
    default: {
      const label = decoderLabel(key);
      if (MULTI_BYTE.has(label)) return encodeMultiByte(text, label);
      let lookup: Map<string, number>;
      try {
        lookup = singleByteLookup(key);
      } catch {
        throw new Error(`Unsupported encoding: ${encoding}`);
      }
      const out: number[] = [];
      for (const char of text) out.push(lookup.get(char) ?? 0x3f);
      return new Uint8Array(out);
    }
  }
}
