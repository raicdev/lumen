import type { ExtensionManifest, MarketplaceDetails, MarketplaceExtension } from "../../shared/extensions.ts";
import { currentTargetPlatform, platformLabel, runsOn } from "./platform.ts";

/**
 * Open VSX (https://open-vsx.org), the vendor-neutral registry of VS Code
 * extensions used by VSCodium and others. (Microsoft's marketplace may only be
 * used by Microsoft products.)
 */

const REGISTRY = (process.env.LUMEN_OPENVSX_URL ?? "https://open-vsx.org").replace(/\/+$/, "");
const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;

type RawExtension = {
  namespace: string;
  name: string;
  version: string;
  displayName?: string;
  description?: string;
  timestamp?: string;
  verified?: boolean;
  averageRating?: number;
  downloadCount?: number;
  namespaceDisplayName?: string;
  files?: { download?: string; icon?: string; readme?: string; changelog?: string; manifest?: string };
  license?: string;
  repository?: string;
  homepage?: string;
  categories?: string[];
  tags?: string[];
  downloads?: Record<string, string>;
  /** The platform of this entry's package (`files.download`), when it is platform specific. */
  targetPlatform?: string;
  /** Every published version → its API URL (also "latest", "pre-release"). */
  allVersions?: Record<string, string>;
  engines?: Record<string, string>;
  error?: string;
};

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`${REGISTRY} answered ${response.status} ${response.statusText}`);
  return (await response.json()) as T;
}

function toEntry(raw: RawExtension): MarketplaceExtension {
  return {
    namespace: raw.namespace,
    name: raw.name,
    version: raw.version,
    displayName: raw.displayName,
    description: raw.description,
    publisher: raw.namespaceDisplayName ?? raw.namespace,
    iconUrl: raw.files?.icon,
    downloadCount: raw.downloadCount,
    averageRating: raw.averageRating,
    verified: raw.verified,
    timestamp: raw.timestamp,
  };
}

export async function searchMarketplace(
  query: string,
  options: { size?: number; sortBy?: "relevance" | "downloadCount" | "averageRating" | "timestamp" } = {},
): Promise<{ extensions: MarketplaceExtension[]; total: number }> {
  const params = new URLSearchParams({
    query,
    size: String(options.size ?? 30),
    sortBy: options.sortBy ?? (query ? "relevance" : "downloadCount"),
    sortOrder: "desc",
  });
  const result = await getJson<{ extensions?: RawExtension[]; totalSize?: number }>(`${REGISTRY}/api/-/search?${params}`);
  return { extensions: (result.extensions ?? []).map(toEntry), total: result.totalSize ?? 0 };
}

/** How many older versions to look through for one built for this platform. */
const OLDER_VERSIONS_TRIED = 10;

/** The package of a version for this platform: its own build, a universal one, or none. */
function downloadFor(detail: RawExtension, target: string): string | undefined {
  const downloads = detail.downloads ?? {};
  if (downloads[target] ?? downloads.universal) return downloads[target] ?? downloads.universal;
  // Published per platform, but not for this one: another platform's package would lack its binaries.
  if (Object.keys(downloads).length) return undefined;
  return runsOn(detail.targetPlatform, target) ? detail.files?.download : undefined;
}

/**
 * The .vsix to install for this platform. When the requested (latest) version
 * has no build for it, the newest of the last few versions that has one.
 */
async function resolveDownload(namespace: string, name: string, version: string | undefined, target: string): Promise<{ url: string; version: string }> {
  const path = [namespace, name, version]
    .filter(Boolean)
    .map((part) => encodeURIComponent(part!))
    .join("/");
  const detail = await getJson<RawExtension>(`${REGISTRY}/api/${path}`);
  if (detail.error) throw new Error(detail.error);
  const url = downloadFor(detail, target);
  if (url) return { url, version: detail.version };
  if (!version) {
    const older = Object.keys(detail.allVersions ?? {})
      .filter((candidate) => /^\d/.test(candidate) && candidate !== detail.version)
      .slice(0, OLDER_VERSIONS_TRIED);
    for (const candidate of older) {
      const previous = await getJson<RawExtension>(
        `${REGISTRY}/api/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/${encodeURIComponent(candidate)}`,
      ).catch(() => null);
      const previousUrl = previous && !previous.error ? downloadFor(previous, target) : undefined;
      if (previousUrl) return { url: previousUrl, version: previous!.version };
    }
  }
  const available = Object.keys(detail.downloads ?? {}).map(platformLabel);
  throw new Error(
    `${namespace}.${name} ${detail.version} has no build for ${platformLabel(target)} on Open VSX` +
      (available.length ? ` (published for ${available.join(", ")}).` : "."),
  );
}

/** Download the .vsix of an extension for this platform (never another platform's build). */
export async function downloadFromMarketplace(namespace: string, name: string, version?: string): Promise<{ vsix: Buffer; version: string }> {
  const { url, version: resolved } = await resolveDownload(namespace, name, version, currentTargetPlatform());
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`download failed: ${response.status} ${response.statusText}`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_PACKAGE_BYTES) throw new Error("the package is too large");
  const vsix = Buffer.from(await response.arrayBuffer());
  if (vsix.length > MAX_PACKAGE_BYTES) throw new Error("the package is too large");
  return { vsix, version: resolved };
}

/** README and listing details of a version (the latest when omitted). */
export async function marketplaceDetails(namespace: string, name: string, version?: string): Promise<MarketplaceDetails> {
  const path = [namespace, name, version]
    .filter(Boolean)
    .map((part) => encodeURIComponent(part!))
    .join("/");
  const detail = await getJson<RawExtension>(`${REGISTRY}/api/${path}`);
  if (detail.error) throw new Error(detail.error);
  const text = async (url: string | undefined): Promise<string | null> => {
    if (!url) return null;
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
    return response?.ok ? response.text() : null;
  };
  const [readme, changelog, manifest] = await Promise.all([text(detail.files?.readme), text(detail.files?.changelog), text(detail.files?.manifest)]);
  let parsed: ExtensionManifest | undefined;
  try {
    parsed = manifest ? (JSON.parse(manifest) as ExtensionManifest) : undefined;
  } catch {
    /* no Features tab data */
  }
  return {
    readme,
    changelog,
    manifest: parsed,
    license: detail.license,
    repository: detail.repository,
    homepage: detail.homepage,
    categories: detail.categories,
    tags: detail.tags,
    timestamp: detail.timestamp,
  };
}

/** Latest published version (update checks). */
export async function latestVersion(namespace: string, name: string): Promise<string | null> {
  try {
    const detail = await getJson<RawExtension>(`${REGISTRY}/api/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`);
    return detail.version ?? null;
  } catch {
    return null;
  }
}
