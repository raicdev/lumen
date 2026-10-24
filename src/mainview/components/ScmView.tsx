import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  CloudDownload,
  CloudUpload,
  Copy,
  ExternalLink,
  GitBranch,
  GitCommitHorizontal,
  Minus,
  Plus,
  RefreshCw,
  RotateCw,
  Tag,
  Undo2,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { GitChangedFile, GitCommitInfo, GitFileStatus, GitRef, GitStatus } from "../../shared/types";
import { ExtensionScm } from "../features/scm-panel";
import { FileIcon } from "./FileIcon";
import { t } from "../lib/i18n";
import { relativeTime } from "../lib/git-blame";

/** Commits the history section loads at a time. */
const HISTORY_PAGE = 50;

type Props = {
  status: GitStatus | null;
  workspaceRoot: string | null;
  busy: boolean;
  /** A fetch, pull or push is running. */
  syncing: boolean;
  onOpen: (file: GitFileStatus) => void;
  onOpenChanges: (file: GitFileStatus, staged: boolean) => void;
  onStage: (files: GitFileStatus[]) => void;
  onUnstage: (files: GitFileStatus[]) => void;
  onDiscard: (files: GitFileStatus[]) => void;
  onCommit: (message: string) => Promise<boolean>;
  onRefresh: () => void;
  onBranch: () => void;
  onFetch: () => void;
  onPull: () => void;
  onPush: () => void;
  onSync: () => void;
  loadLog: (skip: number, limit: number) => Promise<GitCommitInfo[]>;
  loadCommitFiles: (commit: GitCommitInfo) => Promise<GitChangedFile[]>;
  onOpenCommitFile: (commit: GitCommitInfo, file: GitChangedFile) => void;
  onCopyHash: (commit: GitCommitInfo) => void;
};

/** One-letter decoration + color, like VS Code's git decorations. */
export function gitDecoration(code: string): { letter: string; className: string; title: string } | null {
  switch (code) {
    case "M":
      return { letter: "M", className: "git-modified", title: t("Modified") };
    case "A":
      return { letter: "A", className: "git-added", title: t("Index Added") };
    case "D":
      return { letter: "D", className: "git-deleted", title: t("Deleted") };
    case "R":
      return { letter: "R", className: "git-renamed", title: t("Renamed") };
    case "C":
      return { letter: "C", className: "git-renamed", title: t("Copied") };
    case "U":
      return { letter: "!", className: "git-conflict", title: t("Conflict") };
    case "?":
      return { letter: "U", className: "git-untracked", title: t("Untracked") };
    default:
      return null;
  }
}

function basename(path: string) {
  return path.split(/[/\\]/).pop() ?? path;
}

function dirOf(rel: string) {
  const index = rel.lastIndexOf("/");
  return index < 0 ? "" : rel.slice(0, index);
}

function FileRow({
  file,
  code,
  actions,
  onOpen,
}: {
  file: GitFileStatus;
  code: string;
  actions: { label: ReactNode; title: string; run: () => void }[];
  onOpen: () => void;
}) {
  const decoration = gitDecoration(code);
  return (
    <div className="scm-row" onClick={onOpen} title={file.relativePath}>
      <FileIcon name={basename(file.path)} />
      <span className={`scm-name ${decoration?.className ?? ""}${code === "D" ? " deleted" : ""}`}>{basename(file.path)}</span>
      <span className="scm-dir">{dirOf(file.relativePath)}</span>
      <span className="scm-actions">
        {actions.map((action) => (
          <button
            key={action.title}
            type="button"
            className="icon-btn"
            title={action.title}
            onClick={(e) => {
              e.stopPropagation();
              action.run();
            }}
          >
            {action.label}
          </button>
        ))}
      </span>
      {decoration && (
        <span className={`scm-letter ${decoration.className}`} title={decoration.title}>
          {decoration.letter}
        </span>
      )}
    </div>
  );
}

