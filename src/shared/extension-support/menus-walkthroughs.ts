import type { AreaSupport } from "./types.ts";

/** Support table changes of the "menus-walkthroughs" area. */
export const menusWalkthroughsSupport: AreaSupport = {
  api: {
    "workspace.registerResourceLabelFormatter": ["supported", "proposed API; labels shown in the editor title strip"],
  },
  contributions: {
    submenus: ["supported", 'nested fly-outs in every contributed menu (context menus and the "…" of action bars)'],
    menus: ["supported", "touchBar (macOS hardware) and searchPanel/aiResults/commands (AI search results) are not implemented and not works."],
    walkthroughs: [
      "supported",
      "Welcome page list (featuredFor, progress, Hide) and walkthrough tabs; image, SVG and Markdown media; command links incl. toSide; all completionEvents and doneOn; live when; openOnInstall",
    ],
    resourceLabelFormatters: [
      "partial",
      "contributed and registered formatters label non-file resources in the editor title strip, tab titles and breadcrumbs; ${scheme}, ${query}, ${fragment} and workspace suffixes are not filled in",
    ],
    typescriptServerPlugins: [
      "partial",
      "plug-ins load into Lumen's in-process TypeScript language service (create/init, config); no tsserver ProjectService, getExternalFiles or configurePlugin from extensions",
    ],
  },
};
