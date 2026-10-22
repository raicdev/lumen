import { spawn } from "child_process";
import { createHash } from "crypto";
import { createWriteStream, existsSync } from "fs";
import { mkdir, readdir, readFile, rename, rm } from "fs/promises";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";

/**
 * Updates from GitHub Releases: the latest release whose tag (`v1.2.3`) is a
 * newer version than the running app. On Windows the release's per-user setup
 * (`lumen-shell installer`, `<App>-<version>-win32-<arch>-setup.exe`) is
 * downloaded, checked against the SHA-256 digest GitHub publishes for it, and
 * run silently over the installed app once the app exits.
 */

export type UpdaterConfig = {
  /** `owner/name` of the GitHub repository whose releases are the updates. */
  repository: string;
  /** App name: the installed app has `Uninstall <name>.exe` next to its executable. */
  name: string;
  /** Running version (semver). */
  version: string;
  /** Names the download directory. */
  identifier: string;
};

export type UpdateRelease = {
  version: string;
  /** Release title (falls back to the tag). */
  title: string;
  /** Release notes (Markdown). */
  notes: string;
  /** Release page. */
  url: string;
  /** The setup for this platform and architecture, when the release has one. */
  installer: { name: string; url: string; size: number; sha256: string | null } | null;
};

type GitHubRelease = {
  tag_name?: unknown;
  name?: unknown;
  body?: unknown;
  html_url?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  assets?: { name?: unknown; browser_download_url?: unknown; size?: unknown; digest?: unknown }[];
};

/** `1.2.3` (an optional leading `v`) as numbers; null for anything else, pre-releases included. */
export function parseVersion(value: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** The running version: plain semver, or a pre-release of one (`0.2.2-beta.1`) so beta builds still find updates. */
export function parseRunningVersion(value: string): { core: [number, number, number]; prerelease: boolean } | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/.exec(value.trim());
  return match ? { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: !!match[4] } : null;
}

/** Negative, zero or positive as `a` is older than, the same as or newer than `b`. */
export function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** The setup asset for a platform/architecture (only Windows has one). */
export function installerAssetPattern(platform: string, arch: string): RegExp | null {
  return platform === "win32" ? new RegExp(`-win32-${arch}-setup\\.exe$`, "i") : null;
}

/** A GitHub release as an update, or null when it is not newer than `current` (or not a stable release). */
export function releaseUpdate(release: GitHubRelease, current: string, assetPattern: RegExp | null): UpdateRelease | null {
  if (release.draft || release.prerelease || typeof release.tag_name !== "string") return null;
  const version = parseVersion(release.tag_name);
  const running = parseRunningVersion(current);
  if (!version || !running) return null;
  const order = compareVersions(version, running.core);
  // A stable release is newer than the pre-releases of its own version (0.2.2 over 0.2.2-beta.1).
  if (order < 0 || (order === 0 && !running.prerelease)) return null;
  const asset = assetPattern
    ? (release.assets ?? []).find((entry) => typeof entry.name === "string" && assetPattern.test(entry.name))
    : undefined;
  const digest = typeof asset?.digest === "string" ? /^sha256:([0-9a-f]{64})$/i.exec(asset.digest) : null;
  return {
    version: version.join("."),
    title: typeof release.name === "string" && release.name ? release.name : release.tag_name,
    notes: typeof release.body === "string" ? release.body : "",
    url: typeof release.html_url === "string" ? release.html_url : "",
    installer:
      asset && typeof asset.name === "string" && typeof asset.browser_download_url === "string"
        ? {
            name: asset.name,
            url: asset.browser_download_url,
            size: typeof asset.size === "number" ? asset.size : 0,
            sha256: digest ? digest[1].toLowerCase() : null,
          }
        : null,
  };
}

