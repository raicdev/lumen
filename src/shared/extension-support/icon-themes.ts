import type { AreaSupport } from "./types.ts";

/** Support table changes of the "icon-themes" area. */
export const iconThemesSupport: AreaSupport = {
  contributions: {
    iconThemes: [
      "supported",
      "file icon themes (images and font icons; file/folder names, extensions, languages; light/high contrast); pick one with Preferences: File Icon Theme or workbench.iconTheme",
    ],
    icons: [
      "supported",
      "font glyphs (fontPath / fontCharacter) and aliases of other icons, usable as $(id) and ThemeIcon; product icon themes can override them",
    ],
    productIconThemes: [
      "partial",
      "selectable via Preferences: Product Icon Theme; replaces the icons Lumen draws with $(codicon) names only, built-in lucide icons are not themed",
    ],
  },
};
