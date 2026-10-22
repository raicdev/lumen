/** The file encodings the status bar offers (VS Code's ids and labels), most common first. */
export const FILE_ENCODINGS: { id: string; label: string }[] = [
  { id: "utf8", label: "UTF-8" },
  { id: "utf8bom", label: "UTF-8 with BOM" },
  { id: "utf16le", label: "UTF-16 LE" },
  { id: "utf16be", label: "UTF-16 BE" },
  { id: "shiftjis", label: "Japanese (Shift JIS)" },
  { id: "eucjp", label: "Japanese (EUC-JP)" },
  { id: "windows1252", label: "Western (Windows 1252)" },
  { id: "iso88591", label: "Western (ISO 8859-1)" },
  { id: "gbk", label: "Simplified Chinese (GBK)" },
  { id: "gb18030", label: "Simplified Chinese (GB18030)" },
  { id: "big5", label: "Traditional Chinese (Big5)" },
  { id: "euckr", label: "Korean (EUC-KR)" },
  { id: "windows1251", label: "Cyrillic (Windows 1251)" },
  { id: "windows1250", label: "Central European (Windows 1250)" },
];

/** `shiftjis` → `Japanese (Shift JIS)`; unknown ids as they are. */
export function encodingLabel(id: string): string {
  return FILE_ENCODINGS.find((encoding) => encoding.id === id)?.label ?? id;
}

/** The short name the status bar shows (`UTF-8`, `Shift JIS`). */
export function encodingShortName(id: string): string {
  const label = encodingLabel(id);
  return /\(([^)]+)\)$/.exec(label)?.[1] ?? label;
}