/** Asset names end up in a file path: nothing but a plain file name. */
function safeFileName(name: string): string {
  const base = basename(name.replace(/\\/g, "/"));
  if (!base || base === "." || base === ".." || /[<>:"|?*\x00-\x1f]/.test(base)) throw new Error(`unexpected asset name "${name}"`);
  return base;
}

async function sha256Of(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

class AutoUpdater {
  #config: UpdaterConfig | null = null;

  configure(config: UpdaterConfig): void {
    this.#config = config;
  }

  get #settings(): UpdaterConfig {
    if (!this.#config) throw new Error("autoUpdater.configure() was not called");
    return this.#config;
  }

  /** Where downloaded setups are kept until they are installed. */
  get downloadDir(): string {
    return join(tmpdir(), `${this.#settings.identifier}-updates`);
  }

  /**
   * Whether an update can be installed in place: a packaged Windows app that
   * its setup installed (portable copies and dev runs only get told about updates).
   */
  get canInstall(): boolean {
    if (process.platform !== "win32" || process.env.LUMEN_DEV) return false;
    return existsSync(join(dirname(process.execPath), `Uninstall ${this.#settings.name}.exe`));
  }

  /** The latest release when it is newer than the running app, else null. */
  async check(signal?: AbortSignal): Promise<UpdateRelease | null> {
    const { repository, name, version } = this.#settings;
    const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": `${name}/${version}`, "X-GitHub-Api-Version": "2022-11-28" },
      signal,
    });
    // No published release yet.
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub answered ${response.status} ${response.statusText}`);
    const release = (await response.json()) as GitHubRelease;
    return releaseUpdate(release, version, installerAssetPattern(process.platform, process.arch));
  }

  /**
   * Download the release's setup (reusing an earlier download of it) and check
   * its SHA-256 digest; resolves with the file. Other downloads are removed.
   */
  async download(release: UpdateRelease, onProgress?: (received: number, total: number) => void, signal?: AbortSignal): Promise<string> {
    const installer = release.installer;
    if (!installer) throw new Error(`release ${release.version} has no setup for ${process.platform}-${process.arch}`);
    if (!installer.sha256) throw new Error(`release ${release.version} publishes no SHA-256 digest for ${installer.name}`);
    const dir = this.downloadDir;
    const file = join(dir, safeFileName(installer.name));
    await mkdir(dir, { recursive: true });
    for (const entry of await readdir(dir)) {
      if (entry !== basename(file)) await rm(join(dir, entry), { recursive: true, force: true }).catch(() => undefined);
    }
    if (existsSync(file) && (await sha256Of(file)) === installer.sha256) return file;

    const { name, version } = this.#settings;
    const response = await fetch(installer.url, { headers: { "User-Agent": `${name}/${version}` }, signal });
    if (!response.ok || !response.body) throw new Error(`download failed: ${response.status} ${response.statusText}`);
    const total = Number(response.headers.get("content-length")) || installer.size;
    const partial = `${file}.part`;
    const hash = createHash("sha256");
    const out = createWriteStream(partial);
    const reader = response.body.getReader();
    let received = 0;
    try {
      for (let next = await reader.read(); !next.done; next = await reader.read()) {
        const chunk = next.value;
        hash.update(chunk);
        received += chunk.length;
        if (!out.write(chunk)) await new Promise<void>((resolve) => out.once("drain", resolve));
        onProgress?.(received, total);
      }
      await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())));
    } catch (error) {
      out.destroy();
      await rm(partial, { force: true });
      throw error;
    }
    const digest = hash.digest("hex");
    if (digest !== installer.sha256) {
      await rm(partial, { force: true });
      throw new Error(`the downloaded ${installer.name} does not match its published SHA-256 digest`);
    }
    await rename(partial, file);
    return file;
  }

  /**
   * Start the downloaded setup in the background; the caller exits next. The
   * setup waits until the app's files are no longer in use, installs over the
   * current installation and, with `relaunch`, starts the app again.
   */
  install(file: string, options: { relaunch?: boolean } = {}): void {
    if (!this.canInstall) throw new Error("this copy of the app cannot install updates");
    const installDir = dirname(process.execPath);
    // NSIS reads /D= raw up to the end of the command line: it must come last and stay unquoted.
    const args = ["/S", ...(options.relaunch ? ["/RELAUNCH"] : []), `/D=${installDir}`].join(" ");
    const child = spawn(file, [args], { argv0: `"${file}"`, detached: true, stdio: "ignore", windowsVerbatimArguments: true });
    child.unref();
  }

  /** Remove downloaded setups (e.g. once no update is pending). */
  async cleanup(): Promise<void> {
    await rm(this.downloadDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export const autoUpdater = new AutoUpdater();
