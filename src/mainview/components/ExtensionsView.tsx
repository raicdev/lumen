import { Check, ChevronRight, Download, LoaderCircle, Search, Settings, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ExtensionDescription, MarketplaceExtension } from "../../shared/extensions";
import { api } from "../lib/rpc";
import { COMPAT_GRADES, compatClass, compatGrade } from "../lib/compat";
import { showContextMenu } from "../lib/context-menu";
import { contributedMenuItems, showContributedMenu } from "../features/menus-walkthroughs/menus";

export type ExtensionTarget = { installed?: ExtensionDescription; marketplace?: MarketplaceExtension };

export type ExtensionAction = "enable" | "disable" | "uninstall" | "details" | "copy-id" | "reveal";

type Props = {
  visible: boolean;
  installed: ExtensionDescription[];
  activation: Map<string, { ms: number; error?: string }>;
  /** Extension ids being installed / updated. */
  busy: Set<string>;
  focusToken: number;
  onInstall: (entry: MarketplaceExtension) => void;
  onAction: (action: ExtensionAction, extension: ExtensionDescription) => void;
  onShowDetails: (target: ExtensionTarget) => void;
};

const marketplaceId = (entry: MarketplaceExtension) => `${entry.namespace}.${entry.name}`;

function compactNumber(value: number | undefined): string {
  if (!value) return "";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(value);
}

