#!/usr/bin/env node
/**
 * Lumen Shell CLI.
 *
 *   lumen-shell dev [--watch]   build the view, serve it, launch the main process
 *   lumen-shell build           production bundle (view + main) into .lumen/build
 *   lumen-shell package         standalone app directory in dist/<App>/
 *   lumen-shell installer       Windows setup executable (NSIS) in dist/
 */
import { spawnSync } from "child_process";
import * as esbuild from "esbuild";
import { existsSync, readFileSync, realpathSync, watch, type FSWatcher } from "fs";
import { copyFile, cp, mkdir, readdir, readFile, rm, stat, writeFile } from "fs/promises";
import { createRequire } from "module";
import { basename, dirname, join } from "path";
import { pathToFileURL } from "url";
import { nativeLibraryName, resolveNativeLibrary } from "./main/native/library.ts";
import { brandExecutable, useWindowsSubsystem, versionParts } from "./win32-resources.ts";

export type LumenConfig = {
  app?: { name?: string; version?: string; identifier?: string };
  /** Main-process entry (Node.js). */
  main: string;
  view: {
    /** Renderer entry (bundled for the browser). */
    entry: string;
    /** HTML shell that is copied next to the bundle. */
    html: string;
    /** Extra stylesheets copied as-is. */
    styles?: string[];
    /** Extra files/directories copied into the assets directory. */
    assets?: string[];
  };
  package?: {
    /** Extra files copied next to the packaged executable. */
    extra?: string[];
    /** Windows .ico for the executable, its windows and the installer. */
    icon?: string;
    /** Shown in the executable's details and in Windows' installed apps list. */
    publisher?: string;
  };
};

const ROOT = process.cwd();

function log(message: string): void {
  console.log(`\x1b[36m[lumen]\x1b[0m ${message}`);
}

function fail(message: string): never {
  console.error(`\x1b[31m[lumen] ${message}\x1b[0m`);
  process.exit(1);
}

async function loadConfig(): Promise<LumenConfig> {
  for (const candidate of ["lumen.config.ts", "lumen.config.js", "lumen.config.mjs", "lumen.config.json"]) {
    const path = join(ROOT, candidate);
    if (!existsSync(path)) continue;
    if (candidate.endsWith(".json")) {
      return JSON.parse(await readFile(path, "utf8")) as LumenConfig;
    }
    const module = (await import(pathToFileURL(path).href)) as { default?: LumenConfig } & LumenConfig;
    return module.default ?? module;
  }
  return fail("no lumen.config.ts found in " + ROOT);
}

async function buildView(config: LumenConfig, outDir: string, minify: boolean): Promise<void> {
  await mkdir(outDir, { recursive: true });

  try {
    await esbuild.build({
      entryPoints: [join(ROOT, config.view.entry)],
      outdir: outDir,
      entryNames: "[name]",
      bundle: true,
      platform: "browser",
      format: "esm",
      // Oniguruma ships its engine as WebAssembly; bundle it into the page as bytes.
      loader: { ".wasm": "binary" },
      minify,
      sourcemap: minify ? false : "inline",
      define: {
        "process.env.NODE_ENV": JSON.stringify(minify ? "production" : "development"),
      },
      logLevel: "error",
    });
  } catch {
    fail("view build failed");
  }

  await copyFile(join(ROOT, config.view.html), join(outDir, basename(config.view.html)));
  for (const style of config.view.styles ?? []) {
    await copyFile(join(ROOT, style), join(outDir, basename(style)));
  }
  for (const asset of config.view.assets ?? []) {
    const from = join(ROOT, asset);
    const to = join(outDir, basename(asset));
    await cp(from, to, { recursive: true });
  }
}

/** Native-backed modules stay external so they resolve from node_modules at runtime. */
const NATIVE_EXTERNALS = ["koffi", "node-pty"];

async function buildMain(config: LumenConfig, outDir: string): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const outfile = join(outDir, "main.mjs");
  try {
    await esbuild.build({
      entryPoints: [join(ROOT, config.main)],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      minify: false,
      // Prefer ESM builds: UMD "main" entries (vscode-json-languageservice…) hide
      // their relative requires from esbuild and break once bundled.
      mainFields: ["module", "main"],
      external: NATIVE_EXTERNALS,
      // Bundled CommonJS dependencies (typescript…) still use require() and __filename.
      banner: {
        js: [
          'import { createRequire as __lumenCreateRequire } from "module";',
          'import { dirname as __lumenDirname } from "path";',
          'import { fileURLToPath as __lumenFileURLToPath } from "url";',
          "const require = __lumenCreateRequire(import.meta.url);",
          "const __filename = __lumenFileURLToPath(import.meta.url);",
          "const __dirname = __lumenDirname(__filename);",
        ].join("\n"),
      },
      logLevel: "error",
    });
  } catch {
    fail("main process build failed");
  }

  return outfile;
}

