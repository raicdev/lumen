import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectEncoding, readTextFile, replaceInFiles, searchInFiles, writeTextFile } from "../src/main/fs.ts";
import { encodeText } from "../src/main/exthost/features/workspace-misc/encoding.ts";

/**
 * Opening and saving files keeps their bytes: any non-binary extension opens,
 * the encoding is detected and written back, and a save does not overwrite
 * changes another program made.
 *
 *   node --test test/text-files.test.ts
 */

function folder(): string {
  return mkdtempSync(join(tmpdir(), "lumen-text-"));
}

test("source files of every language open; binary files do not", async () => {
  const dir = folder();
  try {
    for (const name of ["Program.cs", "main.c", "util.h", "App.java", "build.bat", "x.unknownext"]) {
      writeFileSync(join(dir, name), "int x = 1;\n");
      const result = await readTextFile(join(dir, name));
      assert.ok(!("error" in result), `${name} should open`);
    }
    writeFileSync(join(dir, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    assert.ok("error" in (await readTextFile(join(dir, "image.png"))));
    writeFileSync(join(dir, "blob.dat"), Buffer.from([0x41, 0x00, 0x42]));
    assert.ok("error" in (await readTextFile(join(dir, "blob.dat"))), "NUL bytes mean binary");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detectEncoding: BOM, UTF-8, Japanese legacy encodings, Windows-1252", () => {
  assert.equal(detectEncoding(Buffer.from([0xef, 0xbb, 0xbf, 0x61])), "utf8bom");
  assert.equal(detectEncoding(Buffer.from([0xff, 0xfe, 0x61, 0x00])), "utf16le");
  assert.equal(detectEncoding(Buffer.from("日本語 text", "utf8")), "utf8");
  assert.equal(detectEncoding(encodeText("これは日本語のテキストです", "shiftjis")), "shiftjis");
  assert.equal(detectEncoding(encodeText("これは日本語のテキストです", "eucjp")), "eucjp");
  // é followed by ASCII is valid Shift JIS byte-wise, but has no kana.
  assert.equal(detectEncoding(encodeText("café latte, naïve", "windows1252")), "windows1252");
});

test("a Shift JIS file is saved back in Shift JIS, a UTF-8 BOM is kept", async () => {
  const dir = folder();
  try {
    const sjis = join(dir, "memo.txt");
    writeFileSync(sjis, encodeText("こんにちは\r\n", "shiftjis"));
    const read = await readTextFile(sjis);
    assert.ok(!("error" in read));
    assert.equal(read.encoding, "shiftjis");
    assert.equal(read.content, "こんにちは\r\n");
    assert.ok((await writeTextFile(sjis, "こんばんは\r\n", { encoding: read.encoding })).success);
    assert.deepEqual(readFileSync(sjis), Buffer.from(encodeText("こんばんは\r\n", "shiftjis")));

    const bom = join(dir, "bom.json");
    writeFileSync(bom, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("{}")]));
    const bomRead = await readTextFile(bom);
    assert.ok(!("error" in bomRead));
    assert.equal(bomRead.content, "{}", "the BOM is not part of the text");
    await writeTextFile(bom, "{ }", { encoding: bomRead.encoding });
    assert.deepEqual([...readFileSync(bom).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a save refuses characters the encoding cannot hold", async () => {
  const dir = folder();
  try {
    const file = join(dir, "latin.txt");
    writeFileSync(file, "abc");
    const result = await writeTextFile(file, "日本", { encoding: "windows1252" });
    assert.equal(result.success, false);
    assert.equal(readFileSync(file, "utf8"), "abc", "the file is left alone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a save with the version read is refused when another program changed the file", async () => {
  const dir = folder();
  try {
    const file = join(dir, "a.ts");
    writeFileSync(file, "one");
    const read = await readTextFile(file);
    assert.ok(!("error" in read));
    // Another program writes the file (a different mtime).
    writeFileSync(file, "two!");
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    const refused = await writeTextFile(file, "mine", { expectedVersion: read.version });
    assert.equal(refused.conflict, true);
    assert.equal(readFileSync(file, "utf8"), "two!");
    const saved = await writeTextFile(file, "mine");
    assert.ok(saved.success && saved.version);
    // The version a save returns lets the next save through.
    assert.ok((await writeTextFile(file, "mine again", { expectedVersion: saved.version })).success);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("search and replace read and write each file in its own encoding", async () => {
  const dir = folder();
  try {
    writeFileSync(join(dir, "jp.txt"), encodeText("ねこ と いぬ\n", "shiftjis"));
    writeFileSync(join(dir, "main.cpp"), "int neko = 1;\n");
    const found = searchInFiles(dir, "ねこ");
    assert.equal(found.matches.length, 1);
    assert.equal((await replaceInFiles(dir, "ねこ", "とり")).replacements, 1);
    assert.deepEqual(readFileSync(join(dir, "jp.txt")), Buffer.from(encodeText("とり と いぬ\n", "shiftjis")));
    assert.equal(searchInFiles(dir, "neko").matches.length, 1, ".cpp files are searched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
