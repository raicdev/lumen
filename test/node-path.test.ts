import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureNodeOnPath } from "../src/main/node-path.ts";

/**
 * A Lumen started from the Start menu gets the registry PATH, without the
 * node a version manager adds in shell profiles.
 *
 *   node --test test/node-path.test.ts
 */

function withNode(dir: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "node.exe"), "");
  return dir;
}

test("an installed Node.js is added to the end of PATH when none is on it", () => {
  const root = mkdtempSync(join(tmpdir(), "lumen-node-path-"));
  try {
    const fnmDefault = withNode(join(root, "AppData", "Roaming", "fnm", "aliases", "default"));
    const system = join(root, "System32");
    const env: Record<string, string | undefined> = { Path: `${system};`, APPDATA: join(root, "AppData", "Roaming") };
    assert.equal(ensureNodeOnPath(env, "win32"), fnmDefault);
    // The key keeps its spelling (Windows calls it "Path").
    assert.deepEqual(Object.keys(env).sort(), ["APPDATA", "Path"]);
    assert.equal(env.Path, `${system};${fnmDefault}`);
    // Once there, nothing more is added.
    assert.equal(ensureNodeOnPath(env, "win32"), null);
    assert.equal(env.Path, `${system};${fnmDefault}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PATH is left alone when node is already on it, none is installed, or not on Windows", () => {
  const root = mkdtempSync(join(tmpdir(), "lumen-node-path-"));
  try {
    withNode(join(root, "own"));
    withNode(join(root, "Program Files", "nodejs"));
    const env: Record<string, string | undefined> = { PATH: `%HOME%\\own`, HOME: root, ProgramFiles: join(root, "Program Files") };
    assert.equal(ensureNodeOnPath(env, "win32"), null, "found through an unexpanded %VAR% entry");
    assert.equal(env.PATH, `%HOME%\\own`);

    const none: Record<string, string | undefined> = { PATH: join(root, "empty") };
    assert.equal(ensureNodeOnPath(none, "win32"), null);
    assert.equal(none.PATH, join(root, "empty"));

    const posix: Record<string, string | undefined> = { PATH: "/usr/bin", ProgramFiles: join(root, "Program Files") };
    assert.equal(ensureNodeOnPath(posix, "linux"), null);
    assert.equal(posix.PATH, "/usr/bin");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
