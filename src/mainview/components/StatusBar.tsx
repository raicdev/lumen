import { ArrowLeftRight, Braces, CircleX, GitBranch, LoaderCircle, TriangleAlert } from "lucide-react";
import type { CursorInfo } from "../lib/editor";
import type { HostStatusBarItem } from "../../shared/extensions";
import { WithCodicons } from "./Codicon";
import { FeatureStatusItems } from "../features/components";
import { showContextMenu } from "../lib/context-menu";
import { useExtensions } from "../lib/extensions";
import { contributedMenuItems } from "../features/menus-walkthroughs/menus";
import { t } from "../lib/i18n";

/**
 * The remote indicator (VS Code's "><" button at the far left): shown while
 * extensions contribute to statusBar/remoteIndicator; it opens their entries.
 */
function RemoteIndicator() {
  useExtensions(); // contributions and context keys can change
  const items = contributedMenuItems("statusBar/remoteIndicator", () => undefined, []);
  if (!items.length) return null;
  return (
    <button
      type="button"
      className="status-btn status-remote"
      title={t("Open a Remote Window")}
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        void showContextMenu(
          rect.left,
          rect.top,
          contributedMenuItems("statusBar/remoteIndicator", () => undefined, []),
        );
      }}
    >
      <ArrowLeftRight size={13} />
    </button>
  );
}

export type StatusInfo = {
  branch: string | null;
  ahead: number;
  behind: number;
  changes: number;
  errors: number;
  warnings: number;
  cursor: CursorInfo | null;
  /** "Spaces: 2" / "Tab Size: 4" */
  indentation: string | null;
  eol: "LF" | "CRLF" | null;
  /** The short encoding name ("UTF-8", "Shift JIS"); null for documents without one. */
  encoding: string | null;
  language: string | null;
  lsp: { text: string; active: boolean } | null;
  message: string | null;
  autoSave: boolean;
};

type Props = StatusInfo & {
  onBranch: () => void;
  onProblems: () => void;
  onGotoLine: () => void;
  onIndentation: () => void;
  onEol: () => void;
  onEncoding: () => void;
  onLanguage: () => void;
  onToggleTerminal: () => void;
  terminalActive: boolean;
  /** Items contributed by extensions (window.createStatusBarItem). */
  extensionItems: HostStatusBarItem[];
  /** Running window.withProgress tasks. */
  progress: { id: number; title?: string; message?: string; percent?: number }[];
  onExtensionItem: (item: HostStatusBarItem) => void;
};

function ExtensionItems({ items, side, onClick }: { items: HostStatusBarItem[]; side: "left" | "right"; onClick: (item: HostStatusBarItem) => void }) {
  return (
    <>
      {items
        .filter((item) => item.visible && item.alignment === side && item.text)
        .sort((a, b) => b.priority - a.priority)
        .map((item) => {
          const style = { color: item.color, background: item.backgroundColor };
          // A MarkdownString tooltip is the Markdown hover of lib/tooltip.ts.
          const tooltip = typeof item.tooltip === "string" ? { title: item.tooltip } : { "data-tooltip-markdown": item.tooltip?.markdown };
          return item.command ? (
            <button key={item.id} type="button" className="status-btn status-ext" {...tooltip} style={style} onClick={() => onClick(item)}>
              <WithCodicons text={item.text} />
            </button>
          ) : (
            <span key={item.id} className="status-item status-ext" {...tooltip} style={style}>
              <WithCodicons text={item.text} />
            </span>
          );
        })}
    </>
  );
}

export function StatusBar(props: Props) {
  const { cursor } = props;
  return (
    <footer className="status-bar">
      <div className="status-left">
        <RemoteIndicator />
        {props.branch && (
          <button type="button" className="status-btn" title={t("Source Control (Ctrl+Shift+G)")} onClick={props.onBranch}>
            <GitBranch size={13} />
            {props.branch}
            {props.changes > 0 ? "*" : ""}
            {props.ahead > 0 && ` ↑${props.ahead}`}
            {props.behind > 0 && ` ↓${props.behind}`}
          </button>
        )}
        <button type="button" className="status-btn" title={t("Problems (Ctrl+Shift+M)")} onClick={props.onProblems}>
          <CircleX size={13} />
          {props.errors}
          <TriangleAlert size={13} />
          {props.warnings}
        </button>
        <ExtensionItems items={props.extensionItems} side="left" onClick={props.onExtensionItem} />
        <FeatureStatusItems side="left" />
        {props.progress.map((task) => (
          <span key={task.id} className="status-item status-progress" title={[task.title, task.message].filter(Boolean).join(": ")}>
            <LoaderCircle size={12} className="codicon spin" />
            {[task.title, task.message].filter(Boolean).join(": ")}
            {task.percent !== undefined && ` ${Math.round(task.percent)}%`}
          </span>
        ))}
        {props.message && <span className="status-item status-message">{props.message}</span>}
      </div>
      <div className="status-right">
        <ExtensionItems items={props.extensionItems} side="right" onClick={props.onExtensionItem} />
        <FeatureStatusItems side="right" />
        {cursor && (
          <button type="button" className="status-btn" title={t("Go to Line/Column (Ctrl+G)")} onClick={props.onGotoLine}>
            {t("Ln {0}, Col {1}", cursor.line, cursor.column)}
            {cursor.selectedChars > 0 && ` ${t("({0} selected)", cursor.selectedChars)}`}
            {cursor.selections > 1 && ` · ${t("{0} selections", cursor.selections)}`}
          </button>
        )}
        {props.indentation && (
          <button type="button" className="status-btn" title={t("Select Indentation")} onClick={props.onIndentation}>
            {props.indentation}
          </button>
        )}
        {props.encoding && (
          <button type="button" className="status-btn" title={t("Select Encoding")} onClick={props.onEncoding}>
            {props.encoding}
          </button>
        )}
        {props.eol && (
          <button type="button" className="status-btn" title={t("Select End of Line Sequence")} onClick={props.onEol}>
            {props.eol}
          </button>
        )}
        {props.language && (
          <button type="button" className="status-btn" title={t("Select Language Mode (Ctrl+K M)")} onClick={props.onLanguage}>
            {props.language}
          </button>
        )}
        {props.lsp?.active && (
          <span className="status-item status-lsp" title={t("{0} language features are active", props.lsp.text)}>
            <Braces size={13} />
          </span>
        )}
        {props.autoSave && (
          <span className="status-item muted" title={t("Auto Save is on")}>
            {t("Auto Save")}
          </span>
        )}
        <button
          type="button"
          className={`status-btn${props.terminalActive ? " active" : ""}`}
          title={t("Toggle Terminal (Ctrl+`)")}
          onClick={props.onToggleTerminal}
        >
          {t("Terminal")}
        </button>
      </div>
    </footer>
  );
}
