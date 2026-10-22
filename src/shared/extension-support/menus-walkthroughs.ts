import type { AreaSupport } from "./types.ts";

/** Support table changes of the "menus-walkthroughs" area. */
export const menusWalkthroughsSupport: AreaSupport = {
  api: {
    "workspace.registerResourceLabelFormatter": ["supported", "proposed API; labels shown in the editor title strip"],
  },
  contributions: {
    submenus: ["supported", "nested fly-outs in every contributed menu (context menus and the \"…\" of action bars)"],
    menus: ["supported", "touchBar (macOS hardware) and searchPanel/aiResults/commands (AI search results) are not implemented and not works."],
    walkthroughs: ["supported", "Welcome page list (icons, featuredFor glob matches against workspace files first, progress, Hide action persisted in workbench.welcomePage.hiddenCategories) and walkthrough editor tabs; image (light/dark/hc/hcLight), themed inline SVG and Markdown media with relative images and command links; step descriptions with markdown/command links, lone links as buttons, command:toSide: runs in a split beside; every completionEvent (onCommand, onLink, onView for built-in, contributed and feature views, onSettingChanged, onContext, extensionInstalled/onExtensionInstalled, onStepSelected; buttons/selection are the default), legacy doneOn; walkthrough/step when re-evaluated live; progress persisted and reset/mark commands; openOnInstall; hidden walkthroughs stay reachable from workbench.action.openWalkthrough and welcome.showAllWalkthroughs"],
    resourceLabelFormatters: ["partial", "contributed and registered formatters label non-file resources in the editor title strip, tab titles and breadcrumbs; ${scheme}, ${query}, ${fragment} and workspace suffixes are not filled in"],
    typescriptServerPlugins: ["partial", "plug-ins load into Lumen's in-process TypeScript language service (create/init, config); no tsserver ProjectService, getExternalFiles or configurePlugin from extensions"],
  },
};
