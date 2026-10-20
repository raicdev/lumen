import { readZipFile } from "./vsix.ts";

/**
 * VS Code's target platforms (`vsce package --target`): an extension that
 * ships native code is published once per platform, and a package for another
 * platform does not work here (its binaries are missing).
 */

const LABELS: Record<string, string> = {
  "win32-x64": "Windows x64",
  "win32-arm64": "Windows ARM64",
  "linux-x64": "Linux x64",
  "linux-arm64": "Linux ARM64",
  "linux-armhf": "Linux ARM (32-bit)",
  "alpine-x64": "Alpine Linux x64",
  "alpine-arm64": "Alpine Linux ARM64",
  "darwin-x64": "macOS Intel",
  "darwin-arm64": "macOS Apple Silicon",
  web: "the web",
  universal: "all platforms",
};

export const platformLabel = (target: string) => LABELS[target] ?? target;

/** Whether this Linux uses musl (Alpine) rather than glibc. */
function isMusl(): boolean {
  try {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
    return !report?.header?.glibcVersionRuntime;
  } catch {
    return false;
  }
}

/** The target platform of this computer (`win32-x64`, `alpine-arm64`, …). */
export function currentTargetPlatform(platform: string = process.platform, arch: string = process.arch, musl = platform === "linux" && isMusl()): string {
  const cpu = arch === "arm" ? "armhf" : arch;
  if (platform === "linux" && musl) return `alpine-${cpu}`;
  return `${platform}-${cpu}`;
}

/** Whether a package built for `target` (none: any platform) runs on `current`. */
export function runsOn(target: string | undefined, current = currentTargetPlatform()): boolean {
  return !target || target === "universal" || target === current;
}

/** The target platform a .vsix declares (extension.vsixmanifest), if any. */
export function vsixTargetPlatform(vsix: Buffer): string | undefined {
  const manifest = readZipFile(vsix, "extension.vsixmanifest")?.toString("utf8");
  return manifest ? /<Identity\b[^>]*\bTargetPlatform="([^"]+)"/.exec(manifest)?.[1] : undefined;
}
