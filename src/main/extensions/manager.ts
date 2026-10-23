import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { dirname, extname, isAbsolute, join, resolve, sep } from "path";
import { randomBytes } from "crypto";
import type { CompatReport, ExtensionDescription, ExtensionManifest, ExtensionSource, MarketplaceCompat } from "../../shared/extensions.ts";
import { TRANSPILER_VERSION, isVscodeManifest, refreshReport, transpileExtension, transpileVsix } from "./transpiler.ts";
import { extractZip, readZipFile } from "./vsix.ts";
import { currentTargetPlatform, platformLabel, runsOn, vsixTargetPlatform } from "./platform.ts";
import { localizedFileNames } from "../../shared/i18n.ts";

/**
 * Installed extensions: ~/.lumen/extensions/<publisher.name-version>/ (like
 * ~/.vscode/extensions) plus folders registered for development, recorded in
 * ~/.lumen/extensions/extensions.json with their enabled state.
 *
 * VS Code packages are transpiled when they are installed; development
 * folders are only analyzed and run through the compatibility layer, so their
 * sources stay as they are.
 */

type RegistryEntry = {
  id: string;
  /** Folder name below the extensions dir, or an absolute path (development). */
  location: string;
  enabled: boolean;
  development?: boolean;
  source?: ExtensionSource;
  installedAt?: number;
};

type Registry = { version: 1; extensions: RegistryEntry[]; obsolete?: string[] };

export function extensionsDir(): string {
  return process.env.LUMEN_EXTENSIONS_DIR ?? join(homedir(), ".lumen", "extensions");
}

/** App data folder for extension storage (globalStorage, workspaceStorage, logs). */
export function userDataDir(appName: string): string {
  const base =
    process.platform === "win32"
      ? (process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"))
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support")
        : (process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
  return join(base, appName);
}

export function extensionId(manifest: ExtensionManifest): string {
  return `${manifest.publisher || "undefined_publisher"}.${manifest.name}`;
}

/** The id and version become a folder name below the extensions dir: plain words only. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-_]*$/i;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function readManifest(dir: string): ExtensionManifest | null {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as ExtensionManifest;
    return manifest.name && manifest.version ? manifest : null;
  } catch {
    return null;
  }
}

/** The display language the view uses (it says so at startup); manifests and l10n bundles follow it. */
let displayLanguage = "en";

export function setDisplayLanguage(language: string): void {
  displayLanguage = language;
}

export function getDisplayLanguage(): string {
  return displayLanguage;
}

function readNlsBundle(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Replace "%key%" strings (titles, categories, descriptions…) with their text
 * from package.nls.<language>.json, falling back to package.nls.json, as VS Code
 * does; keys neither has stay as they are.
 */
function localizeManifest(dir: string, manifest: ExtensionManifest): ExtensionManifest {
  const bundles = [...localizedFileNames(displayLanguage, (locale) => `package.nls.${locale}.json`), "package.nls.json"]
    .map((name) => readNlsBundle(join(dir, name)))
    .filter((bundle): bundle is Record<string, unknown> => !!bundle);
  if (!bundles.length) return manifest;
  // The most specific file wins; the default fills in what a translation leaves out.
  const bundle: Record<string, unknown> = Object.assign({}, ...bundles.toReversed());
  const localize = (value: unknown): unknown => {
    if (typeof value === "string") {
      const key = /^%(.+)%$/.exec(value)?.[1];
      const text = key === undefined ? undefined : bundle[key];
      // Entries may also be { message, comment } objects.
      if (typeof text === "string") return text;
      if (text && typeof text === "object" && typeof (text as { message?: unknown }).message === "string") return (text as { message: string }).message;
      return value;
    }
    if (Array.isArray(value)) return value.map(localize);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, localize(item)]));
    return value;
  };
  return localize(manifest) as ExtensionManifest;
}

