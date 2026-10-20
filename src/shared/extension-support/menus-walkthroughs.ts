import type { AreaSupport } from "./types.ts";

/** Support table changes of the "menus-walkthroughs" area. */
export const menusWalkthroughsSupport: AreaSupport = {
  api: {
    "workspace.registerResourceLabelFormatter": ["supported", "proposed API; labels shown in the editor title strip"],
  },
  contributions: {
    submenus: ["supported", "nested fly-outs in every contributed menu (context menus and the \"…\" of action bars)"],
    menus: ["supported", "touchBar (macOS hardware) and searchPanel/aiResults/commands (AI search results) are not implemented and not works."],
    walkthroughs: ["partial", "Welcome page and editor tab with steps, markdown/image/svg media, command links, completion events and onWalkthrough activation; onCommand is seen for host-run commands and step links only (not built-in window commands), onView only for tree views, featuredFor does not reorder the list"],
    resourceLabelFormatters: ["partial", "contributed and registered formatters label non-file resources in the editor title strip; tab titles and breadcrumbs still show the raw name"],
    typescriptServerPlugins: ["partial", "plug-ins load into Lumen's in-process TypeScript language service (create/init, config); no tsserver ProjectService, getExternalFiles or configurePlugin from extensions"],
  },
};
