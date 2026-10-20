import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "fs";
import { basename, join, resolve } from "path";
import { formatReport, transpileExtension, transpileVsix } from "./transpiler.ts";

/**
 * Command line front end of the VS Code → Lumen transpiler:
 *
 *   pnpm ext:transpile <extension.vsix | folder> [--out <folder>]
 *
 * Writes a Lumen extension (package.json with a lumen engine, rewritten
 * imports, lumen-compat.json) and prints the compatibility report.
 */

function usage(): never {
  console.log("usage: pnpm ext:transpile <extension.vsix | extension folder> [--out <folder>] [--force]");
  process.exit(1);
}

const args = process.argv.slice(2);
const input = args.find((arg) => !arg.startsWith("--") && args[args.indexOf(arg) - 1] !== "--out");
if (!input) usage();
const outIndex = args.indexOf("--out");
const force = args.includes("--force");
const source = resolve(input);
if (!existsSync(source)) {
  console.error(`not found: ${source}`);
  process.exit(1);
}

const isVsix = statSync(source).isFile();
const out = resolve(outIndex >= 0 && args[outIndex + 1] ? args[outIndex + 1]! : join(process.cwd(), `${basename(source).replace(/\.vsix$/i, "")}-lumen`));
if (existsSync(out)) {
  if (!force) {
    console.error(`${out} already exists (use --force to replace it)`);
    process.exit(1);
  }
  rmSync(out, { recursive: true, force: true });
}
mkdirSync(out, { recursive: true });

try {
  const { manifest, report } = isVsix ? transpileVsix(readFileSync(source), out) : transpileExtension(source, out);
  console.log(formatReport(manifest, report, out));
} catch (error) {
  console.error(`transpile failed: ${error instanceof Error ? error.message : error}`);
  rmSync(out, { recursive: true, force: true });
  process.exit(1);
}