function readReport(dir: string, manifest: ExtensionManifest): CompatReport | undefined {
  try {
    return refreshReport(JSON.parse(readFileSync(join(dir, "lumen-compat.json"), "utf8")) as CompatReport, manifest);
  } catch {
    return undefined;
  }
}

const ICON_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".gif": "image/gif" };

function iconDataUrl(dir: string, icon: string | undefined): string | undefined {
  if (!icon) return undefined;
  const type = ICON_TYPES[extname(icon).toLowerCase()];
  const file = resolve(dir, icon);
  if (!type || !file.startsWith(resolve(dir) + sep)) return undefined;
  try {
    if (statSync(file).size > 512 * 1024) return undefined;
    return `data:${type};base64,${readFileSync(file).toString("base64")}`;
  } catch {
    return undefined;
  }
}

/** Icons of the view containers an extension contributes (files in its folder; codicons stay as they are). */
function containerIcons(dir: string, manifest: ExtensionManifest): Record<string, string> | undefined {
  const containers = (manifest.contributes?.viewsContainers ?? {}) as Record<string, { id: string; icon?: string }[]>;
  const icons: Record<string, string> = {};
  for (const container of Object.values(containers).flat()) {
    if (!container?.icon) continue;
    const icon = container.icon.startsWith("$(") ? container.icon : iconDataUrl(dir, container.icon);
    if (icon) icons[container.id] = icon;
  }
  return Object.keys(icons).length ? icons : undefined;
}

