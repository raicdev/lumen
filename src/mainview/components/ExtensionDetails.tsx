import { Check, ExternalLink, LoaderCircle, X } from "lucide-react";
import { ModalEditorTitleActions } from "../features/menus-walkthroughs/MenuActions";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  CompatReport,
  ExtensionDescription,
  ExtensionManifest,
  MarketplaceCompat,
  MarketplaceDetails,
  MarketplaceExtension,
  SupportLevel,
} from "../../shared/extensions";
import { renderMarkdown } from "../lib/markdown";
import { api } from "../lib/rpc";
import { COMPAT_GRADES, compatClass, compatGrade } from "../lib/compat";
import { normalizeKeybinding } from "../lib/extensions";
import { t } from "../lib/i18n";
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
    return <div className="ext-details-empty">{t("This is a Lumen extension: it is written against the lumen API and needs no conversion.")}</div>;
  }
  if (!report) return <div className="ext-details-empty">{t("No compatibility report was recorded for this extension.")}</div>;
  const order: SupportLevel[] = ["unsupported", "partial", "supported"];
  const apis = [...report.apis].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.name.localeCompare(b.name));
  const grade = COMPAT_GRADES[compatGrade(report)];
  return (
    <div className="ext-compat">
      <div className={`ext-compat-summary ${compatClass(report)}`}>
        <strong>{t(grade.label)}</strong>
        <span>
          {t(grade.text)}
          {report.coverage !== undefined && report.level !== "full" && ` ${t("{0}% of the APIs and contribution points it uses work.", report.coverage)}`}
        </span>
      </div>
      <p className="ext-compat-note">{note}</p>
      {report.warnings.length > 0 && (
        <ul className="ext-compat-warnings">
          {report.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
      <h4>{t("API usage")}</h4>
      {apis.length ? (
        <table className="ext-table">
          <thead>
            <tr>
              <th>API</th>
              <th>{t("Uses")}</th>
              <th>{t("Status")}</th>
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
                  <span className={`ext-status ${entry.status}`}>{t(STATUS_LABEL[entry.status])}</span>
                  {entry.note && <span className="ext-status-note"> — {entry.note}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="ext-details-empty">{t("No use of the extension API was found in the code.")}</div>
      )}
      {report.contributions.length > 0 && (
        <>
          <h4>{t("Contribution points")}</h4>
          <table className="ext-table">
            <tbody>
              {report.contributions.map((entry) => (
                <tr key={entry.name}>
                  <td>
                    <code>{entry.name}</code>
                  </td>
                  <td>
                    <span className={`ext-status ${entry.status}`}>{t(STATUS_LABEL[entry.status])}</span>
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
    const raw = binding
      ? navigator.platform.startsWith("Mac")
        ? (binding.mac ?? binding.key)
        : navigator.platform.startsWith("Win")
          ? (binding.win ?? binding.key)
          : (binding.linux ?? binding.key)
      : undefined;
    return raw ? normalizeKeybinding(raw) : "";
  };
  if (!commands.length && !settings.length && !languages.length && !snippets.length && !keybindings.length) {
    return <div className="ext-details-empty">{t("This extension contributes no commands, settings, languages or snippets.")}</div>;
  }
  return (
    <div className="ext-features">
      {commands.length > 0 && (
        <>
          <h4>{t("Commands ({0})", commands.length)}</h4>
          <table className="ext-table">
            <thead>
              <tr>
                <th>{t("Title")}</th>
                <th>ID</th>
                <th>{t("Keybinding")}</th>
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
          <h4>{t("Settings ({0})", settings.length)}</h4>
          <table className="ext-table">
            <thead>
              <tr>
                <th>{t("Setting")}</th>
                <th>{t("Default")}</th>
                <th>{t("Description")}</th>
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
          <h4>{t("Languages ({0})", languages.length)}</h4>
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
          <h4>{t("Snippets")}</h4>
          <table className="ext-table">
            <tbody>
              {snippets.map((snippet) => (
                <tr key={`${snippet.language}:${snippet.path}`}>
                  <td>{snippet.language ?? t("all languages")}</td>
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
          <h4>{t("Activation events")}</h4>
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
    marketplace?.downloadCount ? { label: t("Downloads"), value: marketplace.downloadCount.toLocaleString() } : null,
    marketplace?.averageRating ? { label: t("Rating"), value: `${marketplace.averageRating.toFixed(1)} / 5` } : null,
    updated ? { label: t("Last updated"), value: new Date(updated).toLocaleDateString() } : null,
    listing?.license ? { label: t("License"), value: listing.license } : null,
    listing?.categories?.length ? { label: t("Categories"), value: listing.categories.join(", ") } : null,
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
      <div className="ext-details-empty ext-details-loading">
        <LoaderCircle size={13} className="codicon spin" /> {t("Loading…")}
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
      .request.extensionsMarketplaceCompat({
        namespace: marketplace.namespace,
        name: marketplace.name,
        version: marketplace.version,
        mode: refresh ? "refresh" : undefined,
      })
      .then(setResult)
      .catch((error: unknown) => setResult({ error: error instanceof Error ? error.message : String(error) }));
  };

  if (result === "loading") {
    return (
      <div className="ext-details-empty ext-details-loading">
        <LoaderCircle size={13} className="codicon spin" /> {t("Loading…")}
      </div>
    );
  }

  if (result === null || (typeof result === "object" && result.error)) {
    return (
      <div className="ext-details-empty">
        {typeof result === "object" && result?.error && <p className="ext-compat-error">{t("Could not check the compatibility: {0}", result.error)}</p>}
        <p className="muted">
          {t("Downloads the package of v{0} from Open VSX and analyzes which APIs and contribution points it uses. Nothing is installed.", marketplace.version)}
        </p>
        <button type="button" className="ext-install" onClick={() => check()}>
          {result ? t("Try Again") : t("Check Compatibility")}
        </button>
      </div>
    );
  }
  if (result === "checking") {
    return (
      <div className="ext-details-empty ext-details-loading">
        <LoaderCircle size={13} className="codicon spin" /> {t("Downloading and analyzing the package…")}
      </div>
    );
  }
  const report = result.report;
  return (
    <>
      <div className="ext-compat-checked">
        <span>
          {result.cached ? t("Cached result") : t("Checked")}
          {result.analyzedAt ? ` · ${new Date(result.analyzedAt).toLocaleString()}` : ""}
        </span>
        <button type="button" className="ext-link" onClick={() => check(true)}>
          {t("Check Again")}
        </button>
      </div>
      <CompatibilityView
        kind={result.kind ?? "vscode"}
        report={report}
        note={
          report
            ? result.vscodeEngine
              ? t(
                  'Analyzed from the Open VSX package (not installed), engine {0}: installing would rewrite {1} import(s) of "vscode" to "lumen" in {2} of {3} script(s).',
                  result.vscodeEngine,
                  report.rewrittenImports,
                  report.filesRewritten,
                  report.filesScanned,
                )
              : t(
                  'Analyzed from the Open VSX package (not installed): installing would rewrite {0} import(s) of "vscode" to "lumen" in {1} of {2} script(s).',
                  report.rewrittenImports,
                  report.filesRewritten,
                  report.filesScanned,
                )
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
    // Keyed on what identifies the extension: the objects are rebuilt whenever the lists refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    repository ? { label: t("Repository"), url: repository.replace(/^git\+/, "").replace(/\.git$/, "") } : null,
    homepage ? { label: t("Homepage"), url: homepage } : null,
  ].filter((link): link is { label: string; url: string } => !!link && /^https?:\/\//.test(link.url));
  const tabs: { id: Tab; label: string }[] = [
    { id: "details", label: t("Details") },
    { id: "features", label: t("Features") },
    ...(!installed || installed.kind === "vscode" ? ([{ id: "compatibility", label: t("Compatibility") }] as const) : []),
    { id: "changelog", label: t("Changelog") },
    ...(installed ? ([{ id: "runtime", label: t("Runtime Status") }] as const) : []),
  ];

  return (
    <div className="modal-overlay settings-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="settings-editor ext-details" role="dialog" aria-label={t("Extension: {0}", name)}>
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
                  <span className="ext-verified" title={t("Verified publisher")}>
                    <Check size={14} strokeWidth={3} aria-label={t("Verified publisher")} />
                  </span>
                )}
              </span>
              <code>{id}</code>
              {installed && <CompatBadge extension={installed} />}
              {installed?.development && <span className="ext-badge">{t("Development")}</span>}
              {installed && !installed.enabled && <span className="ext-badge">{t("Disabled")}</span>}
            </div>
            <p className="ext-details-description">{description}</p>
            <div className="ext-details-actions">
              {isBusy ? (
                <span className="ext-installing">
                  <LoaderCircle size={13} className="codicon spin" /> {t("Installing…")}
                </span>
              ) : (
                <>
                  {(!installed || update) && marketplace && (
                    <button type="button" className="ext-install" onClick={() => onInstall(target)}>
                      {update ? t("Update to v{0}", marketplace.version) : t("Install")}
                    </button>
                  )}
                  {installed && (
                    <>
                      <button type="button" className="modal-btn default" onClick={() => onAction(installed.enabled ? "disable" : "enable", installed)}>
                        {installed.enabled ? t("Disable") : t("Enable")}
                      </button>
                      <button type="button" className="modal-btn danger" onClick={() => onAction("uninstall", installed)}>
                        {t("Uninstall")}
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
          <button type="button" className="icon-btn ext-details-close" title={t("Close (Esc)")} onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="ext-details-tabs" role="tablist">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              className={`panel-tab${tab === entry.id ? " active" : ""}`}
              onClick={() => setTab(entry.id)}
            >
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
                    t("This extension has no README.")
                  ) : (
                    <>
                      <p>{listing?.error ? t("Could not load the README from Open VSX: {0}", listing.error) : marketplace?.description}</p>
                      <p className="muted">
                        {t(
                          "Installing downloads the package from Open VSX. VS Code extensions are converted to Lumen extensions by the transpiler; the Compatibility tab can check what works first.",
                        )}
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
              <div className="ext-details-empty">{t("Could not load the package manifest from Open VSX.")}</div>
            ) : (
              <div className="ext-details-empty ext-details-loading">
                <LoaderCircle size={13} className="codicon spin" /> {t("Loading…")}
              </div>
            ))}
          {tab === "compatibility" &&
            (installed ? (
              <CompatibilityView
                kind={installed.kind}
                report={installed.compat}
                note={
                  installed.development
                    ? t(
                        'Loaded from a development folder: the code runs unchanged through Lumen\'s compatibility layer (require("vscode") resolves to the Lumen API).',
                      )
                    : installed.compat
                      ? installed.manifest.lumen?.vscodeEngine
                        ? t(
                            'Transpiled from a VS Code extension (engine {0}): {1} import(s) of "vscode" rewritten to "lumen" in {2} of {3} script(s).',
                            installed.manifest.lumen.vscodeEngine,
                            installed.compat.rewrittenImports,
                            installed.compat.filesRewritten,
                            installed.compat.filesScanned,
                          )
                        : t(
                            'Transpiled from a VS Code extension: {0} import(s) of "vscode" rewritten to "lumen" in {1} of {2} script(s).',
                            installed.compat.rewrittenImports,
                            installed.compat.filesRewritten,
                            installed.compat.filesScanned,
                          )
                      : ""
                }
              />
            ) : (
              marketplace && <MarketplaceCompatView marketplace={marketplace} />
            ))}
          {tab === "changelog" && <MarkdownDoc source={changelog} empty={t("This extension has no changelog.")} />}
          {tab === "runtime" && installed && (
            <div className="ext-runtime">
              <table className="ext-table">
                <tbody>
                  <tr>
                    <td>{t("State")}</td>
                    <td>
                      {!installed.enabled
                        ? t("Disabled")
                        : runtime?.error
                          ? t("Activation failed")
                          : runtime
                            ? t("Activated")
                            : t("Not activated yet (waiting for its activation events)")}
                    </td>
                  </tr>
                  {runtime && (
                    <tr>
                      <td>{t("Activation time")}</td>
                      <td>{runtime.ms} ms</td>
                    </tr>
                  )}
                  {runtime?.error && (
                    <tr>
                      <td>{t("Error")}</td>
                      <td className="ext-runtime-error">{runtime.error}</td>
                    </tr>
                  )}
                  <tr>
                    <td>{t("Kind")}</td>
                    <td>{installed.kind === "vscode" ? t("VS Code extension (transpiled / compatibility layer)") : t("Lumen extension")}</td>
                  </tr>
                  <tr>
                    <td>{t("Entry point")}</td>
                    <td>
                      <code>{installed.manifest.main ?? t("(declarative — no code)")}</code>
                    </td>
                  </tr>
                  <tr>
                    <td>{t("Location")}</td>
                    <td>
                      <code>{installed.location}</code>
                    </td>
                  </tr>
                </tbody>
              </table>
              <p className="muted">{t("The extension host log is in the Output panel (“Extension Host” channel).")}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
