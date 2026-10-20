import { Check, ExternalLink, LoaderCircle, X } from "lucide-react";
import { ModalEditorTitleActions } from "../features/menus-walkthroughs/MenuActions";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { CompatReport, ExtensionDescription, ExtensionManifest, MarketplaceCompat, MarketplaceDetails, MarketplaceExtension, SupportLevel } from "../../shared/extensions";
import { renderMarkdown } from "../lib/markdown";
import { api } from "../lib/rpc";
import { normalizeKeybinding } from "../lib/extensions";
import { CompatBadge, ExtensionIcon, type ExtensionAction, type ExtensionTarget } from "./ExtensionsView";

type Tab = "details" | "features" | "compatibility" | "changelog" | "runtime";

type Props = {
  target: ExtensionTarget | null;
  activation: Map<string, { ms: number; error?: string }>;
  busy: Set<string>;
  onClose: () => void;
  onInstall: (target: ExtensionTarget) => void;
  onAction: (action: ExtensionAction, extension: ExtensionDescription) => void;
};

const STATUS_LABEL: Record<SupportLevel, string> = { supported: "Supported", partial: "Partial", unsupported: "Not supported" };

/** Open links of rendered Markdown in the browser. */
function onLinkClick(e: React.MouseEvent) {
  const link = (e.target as HTMLElement).closest<HTMLElement>("[data-href]");
  if (!link) return;
  e.preventDefault();
  void api().request.openExternal({ url: link.dataset.href! });
}

