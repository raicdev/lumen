import { SquareTerminal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FileIcon } from "./FileIcon";
import { showContextMenu } from "../lib/context-menu";
import { FILE_DRAG_TYPE, TAB_DRAG_TYPE } from "./EditorDropTarget";

export type TabInfo = {
  path: string;
  name: string;
  dirty: boolean;
  /** Preview tabs (italic) are replaced by the next file opened in preview. */
  preview: boolean;
  /** Disambiguating folder when two tabs share a name. */
  hint?: string;
};

export type TabAction =
  | "close"
  | "close-others"
  | "close-right"
  | "close-saved"
  | "close-all"
  | "copy-path"
  | "copy-relative-path"
  | "reveal-in-sidebar"
  | "reveal"
  | "keep-open"
  | "reopen-with"
  | "terminal-rename"
  | "terminal-move-to-panel"
  | "split-right"
  | "split-down";

type Props = {
  tabs: TabInfo[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onPin: (path: string) => void;
  onAction: (action: TabAction, path: string) => void;
  onReorder: (from: number, to: number) => void;
  onNewUntitled: () => void;
  /** Editor group this tab bar belongs to (part of the drag payload). */
  groupId: string;
  /** A tab from another group, a file or a terminal dropped on the bar. */
  onExternalDrop: (data: DataTransfer, copy: boolean) => void;
};

export function TabBar({ tabs, activePath, onSelect, onClose, onPin, onAction, onReorder, onNewUntitled, groupId, onExternalDrop }: Props) {
  const [externalOver, setExternalOver] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  // Keep the active tab visible.
  useEffect(() => {
    barRef.current?.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activePath, tabs.length]);

  return (
    <div
      className={`tabs${externalOver ? " external-drop" : ""}`}
      role="tablist"
      ref={barRef}
      onDragOver={(e) => {
        if (dragIndex !== null) return;
        const types = e.dataTransfer.types;
        if (!types.includes(TAB_DRAG_TYPE) && !types.includes(FILE_DRAG_TYPE) && !types.includes("application/x-lumen-terminal")) return;
        e.preventDefault();
        setExternalOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setExternalOver(false);
      }}
      onDrop={(e) => {
        setExternalOver(false);
        if (dragIndex !== null) return;
        e.preventDefault();
        onExternalDrop(e.dataTransfer, e.ctrlKey);
      }}
      onWheel={(e) => {
        if (barRef.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) barRef.current.scrollLeft += e.deltaY;
      }}
      onDoubleClick={(e) => {
        // Double-click on the empty area: new untitled file (like VS Code).
        if (e.target === e.currentTarget) onNewUntitled();
      }}
    >
      {tabs.map((tab, index) => (
        <div
          key={tab.path}
          className={`tab${tab.path === activePath ? " active" : ""}${tab.preview ? " preview" : ""}${tab.dirty ? " dirty" : ""}${dropIndex === index && dragIndex !== null && dragIndex !== index ? " drop-target" : ""}`}
          role="tab"
          aria-selected={tab.path === activePath}
          title={tab.path}
          data-tab-path={tab.path}
          data-group={groupId}
          data-index={index}
          draggable
          onDragStart={(e) => {
            setDragIndex(index);
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", tab.path);
            e.dataTransfer.setData(TAB_DRAG_TYPE, JSON.stringify({ path: tab.path, groupId }));
            // Terminal tabs can be dropped back onto the panel.
            if (tab.path.startsWith("terminal:")) e.dataTransfer.setData("application/x-lumen-editor-terminal", tab.path.slice(9));
          }}
          onDragOver={(e) => {
            if (dragIndex === null) return;
            e.preventDefault();
            setDropIndex(index);
          }}
          onDragEnd={() => {
            setDragIndex(null);
            setDropIndex(null);
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (dragIndex !== null && dragIndex !== index) onReorder(dragIndex, index);
            setDragIndex(null);
            setDropIndex(null);
          }}
          onMouseDown={(e) => {
            if (e.button === 0) onSelect(tab.path);
          }}
          onDoubleClick={() => onPin(tab.path)}
          onAuxClick={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              onClose(tab.path);
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            if (tab.path.startsWith("terminal:")) {
              void showContextMenu(e.clientX, e.clientY, [
                { type: "item", label: "Move Terminal into Panel", action: "terminal-move-to-panel" },
              { type: "item", label: "Split Right", action: "split-right" },
              { type: "item", label: "Split Down", action: "split-down" },
                { type: "item", label: "Rename…", action: "terminal-rename" },
                { type: "separator" },
                { type: "item", label: "Close (Kill Terminal)", action: "close" },
                { type: "item", label: "Close Others", action: "close-others", disabled: tabs.length < 2 },
              ]).then((action) => {
                if (action) onAction(action as TabAction, tab.path);
              });
              return;
            }
            const untitled = tab.path.startsWith("untitled:");
            void showContextMenu(e.clientX, e.clientY, [
              { type: "item", label: "Close", action: "close" },
              { type: "item", label: "Close Others", action: "close-others", disabled: tabs.length < 2 },
              { type: "item", label: "Close to the Right", action: "close-right", disabled: index === tabs.length - 1 },
              { type: "item", label: "Close Saved", action: "close-saved" },
              { type: "item", label: "Close All", action: "close-all" },
              { type: "separator" },
              { type: "item", label: "Reopen Editor With…", action: "reopen-with" },
              { type: "separator" },
              { type: "item", label: "Split Right", action: "split-right" },
              { type: "item", label: "Split Down", action: "split-down" },
              { type: "separator" },
              { type: "item", label: "Copy Path", action: "copy-path", disabled: untitled },
              { type: "item", label: "Copy Relative Path", action: "copy-relative-path", disabled: untitled },
              { type: "separator" },
              { type: "item", label: "Reveal in Explorer View", action: "reveal-in-sidebar", disabled: untitled },
              { type: "item", label: "Reveal in File Explorer", action: "reveal", disabled: untitled },
              ...(tab.preview ? [{ type: "separator" as const }, { type: "item" as const, label: "Keep Open", action: "keep-open" }] : []),
            ]).then((action) => {
              if (action) onAction(action as TabAction, tab.path);
            });
          }}
        >
          {tab.path.startsWith("terminal:") ? <SquareTerminal className="terminal-glyph" size={14} /> : <FileIcon name={tab.name} />}
          <span className="tab-name">{tab.name}</span>
          {tab.hint && <span className="tab-hint">{tab.hint}</span>}
          <button
            className="tab-close"
            type="button"
            title={tab.dirty ? "Unsaved changes — close" : "Close (Ctrl+W)"}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onClose(tab.path);
            }}
          >
            <X className="tab-close-x" size={14} />
            <span className="tab-dirty-dot">●</span>
          </button>
        </div>
      ))}
    </div>
  );
}