function Section({
  title,
  count,
  actions,
  open,
  onToggle,
  children,
}: {
  title: string;
  count?: number;
  actions: { label: ReactNode; title: string; run: () => void }[];
  /** Controlled open state (the history section loads only while open). */
  open?: boolean;
  onToggle?: (open: boolean) => void;
  children: React.ReactNode;
}) {
  const [ownOpen, setOwnOpen] = useState(true);
  const isOpen = open ?? ownOpen;
  return (
    <div className="scm-section">
      <div
        className="scm-section-header"
        onClick={() => {
          setOwnOpen(!isOpen);
          onToggle?.(!isOpen);
        }}
      >
        <span className={`chevron${isOpen ? " open" : ""}`}>
          <ChevronRight size={14} />
        </span>
        <span className="scm-section-title">{title}</span>
        <span className="scm-actions">
          {actions.map((action) => (
            <button
              key={action.title}
              type="button"
              className="icon-btn"
              title={action.title}
              onClick={(e) => {
                e.stopPropagation();
                action.run();
              }}
            >
              {action.label}
            </button>
          ))}
        </span>
        {count !== undefined && <span className="badge">{count}</span>}
      </div>
      {isOpen && children}
    </div>
  );
}

/**
 * The branches and tags at a commit as small icons (one per kind, with a count),
 * so they never crowd out the message; the names are in their tooltips.
 */
function RefChips({ refs }: { refs: GitCommitInfo["refs"] }) {
  const kinds: { type: GitRef["type"]; icon: ReactNode; label: string }[] = [
    { type: "head", icon: <GitBranch size={12} />, label: t("Branches") },
    { type: "remote", icon: <Cloud size={12} />, label: t("Remote Branches") },
    { type: "tag", icon: <Tag size={12} />, label: t("Tags") },
  ];
  return (
    <>
      {kinds.map(({ type, icon, label }) => {
        const names = refs.filter((ref) => ref.type === type);
        if (!names.length) return null;
        const current = names.some((ref) => ref.current);
        return (
          <span key={type} className={`scm-ref${current ? " current" : ""}`} title={`${label}: ${names.map((ref) => ref.name).join(", ")}`}>
            {icon}
            {names.length > 1 && names.length}
          </span>
        );
      })}
    </>
  );
}

/** A commit of the history section; expanded, the files it changed. */
function CommitRow({ commit, props }: { commit: GitCommitInfo; props: Props }) {
  const [files, setFiles] = useState<GitChangedFile[] | null>(null);
  const [open, setOpen] = useState(false);
  const toggle = () => {
    setOpen(!open);
    if (!open && !files) void props.loadCommitFiles(commit).then(setFiles);
  };
  const title = [
    `${commit.shortHash}  ${commit.author} <${commit.email}>`,
    new Date(commit.date).toLocaleString(),
    commit.refs.map((ref) => ref.name).join(", "),
    "",
    commit.subject,
    commit.body,
  ]
    .filter((line, index) => line || index === 3)
    .join("\n")
    .trim();
  return (
    <>
      <div className="scm-row scm-commit-row" onClick={toggle} title={title}>
        <span className={`chevron${open ? " open" : ""}`}>
          <ChevronRight size={14} />
        </span>
        <GitCommitHorizontal size={14} className="scm-commit-icon" />
        <span className="scm-name scm-commit-subject">{commit.subject}</span>
        <RefChips refs={commit.refs} />
        <span className="scm-dir">
          {commit.author} · {relativeTime(commit.date)}
        </span>
        <span className="scm-actions">
          <button
            type="button"
            className="icon-btn"
            title={t("Copy Commit Hash")}
            onClick={(e) => {
              e.stopPropagation();
              props.onCopyHash(commit);
            }}
          >
            <Copy size={13} />
          </button>
        </span>
      </div>
      {open && !files && <div className="scm-row scm-commit-file muted">{t("Loading…")}</div>}
      {open &&
        files?.map((file) => {
          const decoration = gitDecoration(file.status);
          return (
            <div
              key={`${file.status}:${file.path}`}
              className="scm-row scm-commit-file"
              title={file.oldPath ? `${file.relativePath} ← ${file.oldPath}` : file.relativePath}
              onClick={() => props.onOpenCommitFile(commit, file)}
            >
              <FileIcon name={basename(file.path)} />
              <span className={`scm-name ${decoration?.className ?? ""}${file.status === "D" ? " deleted" : ""}`}>{basename(file.path)}</span>
              <span className="scm-dir">{dirOf(file.relativePath)}</span>
              {decoration && (
                <span className={`scm-letter ${decoration.className}`} title={decoration.title}>
                  {decoration.letter}
                </span>
              )}
            </div>
          );
        })}
    </>
  );
}

