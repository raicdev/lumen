import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { LanguageServiceHub } from "../src/main/lsp.ts";
import { watchWorkspace, type WorkspaceChange } from "../src/main/watcher.ts";

/**
 * A file that is not open changes on disk (git checkout, a formatter): the
 * TypeScript service must compute renames on its new text, or the edits land
 * on the wrong lines of the file.
 *
 *   node --test test/lsp-disk-changes.test.ts
 */

test("a rename after a closed file changed on disk edits the file as it is now", () => {
  const dir = mkdtempSync(join(tmpdir(), "lumen-rename-"));
  try {
    const a = join(dir, "a.ts");
    const b = join(dir, "b.ts");
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ include: ["*.ts"] }));
    writeFileSync(a, "export const foo = 1;\n");
    writeFileSync(b, 'import { foo } from "./a";\nconsole.log(foo);\n');

    const hub = new LanguageServiceHub();
    hub.setWorkspaceRoot(dir);
    hub.open(a, readFileSync(a, "utf8"), "typescript");
    const linesInB = () =>
      hub
        .getRenameEdits(a, 0, 13, "bar")
        .edits.find((file) => file.path.toLowerCase().endsWith("b.ts"))!
        .edits.map((edit) => edit.startLine)
        .sort();

    assert.deepEqual(linesInB(), [0, 1]);
    // Two lines are added at the top of the closed b.ts; the workspace watcher reports it.
    writeFileSync(b, '// one\n// two\nimport { foo } from "./a";\nconsole.log(foo);\n');
    hub.filesChanged([b]);
    assert.deepEqual(linesInB(), [2, 3]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an open document is not read from disk when the file changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "lumen-rename-"));
  try {
    const a = join(dir, "a.ts");
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ include: ["*.ts"] }));
    writeFileSync(a, "export const foo = 1;\nfoo;\n");
    const hub = new LanguageServiceHub();
    hub.setWorkspaceRoot(dir);
    // The editor's (unsaved) text differs from the disk: it wins.
    hub.open(a, "\n\nexport const foo = 1;\nfoo;\n", "typescript");
    writeFileSync(a, "export const foo = 2;\n");
    hub.filesChanged([a]);
    const lines = hub
      .getRenameEdits(a, 2, 13, "bar")
      .edits[0]!.edits.map((edit) => edit.startLine)
      .sort();
    assert.deepEqual(lines, [2, 3]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A workspace with a tsconfig and `a.ts` open with `source`. */
function project(source: string): { dir: string; a: string; hub: LanguageServiceHub } {
  const dir = mkdtempSync(join(tmpdir(), "lumen-types-"));
  const a = join(dir, "a.ts");
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "commonjs", strict: true }, include: ["*.ts"] }));
  writeFileSync(a, source);
  const hub = new LanguageServiceHub();
  hub.setWorkspaceRoot(dir);
  hub.open(a, source, "typescript");
  return { dir, a, hub };
}

const messages = async (hub: LanguageServiceHub, path: string) => (await hub.getDiagnostics(path)).map((diagnostic) => diagnostic.message).join("\n");

test("a package installed after the workspace opened resolves (npm install)", async () => {
  const { dir, a, hub } = project('import { greet } from "greeter";\ngreet("x");\n');
  try {
    assert.match(await messages(hub, a), /Cannot find module 'greeter'/);
    const pkg = join(dir, "node_modules", "greeter");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "greeter", types: "index.d.ts" }));
    writeFileSync(join(pkg, "index.d.ts"), "export declare function greet(name: string): void;\n");
    hub.filesChanged([join(pkg, "index.d.ts"), join(pkg, "package.json")]);
    assert.equal(await messages(hub, a), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("build output that changed (tsc --watch in another package) is read again", async () => {
  const { dir, a, hub } = project('import { size } from "./dist/lib";\nexport const text: string = size;\n');
  try {
    mkdirSync(join(dir, "dist"));
    const lib = join(dir, "dist", "lib.d.ts");
    writeFileSync(lib, "export declare const size: string;\n");
    hub.projectChanged();
    assert.equal(await messages(hub, a), "");
    writeFileSync(lib, "export declare const size: number;\n");
    hub.filesChanged([lib]);
    assert.match(await messages(hub, a), /'number' is not assignable to type 'string'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the watcher reports type files in node_modules and build output, not tool caches", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lumen-watch-"));
  try {
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(dir, "node_modules", ".cache"), { recursive: true });
    mkdirSync(join(dir, "dist"), { recursive: true });
    const changes: WorkspaceChange[] = [];
    watchWorkspace(dir, (change) => changes.push(change));
    await new Promise((resolve) => setTimeout(resolve, 100));
    writeFileSync(join(dir, "node_modules", "pkg", "index.d.ts"), "export {};\n");
    writeFileSync(join(dir, "node_modules", "pkg", "index.js"), "");
    writeFileSync(join(dir, "node_modules", ".cache", "state.ts"), "");
    writeFileSync(join(dir, "dist", "lib.d.ts"), "export {};\n");
    writeFileSync(join(dir, "main.ts"), "");
    for (let i = 0; i < 40 && !changes.length; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    watchWorkspace(null, () => undefined);
    const relativeTo = (path: string) => relative(dir, path).split(sep).join("/");
    const typePaths = changes.flatMap((change) => change.typePaths).map(relativeTo);
    const paths = changes.flatMap((change) => change.paths).map(relativeTo);
    assert.deepEqual([...new Set(typePaths)].sort(), ["dist/lib.d.ts", "node_modules/pkg/index.d.ts"]);
    assert.ok(paths.includes("main.ts"));
    assert.ok(!paths.some((path) => path.startsWith("node_modules") || path.startsWith("dist")), "ignored folders stay out of the view's changes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