/* ------------------------------------------------------------------- dev */

function watchTree(paths: string[], onChange: () => void): FSWatcher[] {
  const watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, 80);
  };

  for (const target of paths) {
    if (!existsSync(target)) continue;
    try {
      watchers.push(watch(target, { recursive: true }, schedule));
    } catch {
      // Recursive watching is unavailable (some Linux setups): watch top level.
      watchers.push(watch(target, schedule));
    }
  }
  return watchers;
}

async function commandDev(config: LumenConfig, options: { watch: boolean }): Promise<void> {
  const outDir = join(ROOT, ".lumen", "dev", "assets");
  const started = Date.now();
  await buildView(config, outDir, false);
  log(`view built in ${Date.now() - started}ms → ${outDir}`);

  process.env.LUMEN_DEV = "1";
  process.env.LUMEN_ASSETS_DIR = outDir;

  const { app } = await import("@lumen/shell/main");
  app.configure({
    name: config.app?.name,
    version: config.app?.version,
    identifier: config.app?.identifier,
    assetsDir: outDir,
  });

  // The app entry registers `app.on("ready")` handlers, then starts the loop.
  await import(pathToFileURL(join(ROOT, config.main)).href);

  if (options.watch) {
    const watchers = watchTree(
      [join(ROOT, "src"), join(ROOT, "packages")],
      () => {
        void (async () => {
          try {
            await buildView(config, outDir, false);
            app.reloadAllWindows();
            log("view rebuilt — window reloaded");
          } catch (error) {
            console.error("[lumen] rebuild failed:", error);
          }
        })();
      },
    );
    log(`watching src/ and packages/ (${watchers.length} watcher(s))`);
  }
}

/* ---------------------------------------------------------- build/package */

function appSlug(config: LumenConfig): string {
  return (config.app?.name ?? "App").replace(/[^\w.-]+/g, "");
}

async function commandBuild(config: LumenConfig): Promise<void> {
  const root = join(ROOT, ".lumen", "build");
  await rm(root, { recursive: true, force: true });
  await buildView(config, join(root, "assets"), true);
  const mainFile = await buildMain(config, join(root, "main"));
  log(`built view → ${join(root, "assets")}`);
  log(`built main → ${mainFile}`);
}

async function commandPackage(config: LumenConfig): Promise<string> {
  await commandBuild(config);

  const slug = appSlug(config);
  const outDir = join(ROOT, "dist", slug);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  // Copy build output.
  await cp(join(ROOT, ".lumen", "build", "assets"), join(outDir, "assets"), { recursive: true });
  await copyFile(join(ROOT, ".lumen", "build", "main", "main.mjs"), join(outDir, "main.mjs"));

  // Native pieces: webview glue, FFI addon, PTY addon.
  await copyWebviewLibrary(outDir);
  await copyNativeModules(outDir);

  for (const extra of config.package?.extra ?? []) {
    await cp(join(ROOT, extra), join(outDir, basename(extra)), { recursive: true });
  }

  // A Node single executable application (SEA) that loads main.mjs next to it.
  const exeName = `${slug}${process.platform === "win32" ? ".exe" : ""}`;
  await buildExecutable(config, join(outDir, exeName));
  log(`packaged → ${outDir}`);
  log(`run: ${join(outDir, exeName)}`);
  return outDir;
}

async function copyWebviewLibrary(outDir: string): Promise<void> {
  try {
    const library = resolveNativeLibrary();
    await copyFile(library, join(outDir, basename(library)));
  } catch (error) {
    console.warn(
      `[lumen] could not locate ${nativeLibraryName()} — the packaged app will need ` +
        `LUMEN_WEBVIEW_LIB to point at it (${error instanceof Error ? error.message.split("\n")[0] : error})`,
    );
  }
}

