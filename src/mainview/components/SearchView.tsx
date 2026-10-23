import { CaseSensitive, ChevronRight, ChevronsUpDown, ListCollapse, Ellipsis, Regex, ReplaceAll, WholeWord } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { SearchMatch, SearchOptions } from "../../shared/types";
import { api } from "../lib/rpc";
import { extensionService } from "../lib/extensions";
import { showDialog } from "../lib/dialog";
import { toast } from "../lib/toast";
import { FileIcon } from "./FileIcon";
import { t } from "../lib/i18n";

type Props = {
  workspaceRoot: string | null;
  /** Workspace folders of provided file systems (searched through their provider). */
  providerRoots: string[];
  focusToken: number;
  /** Bumped to open the replace field (Ctrl+Shift+H). */
  replaceToken: number;
  /** Prefill (e.g. the editor selection) when focusing. */
  initialQuery: string;
  onOpenResult: (target: { path: string; line: number; column: number; length: number }) => void;
  /**
   * Replace in the files that are open in editors (as undoable edits that stay unsaved, like VS Code);
   * returns the paths it handled, which are left out of the replacement on disk.
   */
  replaceInOpenDocuments: (
    paths: string[],
    query: string,
    replacement: string,
    options: SearchOptions,
  ) => Promise<{ paths: string[]; files: number; replacements: number }>;
  /** Called after Replace All so the explorer can refresh. */
  onReplaced: () => void;
};

/** One of four messages, by whether each count is one (English singular / plural). */
function countMessage(a: number, b: number, messages: [string, string, string, string], ...args: unknown[]): string {
  return t(messages[(a === 1 ? 0 : 2) + (b === 1 ? 0 : 1)]!, ...args);
}

function Toggle({ active, title, label, onClick }: { active: boolean; title: string; label: ReactNode; onClick: () => void }) {
  return (
    <button type="button" className={`search-toggle${active ? " active" : ""}`} title={title} aria-pressed={active} onClick={onClick}>
      {label}
    </button>
  );
}