/** Icon files of contributed commands (shown in view title bars and item menus). */
function commandIcons(dir: string, manifest: ExtensionManifest): Record<string, string> | undefined {
  const icons: Record<string, string> = {};
  for (const command of [manifest.contributes?.commands ?? []].flat()) {
    const icon = command?.icon as string | { light?: string; dark?: string } | undefined;
    const file = typeof icon === "string" ? icon : (icon?.dark ?? icon?.light);
    if (!file || file.startsWith("$(")) continue;
    const url = iconDataUrl(dir, file);
    if (url) icons[command.command] = url;
  }
  return Object.keys(icons).length ? icons : undefined;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

/** The compatibility of a .vsix, analyzed in a temporary folder (nothing is installed or written). */
export function analyzeVsix(vsix: Buffer): { result: MarketplaceCompat; manifest?: ExtensionManifest } {
  const raw = readZipFile(vsix, "extension/package.json");
  if (!raw) throw new Error("not a VS Code extension package (extension/package.json is missing)");
  const manifest = JSON.parse(raw.toString("utf8")) as ExtensionManifest;
  if (!isVscodeManifest(manifest)) return { result: { kind: "lumen", analyzedAt: Date.now() } };
  const dir = join(tmpdir(), `lumen-analyze-${randomBytes(4).toString("hex")}`);
  try {
    extractZip(vsix, dir, "extension/");
    const { manifest: transpiled, report } = transpileExtension(dir, undefined, { write: false });
    return { result: { kind: "vscode", report, vscodeEngine: transpiled.lumen?.vscodeEngine, analyzedAt: Date.now() }, manifest: transpiled };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

type CompatCacheEntry = { result: MarketplaceCompat; manifest?: ExtensionManifest; transpilerVersion: number };

/** Most packages kept in the compatibility cache (the least recently analyzed go first). */
const COMPAT_CACHE_LIMIT = 200;

/**
 * Compatibility of Open VSX packages analyzed before install, by
 * `namespace.name@version` (a published version never changes), kept in
 * ~/.lumen/extensions/compat-cache.json so a check does not download the
 * package again.
 */
export class CompatCache {
  readonly #path = join(extensionsDir(), "compat-cache.json");
  #entries: Record<string, CompatCacheEntry> | null = null;

  static key(namespace: string, name: string, version: string): string {
    return `${namespace}.${name}@${version}`.toLowerCase();
  }

  #load(): Record<string, CompatCacheEntry> {
    if (this.#entries) return this.#entries;
    try {
      this.#entries = JSON.parse(readFileSync(this.#path, "utf8")) as Record<string, CompatCacheEntry>;
    } catch {
      this.#entries = {};
    }
    return this.#entries;
  }

  /** A cached result, re-rated against the current API table (like stored reports of installed extensions). */
  get(key: string): MarketplaceCompat | null {
    const entry = this.#load()[key];
    // Another transpiler may find other things in the code: analyze again.
    if (!entry || entry.transpilerVersion !== TRANSPILER_VERSION) return null;
    const report = entry.result.report && entry.manifest ? refreshReport(entry.result.report, entry.manifest) : entry.result.report;
    return { ...entry.result, report, cached: true };
  }

  set(key: string, result: MarketplaceCompat, manifest?: ExtensionManifest): void {
    const entries = this.#load();
    entries[key] = { result, manifest, transpilerVersion: TRANSPILER_VERSION };
    const keys = Object.keys(entries);
    if (keys.length > COMPAT_CACHE_LIMIT) {
      keys
        .sort((a, b) => (entries[a]!.result.analyzedAt ?? 0) - (entries[b]!.result.analyzedAt ?? 0))
        .slice(0, keys.length - COMPAT_CACHE_LIMIT)
        .forEach((old) => delete entries[old]);
    }
    try {
      mkdirSync(extensionsDir(), { recursive: true });
      const temp = `${this.#path}.tmp`;
      writeFileSync(temp, JSON.stringify(entries), "utf8");
      renameSync(temp, this.#path);
    } catch (error) {
      console.warn("[extensions] could not write the compatibility cache", error);
    }
  }
}

export class ExtensionManager {
  readonly dir = extensionsDir();
  readonly #registryPath = join(this.dir, "extensions.json");
  /** Development folders analyzed in this session (they are not transpiled on disk). */
  #devReports = new Map<string, CompatReport>();

  constructor() {
    this.#cleanup();
  }

  #load(): Registry {
    try {
      const registry = JSON.parse(readFileSync(this.#registryPath, "utf8")) as Registry;
      if (registry.version === 1 && Array.isArray(registry.extensions)) return registry;
    } catch {
      /* first run or unreadable: rebuilt from the folders */
    }
    return { version: 1, extensions: [] };
  }

  #save(registry: Registry): void {
    mkdirSync(this.dir, { recursive: true });
    const temp = `${this.#registryPath}.tmp`;
    writeFileSync(temp, JSON.stringify(registry, null, 2), "utf8");
    renameSync(temp, this.#registryPath);
  }

  #path(entry: RegistryEntry): string {
    return isAbsolute(entry.location) ? entry.location : join(this.dir, entry.location);
  }

  /** Remove folders left behind by updates / uninstalls that were locked at the time. */
  #cleanup(): void {
    const registry = this.#load();
    if (!registry.obsolete?.length) return;
    registry.obsolete = registry.obsolete.filter((folder) => !this.#remove(join(this.dir, folder)));
    this.#save(registry);
  }

  /** Whether a folder is directly inside the extensions dir (nothing a package name could escape to). */
  #inside(path: string): boolean {
    return dirname(resolve(path)) === resolve(this.dir);
  }

  #remove(path: string): boolean {
    if (!this.#inside(path)) return false;
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 2 });
      return true;
    } catch {
      return false;
    }
  }

  /** The registry, completed with extension folders copied into the extensions dir by hand. */
  #sync(): Registry {
    const registry = this.#load();
    let changed = false;
    registry.extensions = registry.extensions.filter((entry) => {
      const keep = existsSync(join(this.#path(entry), "package.json"));
      if (!keep) changed = true;
      return keep;
    });
    let folders: string[] = [];
    try {
      folders = readdirSync(this.dir).filter((name) => !name.startsWith(".") && statSync(join(this.dir, name)).isDirectory());
    } catch {
      /* no extensions yet */
    }
    for (const folder of folders) {
      if (registry.extensions.some((entry) => entry.location === folder) || registry.obsolete?.includes(folder)) continue;
      const manifest = readManifest(join(this.dir, folder));
      if (!manifest) continue;
      const id = extensionId(manifest);
      const existing = registry.extensions.find((entry) => entry.id.toLowerCase() === id.toLowerCase());
      if (existing) continue;
      registry.extensions.push({ id, location: folder, enabled: true, installedAt: Date.now() });
      changed = true;
    }
    if (changed) this.#save(registry);
    return registry;
  }

  #describe(entry: RegistryEntry, withIcon: boolean): ExtensionDescription | null {
    const location = this.#path(entry);
    let manifest = readManifest(location);
    if (!manifest) return null;
    let compat = readReport(location, manifest);
    let kind: ExtensionDescription["kind"] = manifest.lumen?.transpiledFrom === "vscode" ? "vscode" : "lumen";
    if (isVscodeManifest(manifest)) {
      // A VS Code extension used in place (development folder): analyze it, run it through the compatibility layer.
      kind = "vscode";
      let report = this.#devReports.get(location);
      if (!report) {
        try {
          const result = transpileExtension(location, undefined, { write: false });
          report = result.report;
          manifest = { ...result.manifest, lumen: { ...result.manifest.lumen, transpiledAt: undefined } };
        } catch {
          /* described without a report */
        }
        if (report) this.#devReports.set(location, report);
      }
      compat = report;
    }
    manifest = localizeManifest(location, manifest);
    return {
      id: extensionId(manifest),
      manifest,
      location,
      enabled: entry.enabled,
      kind,
      development: !!entry.development,
      source: entry.source,
      compat,
      installedAt: entry.installedAt,
      iconUrl: withIcon ? iconDataUrl(location, manifest.icon) : undefined,
      containerIcons: containerIcons(location, manifest),
      commandIcons: commandIcons(location, manifest),
    };
  }

  list(options: { icons?: boolean } = {}): ExtensionDescription[] {
    return this.#sync()
      .extensions.map((entry) => this.#describe(entry, !!options.icons))
      .filter((description): description is ExtensionDescription => !!description)
      .sort((a, b) => (a.manifest.displayName ?? a.manifest.name).localeCompare(b.manifest.displayName ?? b.manifest.name));
  }

  /** What the extension host loads. */
  enabled(): ExtensionDescription[] {
    return this.list().filter((description) => description.enabled);
  }

  /** Install (or update) from a .vsix; VS Code packages are transpiled on the way in. */
  installVsix(vsix: Buffer, source: ExtensionSource): ExtensionDescription {
    const raw = readZipFile(vsix, "extension/package.json");
    if (!raw) throw new Error("not a VS Code extension package (extension/package.json is missing)");
    const manifest = JSON.parse(raw.toString("utf8")) as ExtensionManifest;
    if (!manifest.name || !manifest.version) throw new Error("the package manifest needs a name and a version");
    if (!NAME_PATTERN.test(manifest.publisher || "undefined_publisher") || !NAME_PATTERN.test(manifest.name) || !VERSION_PATTERN.test(manifest.version)) {
      throw new Error("invalid extension name/version in package manifest");
    }
    const id = extensionId(manifest);
    // A package for another platform lacks this platform's binaries (like VS Code, refuse it).
    const target = vsixTargetPlatform(vsix);
    if (!runsOn(target)) {
      throw new Error(
        `${id} ${manifest.version} is the package for ${platformLabel(target!)}; this computer needs the one for ${platformLabel(currentTargetPlatform())}.`,
      );
    }
    mkdirSync(this.dir, { recursive: true });
    const staging = join(this.dir, `.staging-${randomBytes(4).toString("hex")}`);
    try {
      if (isVscodeManifest(manifest)) transpileVsix(vsix, staging);
      // Already a Lumen extension: unpack it as it is.
      else extractZip(vsix, staging, "extension/");
      return this.#adopt(staging, id, manifest.version, source);
    } catch (error) {
      this.#remove(staging);
      throw error;
    }
  }

  /** Register a folder in place (development) — or copy it in with `copy`. */
  installFolder(path: string, options: { copy?: boolean } = {}): ExtensionDescription {
    const folder = resolve(path);
    const manifest = readManifest(folder);
    if (!manifest) throw new Error(`${folder} has no package.json with a name and a version`);
    const id = extensionId(manifest);
    if (options.copy) {
      const staging = join(this.dir, `.staging-${randomBytes(4).toString("hex")}`);
      try {
        if (isVscodeManifest(manifest)) transpileExtension(folder, staging);
        else cpSync(folder, staging, { recursive: true });
        return this.#adopt(staging, id, manifest.version, { type: "folder", path: folder });
      } catch (error) {
        this.#remove(staging);
        throw error;
      }
    }
    const registry = this.#sync();
    this.#retire(registry, id);
    registry.extensions.push({ id, location: folder, enabled: true, development: true, source: { type: "folder", path: folder }, installedAt: Date.now() });
    this.#save(registry);
    this.#devReports.delete(folder);
    return this.#describe(registry.extensions.at(-1)!, true)!;
  }

  /** Move a staged extension into place, replacing an older version. */
  #adopt(staging: string, id: string, version: string, source: ExtensionSource): ExtensionDescription {
    const registry = this.#sync();
    const previous = registry.extensions.find((entry) => entry.id.toLowerCase() === id.toLowerCase());
    if (previous && !previous.development && compareVersions(version, readManifest(this.#path(previous))?.version ?? "0") < 0) {
      // Downgrades are allowed, but say so in the log.
      console.warn(`[extensions] installing ${id}@${version} over a newer version`);
    }
    let folder = `${id.toLowerCase()}-${version}`;
    if (!this.#inside(join(this.dir, folder))) throw new Error(`refusing to install ${id} outside the extensions directory`);
    if (existsSync(join(this.dir, folder))) {
      if (!this.#remove(join(this.dir, folder))) folder = `${folder}-${randomBytes(2).toString("hex")}`;
    }
    renameSync(staging, join(this.dir, folder));
    const enabled = previous?.enabled ?? true;
    this.#retire(registry, id, folder);
    registry.extensions.push({ id, location: folder, enabled, source, installedAt: Date.now() });
    this.#save(registry);
    return this.#describe(registry.extensions.at(-1)!, true)!;
  }

  /** Drop the registry entry of an id (and its folder, unless it is a development folder). */
  #retire(registry: Registry, id: string, keepFolder?: string): void {
    for (const entry of registry.extensions.filter((candidate) => candidate.id.toLowerCase() === id.toLowerCase())) {
      if (!entry.development && entry.location !== keepFolder && !this.#remove(this.#path(entry))) {
        // Probably locked (a native module the extension host still has loaded): delete on the next start.
        registry.obsolete = [...(registry.obsolete ?? []), entry.location];
      }
    }
    registry.extensions = registry.extensions.filter((candidate) => candidate.id.toLowerCase() !== id.toLowerCase());
  }

  uninstall(id: string): boolean {
    const registry = this.#sync();
    if (!registry.extensions.some((entry) => entry.id.toLowerCase() === id.toLowerCase())) return false;
    this.#retire(registry, id);
    this.#save(registry);
    return true;
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const registry = this.#sync();
    const entry = registry.extensions.find((candidate) => candidate.id.toLowerCase() === id.toLowerCase());
    if (!entry) return false;
    entry.enabled = enabled;
    this.#save(registry);
    return true;
  }

  get(id: string): ExtensionDescription | null {
    return this.list({ icons: true }).find((description) => description.id.toLowerCase() === id.toLowerCase()) ?? null;
  }
}