/** Resolve an installed package directory (following pnpm's symlinks). */
function packageDir(name: string, from: string): string | null {
  const require = createRequire(from);
  try {
    return realpathSync(dirname(require.resolve(`${name}/package.json`)));
  } catch {
    /* package.json is not exported — walk up from the entry point instead */
  }
  try {
    let dir = dirname(realpathSync(require.resolve(name)));
    while (dir !== dirname(dir)) {
      const manifest = join(dir, "package.json");
      if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === name) return dir;
      dir = dirname(dir);
    }
  } catch {
    /* not installed */
  }
  return null;
}

/** Copy the external native modules (and only what they load at runtime) into the app. */
async function copyNativeModules(outDir: string): Promise<void> {
  const modules = join(outDir, "node_modules");
  const skipDebugSymbols = (source: string) => !source.endsWith(".pdb");

  // koffi: the JS loader plus the prebuilt addon for this platform.
  const koffi = packageDir("koffi", import.meta.url);
  if (koffi) {
    await cp(koffi, join(modules, "koffi"), { recursive: true, dereference: true });
    const binary = `@koromix/koffi-${process.platform}-${process.arch}`;
    const binaryDir = packageDir(binary, join(koffi, "package.json"));
    if (binaryDir) await cp(binaryDir, join(modules, binary), { recursive: true, dereference: true });
    else console.warn(`[lumen] ${binary} is not installed — the packaged app cannot load koffi`);
  } else {
    console.warn("[lumen] koffi is not installed — the packaged app cannot open windows");
  }

  // node-pty: lib/ + the addon (prebuilds for this platform, or a local build).
  const pty = packageDir("node-pty", join(ROOT, "package.json"));
  if (!pty) return;
  const target = join(modules, "node-pty");
  await mkdir(target, { recursive: true });
  await copyFile(join(pty, "package.json"), join(target, "package.json"));
  await cp(join(pty, "lib"), join(target, "lib"), { recursive: true });
  for (const dir of ["build/Release", `prebuilds/${process.platform}-${process.arch}`]) {
    if (existsSync(join(pty, dir))) {
      await cp(join(pty, dir), join(target, dir), { recursive: true, filter: skipDebugSymbols });
    }
  }
}

/**
 * Build a Node single executable application: a copy of the running `node`
 * binary with a tiny launcher injected, which loads main.mjs from its directory.
 */
async function buildExecutable(config: LumenConfig, exePath: string): Promise<void> {
  const work = join(ROOT, ".lumen", "sea");
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });

  const launcher = join(work, "launcher.cjs");
  await writeFile(
    launcher,
    [
      'const { createRequire } = require("node:module");',
      'const { dirname, join, resolve } = require("node:path");',
      // child_process.fork() re-runs this executable as `<exe> <exe> <script> ...args`
      // (node-pty's helper when a terminal closes, extension language servers…):
      // run that script the way node would instead of starting another app.
      "let forked = null;",
      "if (process.send && process.argv[2]) {",
      // (The SEA's own require() only loads built-in modules.)
      "  try { forked = createRequire(process.execPath).resolve(resolve(process.argv[2])); } catch {}",
      "}",
      "if (forked) {",
      "  process.argv.splice(1, 2, forked);",
      "  createRequire(forked)(forked);",
      "} else {",
      '  const main = join(dirname(process.execPath), "main.mjs");',
      "  createRequire(main)(main);",
      "}",
      "",
    ].join("\n"),
  );

  const blob = join(work, "sea-prep.blob");
  const seaConfig = join(work, "sea-config.json");
  await writeFile(seaConfig, JSON.stringify({ main: launcher, output: blob, disableExperimentalSEAWarning: true }));
  run(process.execPath, ["--experimental-sea-config", seaConfig], "generating the SEA blob");

  await copyFile(process.execPath, exePath);
  if (process.platform === "darwin") run("codesign", ["--remove-signature", exePath], "removing the signature");
  if (process.platform === "win32") {
    const name = config.app?.name ?? "App";
    const publisher = config.package?.publisher;
    await brandExecutable(exePath, {
      icon: config.package?.icon ? join(ROOT, config.package.icon) : undefined,
      version: {
        version: config.app?.version ?? "0.0.0",
        productName: name,
        fileDescription: name,
        companyName: publisher,
        copyright: publisher ? `Copyright (c) ${new Date().getFullYear()} ${publisher}` : undefined,
        originalFilename: basename(exePath),
      },
    }).catch((error: unknown) => fail(`branding the executable failed: ${error instanceof Error ? error.message : error}`));
  }

  const require = createRequire(import.meta.url);
  const { inject } = require("postject") as {
    inject: (
      file: string,
      resource: string,
      data: Buffer,
      options: { sentinelFuse: string; machoSegmentName?: string },
    ) => Promise<void>;
  };
  await inject(exePath, "NODE_SEA_BLOB", await readFile(blob), {
    sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    machoSegmentName: process.platform === "darwin" ? "NODE_SEA" : undefined,
  });

  if (process.platform === "darwin") run("codesign", ["--sign", "-", exePath], "ad-hoc signing");
  if (process.platform === "win32") await useWindowsSubsystem(exePath);
  await rm(work, { recursive: true, force: true });
}