/** The commits of the current branch, newest first, a page at a time. */
function History({ props }: { props: Props }) {
  const [open, setOpen] = useState(true);
  const [commits, setCommits] = useState<GitCommitInfo[] | null>(null);
  const [more, setMore] = useState(false);
  const { status, loadLog } = props;

  // Reload when the repository changes (a commit, a pull, a checkout).
  useEffect(() => {
    if (!open || !status?.isRepo) return;
    let cancelled = false;
    void loadLog(0, HISTORY_PAGE).then((page) => {
      if (cancelled) return;
      setCommits(page);
      setMore(page.length === HISTORY_PAGE);
    });
    return () => {
      cancelled = true;
    };
  }, [open, status, loadLog]);

  const loadMore = async () => {
    const page = await loadLog(commits?.length ?? 0, HISTORY_PAGE);
    setCommits((prev) => [...(prev ?? []), ...page]);
    setMore(page.length === HISTORY_PAGE);
  };

  return (
    <Section title={t("Commits")} actions={[{ label: <RotateCw size={14} />, title: t("Refresh"), run: props.onRefresh }]} open={open} onToggle={setOpen}>
      {!commits && <div className="tree-empty">{t("Loading…")}</div>}
      {commits && !commits.length && <div className="tree-empty">{t("No commits yet.")}</div>}
      {commits?.map((commit) => (
        <CommitRow key={commit.hash} commit={commit} props={props} />
      ))}
      {more && (
        <div className="scm-row scm-load-more" onClick={() => void loadMore()}>
          <ChevronDown size={14} />
          {t("Load More Commits")}
        </div>
      )}
    </Section>
  );
}