export function SearchView({ workspaceRoot, providerRoots, focusToken, replaceToken, initialQuery, onOpenResult, replaceInOpenDocuments, onReplaced }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [showReplace, setShowReplace] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [meta, setMeta] = useState("");
  const [searching, setSearching] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [version, setVersion] = useState(0);
  const [truncated, setTruncated] = useState(false);
  // The inputs the shown results were found with: Replace All only acts on results of the current inputs.
  const searchKey = JSON.stringify([query, caseSensitive, wholeWord, regex, include, exclude]);
  const [resultsKey, setResultsKey] = useState("");
  const generation = useRef(0);
  const resultsCurrent = !searching && resultsKey === searchKey;

  useEffect(() => {
    if (focusToken > 0) {
      if (initialQuery) setQuery(initialQuery);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [focusToken]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (replaceToken > 0) {
      setShowReplace(true);
      requestAnimationFrame(() => replaceRef.current?.focus());
    }
  }, [replaceToken]);

  useEffect(() => {
    const current = ++generation.current;
    if ((!workspaceRoot && !providerRoots.length) || !query) {
      setMatches([]);
      setMeta("");
      setResultsKey("");
      setSearching(false);
      return;
    }
    // The shown results are stale from now on (Replace All waits for this search).
    setSearching(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const options = { caseSensitive, wholeWord, regex, include, exclude, maxResults: 2000 };
          const result = workspaceRoot
            ? await api().request.searchInFiles({ root: workspaceRoot, query, ...options })
            : { matches: [], truncated: false, error: undefined as string | undefined };
          // Provided schemes have no TextSearchProvider here: walk their folders through the provider.
          const provided = providerRoots.length
            ? await extensionService.call("providerSearchFiles", providerRoots, query, options)
            : { matches: [], truncated: false };
          // A newer search started meanwhile: its results win.
          if (current !== generation.current) return;
          setResultsKey(searchKey);
          if (result.error) {
            setMatches([]);
            setMeta(result.error);
            return;
          }
          const all = [...result.matches, ...provided.matches];
          setMatches(all);
          const truncated = result.truncated || provided.truncated;
          setTruncated(truncated);
          const files = new Set(all.map((m) => m.path)).size;
          setMeta(
            all.length
              ? countMessage(
                  truncated ? 2 : all.length,
                  files,
                  ["{0} result in {1} file", "{0} result in {1} files", "{0} results in {1} file", "{0} results in {1} files"],
                  `${all.length}${truncated ? "+" : ""}`,
                  files,
                )
              : t("No results found."),
          );
        } catch {
          if (current !== generation.current) return;
          setMatches([]);
          setMeta(t("Search failed"));
        } finally {
          if (current === generation.current) setSearching(false);
        }
      })();
    }, 250);
    return () => clearTimeout(timer);
  }, [query, caseSensitive, wholeWord, regex, include, exclude, searchKey, workspaceRoot, providerRoots, version]);

  if (!workspaceRoot && !providerRoots.length) return <div className="tree-empty">{t("Open a folder to search")}</div>;

  const groups = new Map<string, SearchMatch[]>();
  for (const m of matches) {
    const list = groups.get(m.path) ?? [];
    list.push(m);
    groups.set(m.path, list);
  }

  /** What a match turns into (regex replacements expand $1, $& …). */
  const replacedText = (hit: string) => {
    if (!regex) return replacement;
    try {
      return hit.replace(new RegExp(query, caseSensitive ? "" : "i"), replacement);
    } catch {
      return replacement;
    }
  };

  const replaceAll = async (only?: string[]) => {
    // Only results found with the current inputs, never those of the previous query.
    if (!query || !matches.length || !resultsCurrent) return;
    const targetMatches = only ? matches.filter((m) => only.includes(m.path)) : matches;
    // Exactly the files listed: a capped search never widens into files nobody saw.
    const paths = [...new Set(targetMatches.map((m) => m.path))];
    const choice = await showDialog({
      title: t("Replace All"),
      message: countMessage(
        targetMatches.length,
        paths.length,
        [
          "Replace {0} occurrence across {1} file with “{2}”?",
          "Replace {0} occurrence across {1} files with “{2}”?",
          "Replace {0} occurrences across {1} file with “{2}”?",
          "Replace {0} occurrences across {1} files with “{2}”?",
        ],
        targetMatches.length,
        paths.length,
        replacement,
      ),
      detail:
        truncated && !only
          ? t("The search stopped after {0} results: only the files listed are changed. Narrow the search to replace the rest.", matches.length)
          : t("Files open in an editor are changed there and can be undone; other files are written now."),
      buttons: [
        { label: t("Replace"), role: "primary", value: "replace" },
        { label: t("Cancel"), role: "default", value: "cancel" },
      ],
    });
    if (choice !== "replace") return;
    const options = { caseSensitive, wholeWord, regex, include, exclude };
    const open = await replaceInOpenDocuments(paths, query, replacement, options);
    const onDisk = paths.filter((path) => !open.paths.includes(path));
    const none = { replacements: 0, files: 0, failed: [] as string[], error: undefined as string | undefined };
    const result =
      workspaceRoot && onDisk.length ? await api().request.replaceInFiles({ root: workspaceRoot, query, replacement, ...options, paths: onDisk }) : none;
    const provided =
      providerRoots.length && onDisk.length ? await extensionService.call("providerReplaceFiles", providerRoots, query, replacement, options, onDisk) : none;
    if (result.error || provided.error) {
      toast(result.error ?? provided.error ?? t("Replace failed"), "error");
      return;
    }
    const replacements = open.replacements + result.replacements + provided.replacements;
    const files = open.files + result.files + provided.files;
    const failed = result.failed ?? [];
    toast(
      countMessage(
        replacements,
        files,
        [
          "Replaced {0} occurrence in {1} file",
          "Replaced {0} occurrence in {1} files",
          "Replaced {0} occurrences in {1} file",
          "Replaced {0} occurrences in {1} files",
        ],
        replacements,
        files,
      ) + (failed.length ? t(". Could not write {0}", failed.map((path) => path.split(/[\\/]/).pop()).join(", ")) : ""),
      failed.length ? "error" : "success",
    );
    onReplaced();
    setVersion((v) => v + 1);
  };

  return (
    <div className="search-panel-root">
      <div className="search-form">
        <div className="search-row">
          <button
            type="button"
            className={`search-expand chevron${showReplace ? " open" : ""}`}
            title={t("Toggle Replace")}
            onClick={() => setShowReplace((v) => !v)}
          >
            <ChevronRight size={14} />
          </button>
          <div className="search-inputs">
            <div className="search-field">
              <input
                ref={inputRef}
                type="text"
                placeholder={t("Search")}
                spellCheck={false}
                autoComplete="off"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setVersion((v) => v + 1);
                }}
              />
              <Toggle active={caseSensitive} title={t("Match Case (Alt+C)")} label={<CaseSensitive size={16} />} onClick={() => setCaseSensitive((v) => !v)} />
              <Toggle active={wholeWord} title={t("Match Whole Word (Alt+W)")} label={<WholeWord size={16} />} onClick={() => setWholeWord((v) => !v)} />
              <Toggle active={regex} title={t("Use Regular Expression (Alt+R)")} label={<Regex size={15} />} onClick={() => setRegex((v) => !v)} />
            </div>
            {showReplace && (
              <div className="search-field">
                <input
                  ref={replaceRef}
                  type="text"
                  placeholder={t("Replace")}
                  spellCheck={false}
                  autoComplete="off"
                  value={replacement}
                  onChange={(e) => setReplacement(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.ctrlKey || e.altKey)) void replaceAll();
                  }}
                />
                <button
                  type="button"
                  className="search-toggle"
                  title={t("Replace All (Ctrl+Alt+Enter)")}
                  disabled={!matches.length || !resultsCurrent}
                  onClick={() => void replaceAll()}
                >
                  <ReplaceAll size={15} />
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="search-details-toggle">
          <button type="button" className="icon-btn" title={t("Toggle Search Details")} onClick={() => setShowDetails((v) => !v)}>
            <Ellipsis size={16} />
          </button>
        </div>
        {showDetails && (
          <div className="search-details">
            <label>
              {t("files to include")}
              <input type="text" spellCheck={false} placeholder={t("e.g. src/**, *.ts")} value={include} onChange={(e) => setInclude(e.target.value)} />
            </label>
            <label>
              {t("files to exclude")}
              <input type="text" spellCheck={false} placeholder={t("e.g. *.test.ts, docs/")} value={exclude} onChange={(e) => setExclude(e.target.value)} />
            </label>
          </div>
        )}
        <div className="search-meta">
          <span>{searching ? t("Searching…") : meta}</span>
          {groups.size > 0 && (
            <button
              type="button"
              className="icon-btn"
              title={collapsed.size ? t("Expand All") : t("Collapse All")}
              onClick={() => setCollapsed(collapsed.size ? new Set() : new Set(groups.keys()))}
            >
              {collapsed.size ? <ChevronsUpDown size={15} /> : <ListCollapse size={15} />}
            </button>
          )}
        </div>
      </div>
      <div
        className="search-results"
        onKeyDown={(e) => {
          if (!(e.altKey && !e.ctrlKey)) return;
          if (e.code === "KeyC") setCaseSensitive((v) => !v);
          else if (e.code === "KeyW") setWholeWord((v) => !v);
          else if (e.code === "KeyR") setRegex((v) => !v);
        }}
      >
        {[...groups].map(([path, list]) => {
          const open = !collapsed.has(path);
          const name = path.split(/[/\\]/).pop() ?? path;
          const rel = list[0]!.relativePath;
          return (
            <div key={path} className="search-group">
              <div
                className="search-group-header"
                onClick={() =>
                  setCollapsed((prev) => {
                    const next = new Set(prev);
                    if (next.has(path)) next.delete(path);
                    else next.add(path);
                    return next;
                  })
                }
              >
                <span className={`chevron${open ? " open" : ""}`}>
                  <ChevronRight size={14} />
                </span>
                <FileIcon name={name} />
                <span className="search-file">{name}</span>
                <span className="search-dir">{rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ""}</span>
                {showReplace && (
                  <button
                    type="button"
                    className="icon-btn search-file-replace"
                    title={t("Replace All in File")}
                    onClick={(e) => {
                      e.stopPropagation();
                      void replaceAll([path]);
                    }}
                  >
                    <ReplaceAll size={15} />
                  </button>
                )}
                <span className="search-count">{list.length}</span>
              </div>
              {open &&
                list.map((m, i) => {
                  const start = Math.max(0, m.column - 30);
                  const before = (start > 0 ? "…" : "") + m.preview.slice(start, m.column).trimStart();
                  const hit = m.preview.slice(m.column, m.column + m.length);
                  const after = m.preview.slice(m.column + m.length);
                  return (
                    <button
                      key={`${m.line}:${m.column}:${i}`}
                      type="button"
                      className="search-hit"
                      title={`${rel}:${m.line + 1}`}
                      onClick={() => onOpenResult({ path, line: m.line, column: m.column, length: m.length })}
                    >
                      <span className="search-preview">
                        {before}
                        {showReplace ? (
                          <>
                            <del>{hit}</del>
                            <ins>{replacedText(hit)}</ins>
                          </>
                        ) : (
                          <mark>{hit}</mark>
                        )}
                        {after}
                      </span>
                    </button>
                  );
                })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
