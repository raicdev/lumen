import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackupStore } from "../src/main/backups.ts";
import { WindowSessionStore } from "../src/main/window-sessions.ts";

/**
 * Several windows: each reopens with its own folder and its own unsaved editors.
 *
 *   node --test test/windows.test.ts
 */

const backup = (path: string, content: string) => ({ path, content, language: "plaintext", eol: "LF" as const, time: Date.now() });

test("each window gets back only its own backups, even for untitled editors with the same name", () => {
  const dir = mkdtempSync(join(tmpdir(), "lumen-backups-"));
  try {
    const store = new BackupStore(dir);
    store.write("window-a", backup("untitled:Untitled-1", "from a"));
    store.write("window-b", backup("untitled:Untitled-1", "from b"));
    assert.deepEqual(
      store.list("window-a").map((entry) => entry.content),
      ["from a"],
    );
    assert.deepEqual(
      store.list("window-b").map((entry) => entry.content),
      ["from b"],
    );
    store.delete("window-a", "untitled:Untitled-1");
    assert.equal(store.list("window-a").length, 0);
    assert.equal(store.list("window-b").length, 1, "deleting one window's backup leaves the other's");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backups from before windows had ids go to the window that restores the last session", () => {
  const dir = mkdtempSync(join(tmpdir(), "lumen-backups-"));
  try {
    mkdirSync(join(dir, "Backups"));
    writeFileSync(join(dir, "Backups", "old.json"), JSON.stringify(backup("C:\\project\\a.ts", "unsaved")));
    const store = new BackupStore(dir);
    assert.equal(store.list("new-window").length, 0);
    const [restored] = store.list("first-window", true);
    assert.equal(restored?.content, "unsaved");
    assert.equal("scope" in restored!, false, "the view gets the backup as it was written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the window session round-trips, and is missing until it was saved once", () => {
  const dir = mkdtempSync(join(tmpdir(), "lumen-windows-"));
  try {
    const store = new WindowSessionStore(dir);
    assert.equal(store.load(), null);
    const windows = [
      { id: "a", workspace: "C:\\one" },
      { id: "b", workspace: null },
    ];
    store.save(windows);
    assert.deepEqual(store.load(), windows);
    writeFileSync(join(dir, "windows.json"), JSON.stringify({ windows: [{ id: 1 }, { id: "c", workspace: "D:\\two" }] }));
    assert.deepEqual(store.load(), [{ id: "c", workspace: "D:\\two" }], "malformed entries are dropped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