/** `note` says where the report comes from (installed, development folder, or a package analyzed before install). */
function CompatibilityView({ kind, report, note }: { kind: "lumen" | "vscode"; report: CompatReport | undefined; note: string }) {
  if (kind !== "vscode") {
    return <div className="ext-details-empty">This is a Lumen extension: it is written against the <code>lumen</code> API and needs no conversion.</div>;
  }
  if (!report) return <div className="ext-details-empty">No compatibility report was recorded for this extension.</div>;
  const order: SupportLevel[] = ["unsupported", "partial", "supported"];
  const apis = [...report.apis].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.name.localeCompare(b.name));
  const summary =
    report.level === "full"
      ? "Everything this extension uses is available in Lumen."
      : report.level === "partial"
        ? "The extension runs, but some of the features it uses are missing or limited in Lumen."
        : "Core parts of this extension (views, webviews, debugging, …) are not available in Lumen; it may do little or nothing.";
  return (
    <div className="ext-compat">
      <div className={`ext-compat-summary compat-${report.level}`}>
        <strong>{report.level === "full" ? "Compatible" : report.level === "partial" ? "Partially compatible" : "Limited"}</strong>
        <span>{summary}</span>
      </div>
      <p className="ext-compat-note">{note}</p>
      {report.warnings.length > 0 && (
        <ul className="ext-compat-warnings">
          {report.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
      <h4>API usage</h4>
      {apis.length ? (
        <table className="ext-table">
          <thead>
            <tr>
              <th>API</th>
              <th>Uses</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {apis.map((entry) => (
              <tr key={entry.name}>
                <td>
                  <code>{entry.name}</code>
                </td>
                <td>{entry.count}</td>
                <td>
                  <span className={`ext-status ${entry.status}`}>{STATUS_LABEL[entry.status]}</span>
                  {entry.note && <span className="ext-status-note"> — {entry.note}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="ext-details-empty">No use of the extension API was found in the code.</div>
      )}
      {report.contributions.length > 0 && (
        <>
          <h4>Contribution points</h4>
          <table className="ext-table">
            <tbody>
              {report.contributions.map((entry) => (
                <tr key={entry.name}>
                  <td>
                    <code>{entry.name}</code>
                  </td>
                  <td>
                    <span className={`ext-status ${entry.status}`}>{STATUS_LABEL[entry.status]}</span>
                    {entry.note && <span className="ext-status-note"> — {entry.note}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function FeaturesView({ manifest }: { manifest: ExtensionManifest }) {
  const contributes = manifest.contributes ?? {};
  const commands = [contributes.commands ?? []].flat();
  const keybindings = [contributes.keybindings ?? []].flat();
  const settings = [contributes.configuration ?? []].flat().flatMap((section) => Object.entries(section.properties ?? {}));
  const languages = contributes.languages ?? [];
  const snippets = contributes.snippets ?? [];
  const title = (value: string | { value: string } | undefined) => (typeof value === "string" ? value : (value?.value ?? ""));
  const keyOf = (command: string) => {
    const binding = keybindings.find((entry) => entry.command === command);
    const raw = binding ? (navigator.platform.startsWith("Mac") ? (binding.mac ?? binding.key) : navigator.platform.startsWith("Win") ? (binding.win ?? binding.key) : (binding.linux ?? binding.key)) : undefined;
    return raw ? normalizeKeybinding(raw) : "";
  };
  if (!commands.length && !settings.length && !languages.length && !snippets.length && !keybindings.length) {
    return <div className="ext-details-empty">This extension contributes no commands, settings, languages or snippets.</div>;
  }
  return (
    <div className="ext-features">
      {commands.length > 0 && (
        <>
          <h4>Commands ({commands.length})</h4>
          <table className="ext-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>ID</th>
                <th>Keybinding</th>
              </tr>
            </thead>
            <tbody>
              {commands.map((command) => (
                <tr key={command.command}>
                  <td>{[title(command.category), title(command.title)].filter(Boolean).join(": ")}</td>
                  <td>
                    <code>{command.command}</code>
                  </td>
                  <td>{keyOf(command.command) && <kbd>{keyOf(command.command)}</kbd>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {settings.length > 0 && (
        <>
          <h4>Settings ({settings.length})</h4>
          <table className="ext-table">
            <thead>
              <tr>
                <th>Setting</th>
                <th>Default</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {settings.map(([key, property]) => (
                <tr key={key}>
                  <td>
                    <code>{key}</code>
                  </td>
                  <td>
                    <code>{JSON.stringify(property.default ?? null)}</code>
                  </td>
                  <td>{property.description ?? property.markdownDescription ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {languages.length > 0 && (
        <>
          <h4>Languages ({languages.length})</h4>
          <table className="ext-table">
            <tbody>
              {languages.map((language) => (
                <tr key={language.id}>
                  <td>{language.aliases?.[0] ?? language.id}</td>
                  <td>
                    <code>{language.id}</code>
                  </td>
                  <td>{[...(language.extensions ?? []), ...(language.filenames ?? [])].join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {snippets.length > 0 && (
        <>
          <h4>Snippets</h4>
          <table className="ext-table">
            <tbody>
              {snippets.map((snippet) => (
                <tr key={`${snippet.language}:${snippet.path}`}>
                  <td>{snippet.language ?? "all languages"}</td>
                  <td>
                    <code>{snippet.path}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {(manifest.activationEvents?.length ?? 0) > 0 && (
        <>
          <h4>Activation events</h4>
          <div className="ext-chips">
            {manifest.activationEvents!.map((event) => (
              <code key={event}>{event}</code>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Open VSX facts about an extension that is not installed yet. */
function ListingInfo({ listing, marketplace }: { listing: MarketplaceDetails | null; marketplace?: MarketplaceExtension }) {
  const updated = listing?.timestamp ?? marketplace?.timestamp;
  const facts = [
    marketplace?.downloadCount ? { label: "Downloads", value: marketplace.downloadCount.toLocaleString() } : null,
    marketplace?.averageRating ? { label: "Rating", value: `${marketplace.averageRating.toFixed(1)} / 5` } : null,
    updated ? { label: "Last updated", value: new Date(updated).toLocaleDateString() } : null,
    listing?.license ? { label: "License", value: listing.license } : null,
    listing?.categories?.length ? { label: "Categories", value: listing.categories.join(", ") } : null,
  ].filter((fact): fact is { label: string; value: string } => !!fact);
  if (!facts.length && !listing?.tags?.length) return null;
  return (
    <div className="ext-listing-info">
      {facts.map((fact) => (
        <div key={fact.label} className="ext-listing-fact">
          <span className="ext-listing-label">{fact.label}</span>
          <span>{fact.value}</span>
        </div>
      ))}
      {!!listing?.tags?.length && (
        <div className="ext-listing-tags">
          {listing.tags.slice(0, 12).map((tag) => (
            <span key={tag} className="ext-badge">
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Rendered Markdown of a README / CHANGELOG, with loading and empty states. */
function MarkdownDoc({ source, empty }: { source: string | null | undefined; empty: ReactNode }) {
  const html = useMemo(() => (source ? renderMarkdown(source) : ""), [source]);
  if (source === undefined) {
    return (
      <div className="ext-details-empty">
        <LoaderCircle size={13} className="codicon spin" /> Loading…
      </div>
    );
  }
  if (!source) return <div className="ext-details-empty">{empty}</div>;
  return <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Compatibility of an extension that is not installed: analyzed on request (the package is downloaded for it). */
function MarketplaceCompatView({ marketplace }: { marketplace: MarketplaceExtension }) {
  // "loading": looking for a cached result; null: nothing checked yet.
  const [result, setResult] = useState<MarketplaceCompat | "loading" | "checking" | null>("loading");
  const key = `${marketplace.namespace}.${marketplace.name}@${marketplace.version}`;
  useEffect(() => {
    setResult("loading");
    let cancelled = false;
    void api()
      .request.extensionsMarketplaceCompat({ namespace: marketplace.namespace, name: marketplace.name, version: marketplace.version, mode: "cached" })
      .then((cached) => !cancelled && setResult(cached.kind ? cached : null))
      .catch(() => !cancelled && setResult(null));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const check = (refresh = false) => {
    setResult("checking");
    void api()
      .request.extensionsMarketplaceCompat({ namespace: marketplace.namespace, name: marketplace.name, version: marketplace.version, mode: refresh ? "refresh" : undefined })
      .then(setResult)
      .catch((error: unknown) => setResult({ error: error instanceof Error ? error.message : String(error) }));
  };

  if (result === "loading") {
    return (
      <div className="ext-details-empty">
        <LoaderCircle size={13} className="codicon spin" /> Loading…
      </div>
    );
  }

  if (result === null || (typeof result === "object" && result.error)) {
    return (
      <div className="ext-details-empty">
        {typeof result === "object" && result?.error && <p className="ext-compat-error">Could not check the compatibility: {result.error}</p>}
        <p className="muted">Downloads the package of v{marketplace.version} from Open VSX and analyzes which APIs and contribution points it uses. Nothing is installed.</p>
        <button type="button" className="ext-install" onClick={() => check()}>
          {result ? "Try Again" : "Check Compatibility"}
        </button>
      </div>
    );
  }
  if (result === "checking") {
    return (
      <div className="ext-details-empty">
        <LoaderCircle size={13} className="codicon spin" /> Downloading and analyzing the package…
      </div>
    );
  }
  const report = result.report;
  return (
    <>
      <div className="ext-compat-checked">
        <span>
          {result.cached ? "Cached result" : "Checked"}
          {result.analyzedAt ? ` · ${new Date(result.analyzedAt).toLocaleString()}` : ""}
        </span>
        <button type="button" className="ext-link" onClick={() => check(true)}>
          Check Again
        </button>
      </div>
      <CompatibilityView
        kind={result.kind ?? "vscode"}
        report={report}
        note={
          report
            ? `Analyzed from the Open VSX package (not installed)${result.vscodeEngine ? `, engine ${result.vscodeEngine}` : ""}: installing would rewrite ${report.rewrittenImports} import(s) of "vscode" to "lumen" in ${report.filesRewritten} of ${report.filesScanned} script(s).`
            : ""
        }
      />
    </>
  );
}

export function ExtensionDetails({ target, activation, busy, onClose, onInstall, onAction }: Props) {
  const [tab, setTab] = useState<Tab>("details");
  const [readme, setReadme] = useState<string | null | undefined>(undefined);
  /** Open VSX listing details, for an extension that is not installed. */
  const [listing, setListing] = useState<MarketplaceDetails | null>(null);
  const [changelog, setChangelog] = useState<string | null | undefined>(undefined);
  const installed = target?.installed;
  const marketplace = target?.marketplace;

  useEffect(() => {
    setTab("details");
    setReadme(undefined);
    setChangelog(undefined);
    setListing(null);
    if (!installed && !marketplace) return;
    let cancelled = false;
    if (installed) {
      void api()
        .request.extensionsReadme({ id: installed.id })
        .then((result) => !cancelled && setReadme(result.markdown))
        .catch(() => !cancelled && setReadme(null));
      void api()
        .request.extensionsChangelog({ id: installed.id })
        .then((result) => !cancelled && setChangelog(result.markdown))
        .catch(() => !cancelled && setChangelog(null));
    } else if (marketplace) {
      void api()
        .request.extensionsMarketplaceDetails({ namespace: marketplace.namespace, name: marketplace.name, version: marketplace.version })
        .then((result) => {
          if (cancelled) return;
          setListing(result);
          setReadme(result.readme);
          setChangelog(result.changelog ?? null);
        })
        .catch(() => {
          if (cancelled) return;
          setReadme(null);
          setChangelog(null);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [installed?.id, installed?.manifest.version, marketplace?.namespace, marketplace?.name, marketplace?.version]);

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [target, onClose]);

  if (!target || (!installed && !marketplace)) return null;

  const manifest = installed?.manifest;
  const name = manifest?.displayName ?? manifest?.name ?? marketplace?.displayName ?? marketplace?.name ?? "";
  const id = installed?.id ?? `${marketplace!.namespace}.${marketplace!.name}`;
  const version = manifest?.version ?? marketplace?.version;
  const description = manifest?.description ?? marketplace?.description;
  const publisher = manifest?.publisher ?? marketplace?.publisher;
  const runtime = installed ? activation.get(installed.id) : undefined;
  const isBusy = busy.has(id.toLowerCase());
  const update = installed && marketplace && !installed.development && installed.manifest.version !== marketplace.version;
  const repository = (typeof manifest?.repository === "string" ? manifest.repository : manifest?.repository?.url) ?? listing?.repository;
  const homepage = manifest?.homepage ?? listing?.homepage;
  const links = [
    marketplace || installed?.source?.type === "openvsx" ? { label: "Open VSX", url: `https://open-vsx.org/extension/${id.replace(".", "/")}` } : null,
    repository ? { label: "Repository", url: repository.replace(/^git\+/, "").replace(/\.git$/, "") } : null,
    homepage ? { label: "Homepage", url: homepage } : null,
  ].filter((link): link is { label: string; url: string } => !!link && /^https?:\/\//.test(link.url));
  const tabs: { id: Tab; label: string }[] = [
    { id: "details", label: "Details" },
    { id: "features", label: "Features" },
    ...(!installed || installed.kind === "vscode" ? ([{ id: "compatibility", label: "Compatibility" }] as const) : []),
    { id: "changelog", label: "Changelog" },
    ...(installed ? ([{ id: "runtime", label: "Runtime Status" }] as const) : []),
  ];

  return (
    <div className="modal-overlay settings-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="settings-editor ext-details" role="dialog" aria-label={`Extension: ${name}`}>
        <div className="ext-details-header">
          <ExtensionIcon url={installed?.iconUrl ?? marketplace?.iconUrl} name={name} size={72} />
          <div className="ext-details-heading">
            <h2>
              {name} <span className="ext-version">v{version}</span>
            </h2>
            <div className="ext-details-id">
              <span className="ext-details-publisher">
                {publisher}
                {marketplace?.verified && (
                  <span className="ext-verified" title="Verified publisher">
                    <Check size={14} strokeWidth={3} aria-label="Verified publisher" />
                  </span>
                )}
              </span>
              <code>{id}</code>
              {installed && <CompatBadge extension={installed} />}
              {installed?.development && <span className="ext-badge">Development</span>}
              {installed && !installed.enabled && <span className="ext-badge">Disabled</span>}
            </div>
            <p className="ext-details-description">{description}</p>
            <div className="ext-details-actions">
              {isBusy ? (
                <span className="ext-installing">
                  <LoaderCircle size={13} className="codicon spin" /> Installing…
                </span>
              ) : (
                <>
                  {(!installed || update) && marketplace && (
                    <button type="button" className="ext-install" onClick={() => onInstall(target)}>
                      {update ? `Update to v${marketplace.version}` : "Install"}
                    </button>
                  )}
                  {installed && (
                    <>
                      <button type="button" className="modal-btn default" onClick={() => onAction(installed.enabled ? "disable" : "enable", installed)}>
                        {installed.enabled ? "Disable" : "Enable"}
                      </button>
                      <button type="button" className="modal-btn danger" onClick={() => onAction("uninstall", installed)}>
                        Uninstall
                      </button>
                    </>
                  )}
                </>
              )}
              {links.map((link) => (
                <button key={link.label} type="button" className="ext-link" onClick={() => void api().request.openExternal({ url: link.url })}>
                  {link.label} <ExternalLink size={12} />
                </button>
              ))}
            </div>
          </div>
          <ModalEditorTitleActions activeEditor="workbench.editor.extension" />
          <button type="button" className="icon-btn ext-details-close" title="Close (Esc)" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="ext-details-tabs" role="tablist">
          {tabs.map((entry) => (
            <button key={entry.id} type="button" role="tab" aria-selected={tab === entry.id} className={`panel-tab${tab === entry.id ? " active" : ""}`} onClick={() => setTab(entry.id)}>
              {entry.label}
            </button>
          ))}
        </div>
        <div className="settings-body ext-details-body" onClick={onLinkClick}>
          {tab === "details" && (
            <>
              {!installed && <ListingInfo listing={listing} marketplace={marketplace} />}
              <MarkdownDoc
                source={readme}
                empty={
                  installed ? (
                    "This extension has no README."
                  ) : (
                    <>
                      <p>{listing?.error ? `Could not load the README from Open VSX: ${listing.error}` : marketplace?.description}</p>
                      <p className="muted">
                        Installing downloads the package from Open VSX. VS Code extensions are converted to Lumen extensions by the transpiler; the Compatibility tab can check what works first.
                      </p>
                    </>
                  )
                }
              />
            </>
          )}
          {tab === "features" &&
            (installed ? (
              <FeaturesView manifest={installed.manifest} />
            ) : listing?.manifest ? (
              <FeaturesView manifest={listing.manifest} />
            ) : listing ? (
              <div className="ext-details-empty">Could not load the package manifest from Open VSX.</div>
            ) : (
              <div className="ext-details-empty">
                <LoaderCircle size={13} className="codicon spin" /> Loading…
              </div>
            ))}
          {tab === "compatibility" &&
            (installed ? (
              <CompatibilityView
                kind={installed.kind}
                report={installed.compat}
                note={
                  installed.development
                    ? "Loaded from a development folder: the code runs unchanged through Lumen's compatibility layer (require(\"vscode\") resolves to the Lumen API)."
                    : installed.compat
                      ? `Transpiled from a VS Code extension${installed.manifest.lumen?.vscodeEngine ? ` (engine ${installed.manifest.lumen.vscodeEngine})` : ""}: ${installed.compat.rewrittenImports} import(s) of "vscode" rewritten to "lumen" in ${installed.compat.filesRewritten} of ${installed.compat.filesScanned} script(s).`
                      : ""
                }
              />
            ) : (
              marketplace && <MarketplaceCompatView marketplace={marketplace} />
            ))}
          {tab === "changelog" && <MarkdownDoc source={changelog} empty="This extension has no changelog." />}
          {tab === "runtime" && installed && (
            <div className="ext-runtime">
              <table className="ext-table">
                <tbody>
                  <tr>
                    <td>State</td>
                    <td>{!installed.enabled ? "Disabled" : runtime?.error ? "Activation failed" : runtime ? "Activated" : "Not activated yet (waiting for its activation events)"}</td>
                  </tr>
                  {runtime && (
                    <tr>
                      <td>Activation time</td>
                      <td>{runtime.ms} ms</td>
                    </tr>
                  )}
                  {runtime?.error && (
                    <tr>
                      <td>Error</td>
                      <td className="ext-runtime-error">{runtime.error}</td>
                    </tr>
                  )}
                  <tr>
                    <td>Kind</td>
                    <td>{installed.kind === "vscode" ? "VS Code extension (transpiled / compatibility layer)" : "Lumen extension"}</td>
                  </tr>
                  <tr>
                    <td>Entry point</td>
                    <td>
                      <code>{installed.manifest.main ?? "(declarative — no code)"}</code>
                    </td>
                  </tr>
                  <tr>
                    <td>Location</td>
                    <td>
                      <code>{installed.location}</code>
                    </td>
                  </tr>
                </tbody>
              </table>
              <p className="muted">The extension host log is in the Output panel (“Extension Host” channel).</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
