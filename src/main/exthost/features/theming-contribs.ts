import type { HostFeature } from "./contract.ts";

/**
 * Host side of the "theming-contribs" area. contributes.colors and
 * contributes.semanticToken* are applied entirely by the window (CSS variables
 * and token classes, see mainview/features/theming-contribs.tsx): extensions
 * reference contributed colors through `ThemeColor` ids, which the host already
 * turns into `var(--vscode-<id>)` for decorations, status bar items and tree
 * icons, so nothing is needed here.
 */
export const themingContribsFeature: HostFeature = {
  area: "theming-contribs",
};
