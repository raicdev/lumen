import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

/**
 * Locates the `webview` native library (the ~400 KB glue between our runtime and
 * the OS webview). We intentionally ship our own FFI bindings + event loop on
 * top of it instead of depending on a framework.
 *
 * Prebuilt copies of the library live in `packages/lumen-shell/native/`.
 */
export function nativeLibraryName(): string {
  if (process.platform === "win32") return "libwebview.dll";
  if (process.platform === "darwin") return "libwebview.dylib";
  return process.arch === "arm64" ? "libwebview-arm64.so" : "libwebview-x64.so";
}

export function resolveNativeLibrary(): string {
  const override = process.env.LUMEN_WEBVIEW_LIB;
  if (override && existsSync(override)) return override;

  const name = nativeLibraryName();
  const candidates: string[] = [];

  // 1. Next to the executable (packaged app).
  const exeDir = dirname(process.execPath);
  candidates.push(join(exeDir, name), join(exeDir, "native", name));

  // 2. The prebuilt copy shipped with this package (src/main/native → native/).
  try {
    candidates.push(fileURLToPath(new URL(`../../../native/${name}`, import.meta.url)));
  } catch {
    /* bundled into a non-file URL — try the fallbacks below */
  }

  // 3. Relative to the working directory (bundled main process / tests).
  candidates.push(
    join(process.cwd(), "node_modules", "@lumen", "shell", "native", name),
    join(process.cwd(), "packages", "lumen-shell", "native", name),
    join(process.cwd(), "native", name),
  );

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    `Lumen Shell: could not find ${name}. Restore packages/lumen-shell/native/ ` +
      `or point LUMEN_WEBVIEW_LIB at it.\nChecked:\n` +
      candidates.map((candidate) => `  - ${candidate}`).join("\n"),
  );
}