/* ------------------------------------------------------------- installer */

function findMakensis(): string {
  const candidates = [
    process.env.NSIS_HOME && join(process.env.NSIS_HOME, "makensis.exe"),
    join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "NSIS", "makensis.exe"),
    join(process.env.ProgramFiles ?? "C:\\Program Files", "NSIS", "makensis.exe"),
  ];
  const found = candidates.find((path): path is string => Boolean(path && existsSync(path)));
  if (found) return found;
  const onPath = spawnSync("makensis", ["/VERSION"], { stdio: "ignore", windowsHide: true });
  if (onPath.status === 0) return "makensis";
  return fail("NSIS is not installed (winget install NSIS.NSIS), or set NSIS_HOME");
}

/** A quoted NSIS string; `$` still starts a variable ($INSTDIR…). */
function nsisString(value: string): string {
  return `"${value.replace(/"/g, '$\\"')}"`;
}

/** Plain text inside an NSIS string: `$` is literal. */
function nsisText(value: string): string {
  return value.replace(/\$/g, "$$$$");
}

/** Bytes used by a directory tree. */
async function treeSize(path: string): Promise<number> {
  const info = await stat(path);
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const entry of await readdir(path)) total += await treeSize(join(path, entry));
  return total;
}

/**
 * A per-user installer (no administrator rights, like VS Code's user setup):
 * installs to %LOCALAPPDATA%\Programs\<App>, adds a Start menu shortcut and an
 * entry in Windows' installed apps list.
 */
