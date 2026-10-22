/**
 * Geometry and style helpers for extension decoration gutter icons and the
 * overview ruler (window.createTextEditorDecorationType). Pure: no DOM or
 * CodeMirror, so the editor module and the tests share them.
 */

/** A decoration type's gutter icon, already loaded as data URLs by the host. */
export type GutterIcon = { light?: string; dark?: string };

/**
 * The inclusivity of a decoration's edges from DecorationRangeBehavior
 * (OpenOpen 0, ClosedClosed 1, OpenClosed 2, ClosedOpen 3). An open edge takes
 * the text typed at it into the decoration; CodeMirror's marks grow when
 * `inclusiveStart` / `inclusiveEnd` are set.
 */
export function rangeInclusive(behavior: number | undefined): { inclusiveStart: boolean; inclusiveEnd: boolean } {
  switch (behavior) {
    case 1:
      return { inclusiveStart: false, inclusiveEnd: false };
    case 2:
      return { inclusiveStart: true, inclusiveEnd: false };
    case 3:
      return { inclusiveStart: false, inclusiveEnd: true };
    default:
      return { inclusiveStart: true, inclusiveEnd: true };
  }
}

/**
 * The side that makes a before / after widget follow its edge: a widget maps
 * as the position it sits on, and a negative side stays before text inserted
 * there (an open edge), a positive one after it (a closed edge).
 */
export function attachmentSide(edge: "before" | "after", behavior: number | undefined): number {
  const { inclusiveStart, inclusiveEnd } = rangeInclusive(behavior);
  return edge === "before" ? (inclusiveStart ? -1 : 1) : inclusiveEnd ? 1 : -1;
}

/** The image of a gutter icon for a theme (VS Code falls back to the other variant). */
export function gutterIconUrl(icon: GutterIcon | undefined, dark: boolean): string | undefined {
  if (!icon) return undefined;
  return dark ? (icon.dark ?? icon.light) : (icon.light ?? icon.dark);
}

/** CSS for the gutter image, from DecorationRenderOptions.gutterIconSize ("auto", "contain", "cover", "16px", "80%"). */
export function gutterIconStyle(size: string | undefined): { width: string; height: string; backgroundSize: "contain" | "cover" } {
  const value = size?.trim();
  const px = (length: string) => (/^[\d.]+$/.test(length) ? `${length}px` : length);
  if (!value || value === "auto" || value === "contain") return { width: "16px", height: "16px", backgroundSize: "contain" };
  if (value === "cover") return { width: "16px", height: "16px", backgroundSize: "cover" };
  // A CSS length: VS Code gives the icon this width and height.
  return { width: px(value), height: px(value), backgroundSize: "contain" };
}

/**
 * CSS rules for one gutter icon: the dark variant by default, the light one
 * under a light theme (the theme classes are on the document root). The icon
 * is a background image so the theme switch needs no rebuild.
 */
export function gutterIconRules(className: string, icon: GutterIcon): string {
  const dark = gutterIconUrl(icon, true);
  const light = gutterIconUrl(icon, false);
  let rules = "";
  if (dark) rules += `.${className}{background-image:url("${dark}")}`;
  if (light && light !== dark) rules += `:root.vscode-light .${className},:root.vscode-high-contrast-light .${className}{background-image:url("${light}")}`;
  return rules;
}

/**
 * Where an overview ruler mark sits horizontally. OverviewRulerLane is a
 * bitmap (Left 1, Center 2, Right 4, Full 7); marks are thin lines, Center is
 * the default like VS Code.
 */
export function overviewLaneStyle(lane: number | undefined): { left?: string; right?: string; width: string } {
  const value = typeof lane === "number" ? lane : 2;
  if ((value & 7) === 7) return { left: "0", width: "100%" };
  if (value & 2) return { left: "calc(50% - 1.5px)", width: "3px" };
  if (value & 4) return { right: "0", width: "3px" };
  return { left: "0", width: "3px" };
}

/** Top and height of a mark in a ruler of `rulerHeight` px for a document of `docHeight` px. */
export function overviewMarkRect(top: number, bottom: number, rulerHeight: number, docHeight: number): { top: number; height: number } {
  const height = Math.max(1, rulerHeight);
  const scale = height / Math.max(1, docHeight);
  const start = Math.max(0, Math.min(height - 2, top * scale));
  const end = Math.max(start + 2, Math.min(height, bottom * scale));
  return { top: start, height: Math.min(height - start, end - start) };
}
