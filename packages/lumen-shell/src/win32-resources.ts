/**
 * Windows executable branding for `lumen-shell package`: the packaged app is a
 * copy of node.exe, so its icon, version info and subsystem are rewritten
 * (UpdateResourceW through koffi — no extra tooling).
 */
import { open, readFile } from "fs/promises";

const RT_ICON = 3;
const RT_GROUP_ICON = 14;
const RT_VERSION = 16;
/** node.exe ships every resource as en-US; replacing needs the same language. */
const LANG_EN_US = 0x0409;
const CODEPAGE_UNICODE = 1200;

export type VersionInfo = {
  version: string;
  productName: string;
  fileDescription: string;
  companyName?: string;
  copyright?: string;
  originalFilename: string;
};

type ResourceApi = {
  begin: (file: string, deleteExisting: number) => unknown;
  update: (handle: unknown, type: number, name: number, lang: number, data: Buffer, size: number) => number;
  end: (handle: unknown, discard: number) => number;
};

async function resourceApi(): Promise<ResourceApi> {
  const { default: koffi } = await import("koffi");
  const kernel32 = koffi.load("kernel32.dll");
  return {
    begin: kernel32.func("void *__stdcall BeginUpdateResourceW(const char16_t *file, int deleteExisting)"),
    update: kernel32.func("int __stdcall UpdateResourceW(void *handle, uintptr_t type, uintptr_t name, uint16_t lang, void *data, uint32_t size)"),
    end: kernel32.func("int __stdcall EndUpdateResourceW(void *handle, int discard)"),
  };
}

/** Replace the executable's main icon (group 1) and its version resource. */
export async function brandExecutable(exePath: string, options: { icon?: string; version: VersionInfo }): Promise<void> {
  const api = await resourceApi();
  const handle = api.begin(exePath, 0);
  if (!handle) throw new Error(`cannot open ${exePath} for resource updates`);
  const put = (type: number, name: number, data: Buffer) => {
    if (!api.update(handle, type, name, LANG_EN_US, data, data.length)) {
      api.end(handle, 1);
      throw new Error(`UpdateResourceW failed for resource ${type}/${name}`);
    }
  };

  if (options.icon) {
    // Images take ids 1..n. node.exe's own images past n stay behind, unused by
    // the group (deleting a missing id would fail the whole update).
    const { images, group } = parseIco(await readFile(options.icon));
    images.forEach((image, index) => put(RT_ICON, index + 1, image));
    put(RT_GROUP_ICON, 1, group);
  }
  put(RT_VERSION, 1, versionResource(options.version));

  if (!api.end(handle, 0)) throw new Error(`EndUpdateResourceW failed for ${exePath}`);
}

/** Split an .ico file into RT_ICON images plus the RT_GROUP_ICON directory that indexes them by id. */
function parseIco(ico: Buffer): { images: Buffer[]; group: Buffer } {
  if (ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) throw new Error("not an .ico file");
  const count = ico.readUInt16LE(4);
  const group = Buffer.alloc(6 + 14 * count);
  group.writeUInt16LE(1, 2);
  group.writeUInt16LE(count, 4);
  const images: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    const entry = 6 + 16 * i;
    const size = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    images.push(ico.subarray(offset, offset + size));
    // GRPICONDIRENTRY: the ICONDIRENTRY's first 12 bytes, then the resource id.
    ico.copy(group, 6 + 14 * i, entry, entry + 12);
    group.writeUInt16LE(i + 1, 6 + 14 * i + 12);
  }
  return { images, group };
}

/** "1.2.3-beta.1" → [1, 2, 3, 0] */
export function versionParts(version: string): [number, number, number, number] {
  const parts = version
    .split(/[-+]/)[0]
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 0];
}

function utf16z(text: string): Buffer {
  return Buffer.from(`${text}\0`, "utf16le");
}

function align4(buffer: Buffer): Buffer {
  const pad = (4 - (buffer.length % 4)) % 4;
  return pad ? Buffer.concat([buffer, Buffer.alloc(pad)]) : buffer;
}

/** One VS_VERSIONINFO node: header, key, value, then 32-bit aligned children. */
function versionNode(key: string, type: 0 | 1, value: Buffer | null, valueLength: number, children: Buffer[] = []): Buffer {
  let node = align4(Buffer.concat([Buffer.alloc(6), utf16z(key)]));
  if (value) node = Buffer.concat([node, value]);
  for (const child of children) node = Buffer.concat([align4(node), child]);
  node.writeUInt16LE(node.length, 0);
  node.writeUInt16LE(valueLength, 2);
  node.writeUInt16LE(type, 4);
  return node;
}

function versionResource(info: VersionInfo): Buffer {
  const [major, minor, patch, build] = versionParts(info.version);
  const fixed = Buffer.alloc(52);
  fixed.writeUInt32LE(0xfeef04bd, 0); // signature
  fixed.writeUInt32LE(0x00010000, 4); // structure version
  for (const offset of [8, 16]) {
    // file version, product version
    fixed.writeUInt32LE(((major << 16) | minor) >>> 0, offset);
    fixed.writeUInt32LE(((patch << 16) | build) >>> 0, offset + 4);
  }
  fixed.writeUInt32LE(0x3f, 24); // flags mask
  fixed.writeUInt32LE(0x00040004, 32); // VOS_NT_WINDOWS32
  fixed.writeUInt32LE(1, 36); // VFT_APP

  const strings: Record<string, string | undefined> = {
    CompanyName: info.companyName,
    FileDescription: info.fileDescription,
    FileVersion: info.version,
    InternalName: info.productName,
    LegalCopyright: info.copyright,
    OriginalFilename: info.originalFilename,
    ProductName: info.productName,
    ProductVersion: info.version,
  };
  const entries = Object.entries(strings)
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([key, value]) => versionNode(key, 1, utf16z(value), value.length + 1));
  const tableKey = LANG_EN_US.toString(16).padStart(4, "0") + CODEPAGE_UNICODE.toString(16).padStart(4, "0");
  const stringFileInfo = versionNode("StringFileInfo", 1, null, 0, [versionNode(tableKey, 1, null, 0, entries)]);

  const translation = Buffer.alloc(4);
  translation.writeUInt16LE(LANG_EN_US, 0);
  translation.writeUInt16LE(CODEPAGE_UNICODE, 2);
  const varFileInfo = versionNode("VarFileInfo", 1, null, 0, [versionNode("Translation", 0, translation, 4)]);

  return versionNode("VS_VERSION_INFO", 0, align4(fixed), 52, [stringFileInfo, varFileInfo]);
}

/**
 * Mark the executable as a GUI application, so launching it opens no console
 * window. Output written to stdout/stderr is then discarded by Node.
 */
export async function useWindowsSubsystem(exePath: string): Promise<void> {
  const IMAGE_SUBSYSTEM_WINDOWS_GUI = 2;
  const file = await open(exePath, "r+");
  try {
    const header = Buffer.alloc(1024);
    await file.read(header, 0, header.length, 0);
    const pe = header.readUInt32LE(0x3c);
    if (header.toString("latin1", pe, pe + 4) !== "PE\0\0") throw new Error(`${exePath} is not a PE file`);
    // PE signature (4) + COFF header (20), then the optional header's Subsystem at +68.
    const subsystem = Buffer.alloc(2);
    subsystem.writeUInt16LE(IMAGE_SUBSYSTEM_WINDOWS_GUI);
    await file.write(subsystem, 0, 2, pe + 4 + 20 + 68);
  } finally {
    await file.close();
  }
}