export function ExtensionIcon({ url, name, size = 36 }: { url?: string; name: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (url && !failed) return <img className="ext-icon" src={url} alt="" width={size} height={size} onError={() => setFailed(true)} />;
  return (
    <span className="ext-icon placeholder" style={{ width: size, height: size, fontSize: size * 0.45 }} aria-hidden="true">
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function CompatBadge({ extension }: { extension: ExtensionDescription }) {
  if (extension.kind !== "vscode") return null;
  return (
    <span className={`ext-badge ${compatClass(extension.compat)}`} title="Converted from a VS Code extension by the transpiler — open the details for the compatibility report">
      VS Code · {COMPAT_GRADES[compatGrade(extension.compat)].badge}
    </span>
  );
}

/** The VS Code logo (Simple Icons, CC0). */
function VscodeLogo({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M23.15 2.587 18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z" />
    </svg>
  );
}

/** At most `max` names, then "and N more". */
function nameList(names: string[], max = 5): string {
  return names.length > max ? `${names.slice(0, max).join(", ")} and ${names.length - max} more` : names.join(", ");
}

/**
 * A VS Code extension's compatibility, as a colored VS Code logo next to its
 * name (green: supported; yellow-green, yellow or orange: mostly, half or barely
 * supported; red: limited). Hovering shows what
 * is missing; the details page has the full report.
 */
export function CompatIcon({ extension }: { extension: ExtensionDescription }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  if (extension.kind !== "vscode") return null;
  const report = extension.compat;
  const color = compatClass(report);
  const info = COMPAT_GRADES[compatGrade(report)];
  const unsupportedApis = report?.apis.filter((api) => api.status === "unsupported").map((api) => api.name) ?? [];
  const partialApis = report?.apis.filter((api) => api.status === "partial").map((api) => api.name) ?? [];
  const contributions = report?.contributions.filter((c) => c.status !== "supported").map((c) => (c.status === "partial" ? `${c.name} (partial)` : c.name)) ?? [];

  const card = anchor && (
    <div
      className={`ext-compat-card ${color}`}
      role="tooltip"
      style={{ top: anchor.bottom + 6, left: Math.max(8, Math.min(anchor.left - 8, window.innerWidth - 328)) }}
    >
      <div className="ext-compat-card-title">
        <VscodeLogo size={13} />
        VS Code extension · {info.label}
      </div>
      <p>{report ? info.text : "Not analyzed yet: open the details to check it."}</p>
      {report?.coverage !== undefined && report.level !== "full" && (
        <p>
          <b>Works:</b> {report.coverage}% of the APIs and contribution points it uses
        </p>
      )}
      {unsupportedApis.length > 0 && (
        <p>
          <b>Not available:</b> {nameList(unsupportedApis)}
        </p>
      )}
      {partialApis.length > 0 && (
        <p>
          <b>Partly available:</b> {nameList(partialApis)}
        </p>
      )}
      {contributions.length > 0 && (
        <p>
          <b>Contributions:</b> {nameList(contributions)}
        </p>
      )}
      {report?.warnings.slice(0, 2).map((warning) => (
        <p key={warning} className="ext-compat-card-warning">
          {warning}
        </p>
      ))}
      <p className="ext-compat-card-hint">Open the details for the full compatibility report.</p>
    </div>
  );

  return (
    <span
      className={`ext-compat-icon ${color}`}
      // An empty title keeps the row's tooltip (the extension id) from covering the card.
      title=""
      aria-label={`VS Code extension: ${info.label}`}
      onMouseEnter={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}
      onMouseLeave={() => setAnchor(null)}
    >
      <VscodeLogo size={13} />
      {card && createPortal(card, document.body)}
    </span>
  );
}

function Section({ title, count, children, defaultOpen = true }: { title: string; count?: number; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="ext-section">
      <button type="button" className="scm-section-header" onClick={() => setOpen((v) => !v)}>
        <span className={`chevron${open ? " open" : ""}`}>
          <ChevronRight size={14} />
        </span>
        <span className="scm-section-title">{title}</span>
        {count !== undefined && <span className="badge">{count}</span>}
      </button>
      {open && children}
    </div>
  );
}

export function ExtensionsView(props: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MarketplaceExtension[] | null>(null);
  const [popular, setPopular] = useState<MarketplaceExtension[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchSeq = useRef(0);

  useEffect(() => {
    if (props.focusToken) requestAnimationFrame(() => inputRef.current?.focus());
  }, [props.focusToken]);

  const installedById = useMemo(() => new Map(props.installed.map((extension) => [extension.id.toLowerCase(), extension])), [props.installed]);

  // Newer Open VSX versions of the installed extensions, checked again whenever the installed set changes.
  const [updates, setUpdates] = useState<Map<string, MarketplaceExtension>>(new Map());
  const installedKey = props.installed.map((extension) => `${extension.id}@${extension.manifest.version}`).join(",");
  useEffect(() => {
    if (!props.visible) return;
    let cancelled = false;
    void api()
      .request.extensionsCheckUpdates({})
      .then(({ updates: found }) => {
        if (!cancelled) setUpdates(new Map(found.map((entry) => [marketplaceId(entry).toLowerCase(), entry])));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [props.visible, installedKey]);
  /** The update of an installed extension, when Open VSX has a newer version. */
  const updateFor = (extension: ExtensionDescription) =>
    extension.source?.type === "openvsx" ? updates.get(`${extension.source.namespace}.${extension.source.name}`.toLowerCase()) : undefined;
  const filter = query.trim().toLowerCase();
  const scope = /^@(installed|enabled|disabled|vscode|dev)\b/.exec(filter)?.[1] ?? null;
  const text = filter.replace(/^@\w+\s*/, "");

  // Marketplace search (debounced); the most popular extensions when there is no query.
  useEffect(() => {
    if (!props.visible || scope) return;
    if (!text && popular) {
      setResults(null);
      return;
    }
    const seq = ++searchSeq.current;
    const timer = setTimeout(
      () => {
        setLoading(true);
        setError(null);
        void api()
          .request.extensionsSearch({ query: text, sortBy: text ? "relevance" : "downloadCount" })
          .then((result) => {
            if (seq !== searchSeq.current) return;
            if (result.error) setError(result.error);
            if (text) setResults(result.extensions);
            else setPopular(result.extensions);
          })
          .catch((e: unknown) => seq === searchSeq.current && setError(e instanceof Error ? e.message : String(e)))
          .finally(() => seq === searchSeq.current && setLoading(false));
      },
      text ? 350 : 0,
    );
    return () => clearTimeout(timer);
  }, [text, scope, props.visible, popular]);

  const installedShown = props.installed.filter((extension) => {
    if (scope === "enabled" && !extension.enabled) return false;
    if (scope === "disabled" && extension.enabled) return false;
    if (scope === "vscode" && extension.kind !== "vscode") return false;
    if (scope === "dev" && !extension.development) return false;
    if (!text) return true;
    const haystack = `${extension.id} ${extension.manifest.displayName ?? ""} ${extension.manifest.description ?? ""} ${(extension.manifest.keywords ?? []).join(" ")}`.toLowerCase();
    return text.split(/\s+/).every((word) => haystack.includes(word));
  });
  const marketplace = scope ? [] : ((text ? results : popular) ?? []);

  /** Context keys of extension/context; its commands get the extension id. */
  const extensionLookup = (id: string, extension?: ExtensionDescription) => (key: string) => {
    switch (key) {
      case "extension":
        return id;
      case "extensionStatus":
        return extension ? "installed" : undefined;
      case "isBuiltinExtension":
        return false;
      case "extensionDisabled":
        return extension ? !extension.enabled : undefined;
      case "extensionHasConfiguration":
        return !!extension?.manifest.contributes?.configuration;
      default:
        return undefined;
    }
  };

  const gear = (extension: ExtensionDescription, x: number, y: number) => {
    const contributed = contributedMenuItems("extension/context", extensionLookup(extension.id, extension), [extension.id]);
    const update = updateFor(extension);
    void showContextMenu(x, y, [
      ...(update ? [{ type: "item" as const, label: `Update to ${update.version}`, action: "update", run: () => props.onInstall(update) }, { type: "separator" as const }] : []),
      extension.enabled ? { type: "item", label: "Disable", action: "disable" } : { type: "item", label: "Enable", action: "enable" },
      { type: "item", label: "Uninstall", action: "uninstall", danger: true },
      { type: "separator" },
      { type: "item", label: "Show Details", action: "details" },
      { type: "item", label: "Copy Extension ID", action: "copy-id" },
      { type: "item", label: "Reveal in File Explorer", action: "reveal" },
      ...(contributed.length ? [{ type: "separator" as const }, ...contributed] : []),
    ]).then((action) => {
      if (action) props.onAction(action as ExtensionAction, extension);
    });
  };

  const installedRow = (extension: ExtensionDescription) => {
    const manifest = extension.manifest;
    const name = manifest.displayName ?? manifest.name;
    const runtime = props.activation.get(extension.id);
    const update = updateFor(extension);
    const busy = props.busy.has(extension.id.toLowerCase()) || (update ? props.busy.has(marketplaceId(update).toLowerCase()) : false);
    return (
      <div
        key={extension.id}
        className={`ext-row${extension.enabled ? "" : " disabled"}`}
        onClick={() => props.onShowDetails({ installed: extension })}
        onContextMenu={(e) => {
          e.preventDefault();
          gear(extension, e.clientX, e.clientY);
        }}
        title={extension.id}
      >
        <ExtensionIcon url={extension.iconUrl} name={name} />
        <div className="ext-main">
          <div className="ext-title">
            <CompatIcon extension={extension} />
            <span className="ext-name">{name}</span>
            <span className="ext-version">{manifest.version}</span>
            {runtime?.error && (
              <span className="ext-error" title={`Activation failed: ${runtime.error}`}>
                <TriangleAlert size={13} />
              </span>
            )}
          </div>
          <div className="ext-description">{manifest.description}</div>
          <div className="ext-meta">
            <span className="ext-publisher">{manifest.publisher ?? "unknown"}</span>
            {!extension.enabled && <span className="ext-badge">Disabled</span>}
            {extension.development && <span className="ext-badge">Development</span>}
            {busy ? (
              <span className="ext-installing">
                <LoaderCircle size={12} className="codicon spin" /> Updating…
              </span>
            ) : (
              update && (
                <button
                  type="button"
                  className="ext-install"
                  title={`Update ${manifest.version} → ${update.version}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onInstall(update);
                  }}
                >
                  Update
                </button>
              )
            )}
            <button
              type="button"
              className={`icon-btn ext-gear${update || busy ? " after-action" : ""}`}
              title="Manage"
              onClick={(e) => {
                e.stopPropagation();
                const rect = e.currentTarget.getBoundingClientRect();
                gear(extension, rect.left, rect.bottom + 2);
              }}
            >
              <Settings size={14} />
            </button>
          </div>
        </div>
      </div>
    );
  };

  const marketplaceRow = (entry: MarketplaceExtension) => {
    const id = marketplaceId(entry);
    const installed = installedById.get(id.toLowerCase());
    const busy = props.busy.has(id.toLowerCase());
    const name = entry.displayName ?? entry.name;
    const update = installed && !installed.development && installed.manifest.version !== entry.version;
    return (
      <div
        key={id}
        className="ext-row"
        onClick={() => props.onShowDetails({ marketplace: entry, installed })}
        onContextMenu={(e) => {
          if (installed) {
            e.preventDefault();
            gear(installed, e.clientX, e.clientY);
          } else showContributedMenu(e, "extension/context", extensionLookup(id), [id]);
        }}
        title={id}
      >
        <ExtensionIcon url={entry.iconUrl} name={name} />
        <div className="ext-main">
          <div className="ext-title">
            <span className="ext-name">{name}</span>
            {entry.downloadCount ? (
              <span className="ext-downloads" title={`${entry.downloadCount.toLocaleString()} downloads`}>
                <Download size={11} /> {compactNumber(entry.downloadCount)}
              </span>
            ) : null}
          </div>
          <div className="ext-description">{entry.description}</div>
          <div className="ext-meta">
            <span className="ext-publisher">
              {entry.publisher}
              {entry.verified && (
                <span className="ext-verified" title="Verified publisher">
                  <Check size={12} strokeWidth={3} aria-label="Verified publisher" />
                </span>
              )}
            </span>
            {busy ? (
              <span className="ext-installing">
                <LoaderCircle size={12} className="codicon spin" /> Installing…
              </span>
            ) : installed && !update ? (
              <span className="ext-badge">Installed</span>
            ) : (
              <button
                type="button"
                className="ext-install"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onInstall(entry);
                }}
              >
                {update ? "Update" : "Install"}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="extensions-view">
      <div className="ext-search">
        <Search size={14} className="ext-search-icon" />
        <input
          ref={inputRef}
          type="text"
          spellCheck={false}
          placeholder="Search Extensions in Open VSX"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setQuery("");
          }}
        />
      </div>
      <div className="ext-list">
        <Section title="Installed" count={installedShown.length}>
          {installedShown.length ? (
            installedShown.map(installedRow)
          ) : (
            <div className="ext-empty">{props.installed.length ? "No installed extension matches." : "No extensions installed yet. Search Open VSX above, or use “Install from VSIX…” in the ⋯ menu."}</div>
          )}
        </Section>
        {!scope && (
          <Section title={text ? "Open VSX" : "Popular on Open VSX"} count={marketplace.length || undefined}>
            {loading && !marketplace.length && (
              <div className="ext-empty">
                <LoaderCircle size={13} className="codicon spin" /> Searching…
              </div>
            )}
            {error && <div className="ext-empty error">Could not reach Open VSX: {error}</div>}
            {!loading && !error && text && !marketplace.length && <div className="ext-empty">No extensions found.</div>}
            {marketplace.map(marketplaceRow)}
          </Section>
        )}
      </div>
    </div>
  );
}