async function commandInstaller(config: LumenConfig): Promise<void> {
  if (process.platform !== "win32") fail("installer is only supported on Windows");
  const makensis = findMakensis();
  const appDir = await commandPackage(config);

  const slug = appSlug(config);
  const rawVersion = config.app?.version ?? "0.0.0";
  const outFile = join(ROOT, "dist", `${slug}-${rawVersion}-win32-${process.arch}-setup.exe`);
  // Everything below is spliced into NSIS strings.
  const name = nsisText(config.app?.name ?? "App");
  const version = nsisText(rawVersion);
  const publisher = nsisText(config.package?.publisher ?? config.app?.name ?? "App");
  const exeName = nsisText(`${slug}.exe`);
  const uninstaller = `Uninstall ${name}.exe`;
  const uninstallKey = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${nsisText(config.app?.identifier ?? slug)}`;
  const icon = config.package?.icon ? nsisText(join(ROOT, config.package.icon)) : null;

  // Remove exactly what the app ships, never the whole folder the user picked.
  const entries = await readdir(appDir, { withFileTypes: true });
  const removeApp = entries
    .map((entry) => (entry.isDirectory() ? "RMDir /r " : "Delete ") + nsisString(`$INSTDIR\\${nsisText(entry.name)}`))
    .map((line) => `  ${line}`)
    .join("\n");
  const sizeKb = Math.ceil((await treeSize(appDir)) / 1024);

  const script = `Unicode true
ManifestDPIAware true
SetCompressor /SOLID lzma
RequestExecutionLevel user
!include "MUI2.nsh"

Name ${nsisString(name)}
OutFile ${nsisString(nsisText(outFile))}
InstallDir ${nsisString(`$LOCALAPPDATA\\Programs\\${name}`)}
InstallDirRegKey HKCU ${nsisString(uninstallKey)} "InstallLocation"
BrandingText ${nsisString(`${name} ${version}`)}

VIProductVersion "${versionParts(rawVersion).join(".")}"
VIAddVersionKey /LANG=1033 "ProductName" ${nsisString(name)}
VIAddVersionKey /LANG=1033 "FileDescription" ${nsisString(`${name} Setup`)}
VIAddVersionKey /LANG=1033 "FileVersion" ${nsisString(version)}
VIAddVersionKey /LANG=1033 "ProductVersion" ${nsisString(version)}
VIAddVersionKey /LANG=1033 "CompanyName" ${nsisString(publisher)}
VIAddVersionKey /LANG=1033 "LegalCopyright" ${nsisString(`Copyright (c) ${new Date().getFullYear()} ${publisher}`)}
${icon ? `!define MUI_ICON ${nsisString(icon)}\n!define MUI_UNICON ${nsisString(icon)}\n` : ""}
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN ${nsisString(`$INSTDIR\\${exeName}`)}
!define MUI_FINISHPAGE_SHOWREADME ""
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
!define MUI_FINISHPAGE_SHOWREADME_TEXT "$(DesktopShortcut)"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION CreateDesktopShortcut

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "Japanese"
LangString DesktopShortcut \${LANG_ENGLISH} "Create a desktop shortcut"
LangString DesktopShortcut \${LANG_JAPANESE} "デスクトップにショートカットを作成"

Function CreateDesktopShortcut
  CreateShortcut ${nsisString(`$DESKTOP\\${name}.lnk`)} ${nsisString(`$INSTDIR\\${exeName}`)}
FunctionEnd

Section
  SetOutPath "$INSTDIR"
  ; Drop the previous version's files so nothing stale is left behind.
${removeApp}
  File /r ${nsisString(`${nsisText(appDir)}\\*`)}
  WriteUninstaller ${nsisString(`$INSTDIR\\${uninstaller}`)}
  CreateShortcut ${nsisString(`$SMPROGRAMS\\${name}.lnk`)} ${nsisString(`$INSTDIR\\${exeName}`)}

  WriteRegStr HKCU ${nsisString(uninstallKey)} "DisplayName" ${nsisString(name)}
  WriteRegStr HKCU ${nsisString(uninstallKey)} "DisplayVersion" ${nsisString(version)}
  WriteRegStr HKCU ${nsisString(uninstallKey)} "Publisher" ${nsisString(publisher)}
  WriteRegStr HKCU ${nsisString(uninstallKey)} "DisplayIcon" ${nsisString(`$INSTDIR\\${exeName}`)}
  WriteRegStr HKCU ${nsisString(uninstallKey)} "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU ${nsisString(uninstallKey)} "UninstallString" ${nsisString(`"$INSTDIR\\${uninstaller}"`)}
  WriteRegDWORD HKCU ${nsisString(uninstallKey)} "EstimatedSize" ${sizeKb}
  WriteRegDWORD HKCU ${nsisString(uninstallKey)} "NoModify" 1
  WriteRegDWORD HKCU ${nsisString(uninstallKey)} "NoRepair" 1
SectionEnd

Section "Uninstall"
${removeApp}
  Delete ${nsisString(`$INSTDIR\\${uninstaller}`)}
  RMDir "$INSTDIR"
  Delete ${nsisString(`$SMPROGRAMS\\${name}.lnk`)}
  Delete ${nsisString(`$DESKTOP\\${name}.lnk`)}
  DeleteRegKey HKCU ${nsisString(uninstallKey)}
SectionEnd
`;

  const work = join(ROOT, ".lumen", "installer");
  await mkdir(work, { recursive: true });
  const scriptPath = join(work, "installer.nsi");
  await writeFile(scriptPath, script);
  run(makensis, ["/V2", "/INPUTCHARSET", "UTF8", scriptPath], "building the installer");
  log(`installer → ${outFile}`);
}

function run(command: string, args: string[], what: string): void {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) fail(`${what} failed`);
}

/* ------------------------------------------------------------------ main */

async function main(): Promise<void> {
  const [command = "dev", ...rest] = process.argv.slice(2);
  const flags = new Set(rest.filter((value) => value.startsWith("--")));
  const config = await loadConfig();

  switch (command) {
    case "dev":
    case "start":
      await commandDev(config, { watch: flags.has("--watch") || flags.has("-w") });
      break;
    case "build":
      await commandBuild(config);
      break;
    case "package":
      await commandPackage(config);
      break;
    case "installer":
      await commandInstaller(config);
      break;
    case "help":
    case "--help":
    case "-h":
      console.log(
        [
          "lumen-shell <command>",
          "",
          "  dev [--watch]   build the view, serve it, launch the app",
          "  build           production bundle into .lumen/build",
          "  package         standalone app directory in dist/",
          "  installer       Windows setup executable (NSIS) in dist/",
        ].join("\n"),
      );
      break;
    default:
      fail(`unknown command "${command}" (try: lumen-shell help)`);
  }
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}

export { loadConfig, buildView, buildMain };
