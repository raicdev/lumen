import { useState } from "react";
import { PANEL_DRAG_TYPE, type PanelPosition } from "./Panel";
import { TERMINAL_DRAG_TYPE } from "./TerminalView";

/** A terminal editor tab being dragged (back into the panel). */
export const EDITOR_TERMINAL_DRAG_TYPE = "application/x-lumen-editor-terminal";

export type DockZone = PanelPosition | "editor" | "panel";

type Props = {
  kind: "panel" | "terminal" | "editor-terminal";
  panelPosition: PanelPosition;
  onDrop: (zone: DockZone, data: DataTransfer) => void;
};

const LABELS: Record<DockZone, string> = {
  left: "Dock Panel Left",
  right: "Dock Panel Right",
  bottom: "Dock Panel at Bottom",
  editor: "Move Terminal into Editor Area",
  panel: "Move Terminal into Panel",
};

/**
 * Drop targets over the editor area while the panel (or a terminal) is being
 * dragged: the edges dock the panel there, the center moves a terminal into
 * the editor area.
 */
export function DockOverlay({ kind, panelPosition, onDrop }: Props) {
  const [hover, setHover] = useState<DockZone | null>(null);
  const zones: DockZone[] =
    kind === "panel"
      ? (["left", "right", "bottom"] as DockZone[]).filter((zone) => zone !== panelPosition)
      : kind === "terminal"
        ? ["editor"]
        : ["panel", "left", "right", "bottom"];

  const accepts = (e: React.DragEvent) =>
    [PANEL_DRAG_TYPE, TERMINAL_DRAG_TYPE, EDITOR_TERMINAL_DRAG_TYPE].some((type) => e.dataTransfer.types.includes(type));

  return (
    <div className={`dock-overlay dock-${kind}`}>
      {zones.map((zone) => (
        <div
          key={zone}
          className={`dock-zone dock-zone-${zone}${hover === zone ? " hover" : ""}`}
          onDragOver={(e) => {
            if (!accepts(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (hover !== zone) setHover(zone);
          }}
          onDragLeave={() => setHover((current) => (current === zone ? null : current))}
          onDrop={(e) => {
            e.preventDefault();
            onDrop(zone, e.dataTransfer);
          }}
        >
          <span className="dock-label">{LABELS[zone]}</span>
        </div>
      ))}
    </div>
  );
}
