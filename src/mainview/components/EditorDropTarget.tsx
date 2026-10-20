import { useState } from "react";
import type { DropSide } from "../lib/editor-grid";

/** An editor tab being dragged: `{ path, groupId }` as JSON. */
export const TAB_DRAG_TYPE = "application/x-lumen-tab";
/** A file dragged from the explorer (its absolute path). */
export const FILE_DRAG_TYPE = "application/x-lumen-file";

export type EditorDropZone = DropSide | "center";

type Props = {
  /** Drag payload types this target accepts. */
  accepts: string[];
  onDrop: (zone: EditorDropZone, data: DataTransfer, copy: boolean) => void;
};

/** Which part of the group the pointer is over: the outer quarter splits, the middle moves in. */
function zoneAt(e: React.DragEvent, element: HTMLElement): EditorDropZone {
  const rect = element.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top) / rect.height;
  const edges: [EditorDropZone, number][] = [
    ["left", x],
    ["right", 1 - x],
    ["top", y],
    ["bottom", 1 - y],
  ];
  const [side, distance] = edges.sort((a, b) => a[1] - b[1])[0]!;
  return distance < 0.25 ? side : "center";
}

const LABEL: Record<EditorDropZone, string> = {
  center: "Open Here",
  left: "Split Left",
  right: "Split Right",
  top: "Split Up",
  bottom: "Split Down",
};

/**
 * Drop target over an editor group while a tab, file or terminal is dragged:
 * the highlighted half shows where it will dock (VS Code style).
 */
export function EditorDropTarget({ accepts, onDrop }: Props) {
  const [zone, setZone] = useState<EditorDropZone | null>(null);
  const accepted = (e: React.DragEvent) => accepts.some((type) => e.dataTransfer.types.includes(type));

  return (
    <div
      className="editor-drop-target"
      onDragOver={(e) => {
        if (!accepted(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = e.ctrlKey ? "copy" : "move";
        const next = zoneAt(e, e.currentTarget);
        if (next !== zone) setZone(next);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setZone(null);
      }}
      onDrop={(e) => {
        if (!accepted(e)) return;
        e.preventDefault();
        const target = zoneAt(e, e.currentTarget);
        setZone(null);
        onDrop(target, e.dataTransfer, e.ctrlKey);
      }}
    >
      {zone && (
        <div className={`editor-drop-highlight zone-${zone}`}>
          <span className="dock-label">{LABEL[zone]}</span>
        </div>
      )}
    </div>
  );
}
