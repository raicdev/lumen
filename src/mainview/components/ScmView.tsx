import { Check, ChevronRight, ExternalLink, Minus, Plus, Undo2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { GitFileStatus, GitStatus } from "../../shared/types";
import { ExtensionScm } from "../features/scm-panel";
import { FileIcon } from "./FileIcon";

type Props = {
  status: GitStatus | null;
  workspaceRoot: string | null;
  busy: boolean;
  onOpen: (file: GitFileStatus) => void;
  onOpenChanges: (file: GitFileStatus) => void;
  onStage: (files: GitFileStatus[]) => void;
  onUnstage: (files: GitFileStatus[]) => void;
  onDiscard: (files: GitFileStatus[]) => void;
  onCommit: (message: string) => Promise<boolean>;
  onRefresh: () => void;
};

/** One-letter decoration + color, like VS Code's git decorations. */
export function gitDecoration(code: string): { letter: string; className: string; title: string } | null {
  switch (code) {
    case "M":
      return { letter: "M", className: "git-modified", title: "Modified" };
    case "A":
      return { letter: "A", className: "git-added", title: "Index Added" };
    case "D":
      return { letter: "D", className: "git-deleted", title: "Deleted" };
    case "R":
      return { letter: "R", className: "git-renamed", title: "Renamed" };
    case "C":
      return { letter: "C", className: "git-renamed", title: "Copied" };
    case "U":
      return { letter: "!", className: "git-conflict", title: "Conflict" };
    case "?":
      return { letter: "U", className: "git-untracked", title: "Untracked" };
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
  children,
}: {
  title: string;
  count: number;
  actions: { label: ReactNode; title: string; run: () => void }[];
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="scm-section">
      <div className="scm-section-header" onClick={() => setOpen((v) => !v)}>
        <span className={`chevron${open ? " open" : ""}`}><ChevronRight size={14} /></span>
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
        <span className="badge">{count}</span>
      </div>
      {open && children}
    </div>
  );
}

function GitScm(props: Props) {
  const { status } = props;
  const [message, setMessage] = useState("");

  if (!props.workspaceRoot) return <div className="tree-empty">Open a folder to use source control.</div>;
  if (!status) return <div className="tree-empty">Loading…</div>;
  if (!status.isRepo) {
    return <div className="tree-empty">The folder currently open doesn't have a git repository.</div>;
  }

  const staged = status.files.filter((file) => file.index !== " " && file.index !== "?");
  const changes = status.files.filter((file) => file.worktree !== " " || file.index === "?");

  const commit = async () => {
    if (!message.trim()) return;
    if (await props.onCommit(message)) setMessage("");
  };

  return (
    <div className="scm-view">
      <div className="scm-commit">
        <textarea
          className="scm-message"
          placeholder={`Message (Ctrl+Enter to commit on "${status.branch ?? "HEAD"}")`}
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
          <Check size={15} /> Commit
        </button>
      </div>
      {status.error && <div className="scm-error">{status.error}</div>}
      {!status.files.length && <div className="tree-empty">No changes.</div>}
      {staged.length > 0 && (
        <Section
          title="Staged Changes"
          count={staged.length}
          actions={[{ label: <Minus size={15} />, title: "Unstage All Changes", run: () => props.onUnstage(staged) }]}
        >
          {staged.map((file) => (
            <FileRow
              key={`staged:${file.path}`}
              file={file}
              code={file.index}
              onOpen={() => props.onOpenChanges(file)}
              actions={[
                { label: <ExternalLink size={14} />, title: "Open File", run: () => props.onOpen(file) },
                { label: <Minus size={15} />, title: "Unstage Changes", run: () => props.onUnstage([file]) },
              ]}
            />
          ))}
        </Section>
      )}
      {changes.length > 0 && (
        <Section
          title="Changes"
          count={changes.length}
          actions={[
            { label: <Undo2 size={15} />, title: "Discard All Changes", run: () => props.onDiscard(changes) },
            { label: <Plus size={15} />, title: "Stage All Changes", run: () => props.onStage(changes) },
          ]}
        >
          {changes.map((file) => (
            <FileRow
              key={`change:${file.path}`}
              file={file}
              code={file.index === "?" ? "?" : file.worktree}
              onOpen={() => props.onOpenChanges(file)}
              actions={[
                { label: <ExternalLink size={14} />, title: "Open File", run: () => props.onOpen(file) },
                { label: <Undo2 size={15} />, title: "Discard Changes", run: () => props.onDiscard([file]) },
                { label: <Plus size={15} />, title: "Stage Changes", run: () => props.onStage([file]) },
              ]}
            />
          ))}
        </Section>
      )}
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
