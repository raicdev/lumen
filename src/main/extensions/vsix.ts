import { inflateRawSync } from "zlib";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, resolve, sep } from "path";

/**
 * A small ZIP reader for .vsix packages (no dependency): central directory,
 * stored / deflated entries and the Zip64 extensions large packages use.
 */

export type ZipEntry = {
  name: string;
  isDirectory: boolean;
  size: number;
  read: () => Buffer;
};

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

function findEndOfCentralDirectory(buffer: Buffer): number {
  const min = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= min; i--) if (buffer.readUInt32LE(i) === EOCD) return i;
  throw new Error("not a zip file (no end of central directory)");
}

export function readZip(buffer: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buffer);
  let count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || buffer.readUInt32LE(locator) !== ZIP64_LOCATOR) throw new Error("broken zip64 archive");
    const record = Number(buffer.readBigUInt64LE(locator + 8));
    if (buffer.readUInt32LE(record) !== ZIP64_EOCD) throw new Error("broken zip64 archive");
    count = Number(buffer.readBigUInt64LE(record + 32));
    offset = Number(buffer.readBigUInt64LE(record + 48));
  }

  const entries: ZipEntry[] = [];
  let at = offset;
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(at) !== CENTRAL) throw new Error("corrupt zip central directory");
    const flags = buffer.readUInt16LE(at + 8);
    const method = buffer.readUInt16LE(at + 10);
    let compressed = buffer.readUInt32LE(at + 20);
    let size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    let local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString(flags & 0x800 ? "utf8" : "latin1", at + 46, at + 46 + nameLength);

    // Zip64: the real sizes / offset live in the extra field.
    let extra = at + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      const id = buffer.readUInt16LE(extra);
      const length = buffer.readUInt16LE(extra + 2);
      if (id === 0x0001) {
        let field = extra + 4;
        if (size === 0xffffffff) {
          size = Number(buffer.readBigUInt64LE(field));
          field += 8;
        }
        if (compressed === 0xffffffff) {
          compressed = Number(buffer.readBigUInt64LE(field));
          field += 8;
        }
        if (local === 0xffffffff) local = Number(buffer.readBigUInt64LE(field));
      }
      extra += 4 + length;
    }
    at = extraEnd + commentLength;

    const entrySize = size;
    const entryCompressed = compressed;
    const entryLocal = local;
    entries.push({
      name,
      isDirectory: name.endsWith("/"),
      size: entrySize,
      read: () => {
        if (flags & 0x1) throw new Error(`${name} is encrypted`);
        if (buffer.readUInt32LE(entryLocal) !== LOCAL) throw new Error(`corrupt local header for ${name}`);
        const start = entryLocal + 30 + buffer.readUInt16LE(entryLocal + 26) + buffer.readUInt16LE(entryLocal + 28);
        const data = buffer.subarray(start, start + entryCompressed);
        if (method === 0) return Buffer.from(data);
        if (method === 8) return inflateRawSync(data);
        throw new Error(`${name}: unsupported compression method ${method}`);
      },
    });
  }
  return entries;
}

/**
 * Extract the entries below `prefix` (e.g. "extension/") into `target`.
 * Entry names that would escape the target folder are rejected.
 */
export function extractZip(buffer: Buffer, target: string, prefix = ""): number {
  const root = resolve(target);
  let written = 0;
  for (const entry of readZip(buffer)) {
    const name = entry.name.replace(/\\/g, "/");
    if (!name.startsWith(prefix) || entry.isDirectory) continue;
    const relativeName = name.slice(prefix.length);
    if (!relativeName) continue;
    const destination = resolve(root, relativeName);
    if (destination !== root && !destination.startsWith(root + sep)) throw new Error(`unsafe path in package: ${entry.name}`);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, entry.read());
    written++;
  }
  return written;
}

/** Read one file of an archive (e.g. "extension/package.json"). */
export function readZipFile(buffer: Buffer, name: string): Buffer | null {
  const entry = readZip(buffer).find((candidate) => candidate.name === name);
  return entry ? entry.read() : null;
}