function GitScm(props: Props) {
  const { status } = props;
  const [message, setMessage] = useState("");

  if (!props.workspaceRoot) return <div className="tree-empty">{t("Open a folder to use source control.")}</div>;
  if (!status) return <div className="tree-empty">{t("Loading…")}</div>;
  if (!status.isRepo) {
    return <div className="tree-empty">{t("The folder currently open doesn't have a git repository.")}</div>;
  }

  const staged = status.files.filter((file) => file.index !== " " && file.index !== "?");
  const changes = status.files.filter((file) => file.worktree !== " " || file.index === "?");

  const commit = async () => {
    if (!message.trim()) return;
    if (await props.onCommit(message)) setMessage("");
  };

  const sync = status.upstream ? "sync" : status.hasRemote && status.branch !== "(detached)" ? "publish" : null;
  const toolbar: { icon: ReactNode; title: string; run: () => void; hidden?: boolean }[] = [
    { icon: <CloudDownload size={15} />, title: t("Fetch"), run: props.onFetch, hidden: !status.hasRemote },
    { icon: <ArrowDownToLine size={15} />, title: t("Pull"), run: props.onPull, hidden: !status.upstream },
    { icon: <ArrowUpFromLine size={15} />, title: t("Push"), run: props.onPush, hidden: !status.hasRemote },
    { icon: <RotateCw size={15} />, title: t("Refresh"), run: props.onRefresh },
  ];

  return (
    <div className="scm-view">
      <div className="scm-toolbar">
        <button type="button" className="scm-branch" title={t("Checkout to...")} onClick={props.onBranch}>
          <GitBranch size={14} />
          <span>{status.branch ?? "HEAD"}</span>
          <ChevronDown size={12} />
        </button>
        <span className="scm-toolbar-spacer" />
        {toolbar
          .filter((action) => !action.hidden)
          .map((action) => (
            <button key={action.title} type="button" className="icon-btn" title={action.title} disabled={props.syncing} onClick={action.run}>
              {action.icon}
            </button>
          ))}
      </div>
      <div className="scm-commit">
        <textarea
          className="scm-message"
          placeholder={t('Message (Ctrl+Enter to commit on "{0}")', status.branch ?? "HEAD")}
          value={message}
          rows={Math.min(8, Math.max(2, message.split("\n").length))}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void commit();
            }
          }}
        />
        <button type="button" className="primary-btn scm-commit-btn" disabled={!message.trim() || props.busy} onClick={() => void commit()}>
          <Check size={15} /> {t("Commit")}
        </button>
        {sync === "publish" && (
          <button type="button" className="secondary-btn scm-sync-btn" disabled={props.syncing} onClick={props.onSync}>
            <CloudUpload size={15} /> {t("Publish Branch")}
          </button>
        )}
        {sync === "sync" && (status.ahead > 0 || status.behind > 0) && (
          <button type="button" className="secondary-btn scm-sync-btn" disabled={props.syncing} onClick={props.onSync}>
            <RefreshCw size={15} className={props.syncing ? "codicon spin" : undefined} /> {t("Sync Changes")} {`${status.behind}↓ ${status.ahead}↑`}
          </button>
        )}
      </div>
      {status.error && <div className="scm-error">{status.error}</div>}
      {!status.files.length && <div className="tree-empty">{t("No changes.")}</div>}
      {staged.length > 0 && (
        <Section
          title={t("Staged Changes")}
          count={staged.length}
          actions={[{ label: <Minus size={15} />, title: t("Unstage All Changes"), run: () => props.onUnstage(staged) }]}
        >
          {staged.map((file) => (
            <FileRow
              key={`staged:${file.path}`}
              file={file}
              code={file.index}
              onOpen={() => props.onOpenChanges(file, true)}
              actions={[
                { label: <ExternalLink size={14} />, title: t("Open File"), run: () => props.onOpen(file) },
                { label: <Minus size={15} />, title: t("Unstage Changes"), run: () => props.onUnstage([file]) },
              ]}
            />
          ))}
        </Section>
      )}
      {changes.length > 0 && (
        <Section
          title={t("Changes")}
          count={changes.length}
          actions={[
            { label: <Undo2 size={15} />, title: t("Discard All Changes"), run: () => props.onDiscard(changes) },
            { label: <Plus size={15} />, title: t("Stage All Changes"), run: () => props.onStage(changes) },
          ]}
        >
          {changes.map((file) => (
            <FileRow
              key={`change:${file.path}`}
              file={file}
              code={file.index === "?" ? "?" : file.worktree}
              onOpen={() => props.onOpenChanges(file, false)}
              actions={[
                { label: <ExternalLink size={14} />, title: t("Open File"), run: () => props.onOpen(file) },
                { label: <Undo2 size={15} />, title: t("Discard Changes"), run: () => props.onDiscard([file]) },
                { label: <Plus size={15} />, title: t("Stage Changes"), run: () => props.onStage([file]) },
              ]}
            />
          ))}
        </Section>
      )}
      <History props={props} />
    </div>
  );
}

/** The built-in git UI, then the source controls extensions registered (scm.createSourceControl). */
export function ScmView(props: Props) {
  return (
    <div className="scm-root">
      <GitScm {...props} />
      <ExtensionScm />
    </div>
  );
}
